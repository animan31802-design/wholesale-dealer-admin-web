import {
  collection, addDoc, getDocs, orderBy, query, where,
  doc, updateDoc, runTransaction, getDoc
} from "firebase/firestore";
import { db } from "../firebase/config";
import { LedgerEntry } from "../types/ledger";
import { Customer, Order, DevReconciliationEntry } from "../types";

// ── Overdue customer result ───────────────────────────────────────
export interface OverdueCustomer {
  customer: Customer;
  dueAmount: number;
  daysOverdue: number;
  oldestUnpaidDate: string; // ISO string of when the unpaid balance started
}

// ── Find the date the balance first went above 0 and never came back ─
// Walk entries oldest→newest, track running balance.
// The "overdue start date" is the createdAt of the first debit entry
// after which the balance never returned to 0.
export function getOverdueStartDate(entries: LedgerEntry[]): string | null {
  if (entries.length === 0) return null;

  // entries are already sorted asc by createdAt (getLedger uses orderBy asc)
  let balance = 0;
  let candidateDate: string | null = null;

  for (const entry of entries) {
    if (entry.direction === "debit") {
      balance += entry.amount;
      // Mark this debit as a candidate if balance just went above 0
      if (balance > 0 && candidateDate === null) {
        candidateDate = entry.createdAt;
      }
    } else {
      balance = Math.max(0, balance - entry.amount);
      // If balance is fully cleared, reset the candidate
      if (balance <= 0) {
        candidateDate = null;
      }
    }
  }

  // If balance is still above 0 at end, candidateDate is the overdue start
  return balance > 0 ? candidateDate : null;
}

// ── Fetch all overdue customers (due > 0 AND oldest unpaid > 30 days) ─
export async function getOverdueCustomers(
  customers: Customer[],
  thresholdDays = 30
): Promise<OverdueCustomer[]> {
  const now = Date.now();
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

  // Only check customers that actually have a due
  const withDue = customers.filter((c) => (c.outstandingDue || 0) > 0);

  const results: OverdueCustomer[] = [];

  await Promise.all(
    withDue.map(async (customer) => {
      try {
        const entries = await getLedger(customer.id!);
        const overdueStart = getOverdueStartDate(entries);
        if (!overdueStart) return;

        const ageMs = now - new Date(overdueStart).getTime();
        if (ageMs < thresholdMs) return;

        const daysOverdue = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        const dueAmount = calcBalance(entries);

        results.push({
          customer,
          dueAmount,
          daysOverdue,
          oldestUnpaidDate: overdueStart,
        });
      } catch {
        // Skip customers where ledger fetch fails
      }
    })
  );

  // Sort by most overdue first
  results.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return results;
}

// ── Path helper ───────────────────────────────────────────────────
const ledgerCol = (customerId: string) =>
  collection(db, "customers", customerId, "payments");

// ── Fetch all ledger entries for a customer ───────────────────────
export async function getLedger(customerId: string): Promise<LedgerEntry[]> {
  const snap = await getDocs(
    query(ledgerCol(customerId), orderBy("createdAt", "asc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as LedgerEntry));
}

// ── Calculate running balance from entries ────────────────────────
export function calcBalance(entries: LedgerEntry[]): number {
  return entries.reduce((bal, e) => {
    return e.direction === "debit" ? bal + e.amount : bal - e.amount;
  }, 0);
}

// ── Add a ledger entry + update customer.outstandingDue atomically ─
export async function addLedgerEntry(
  customerId: string,
  entry: Omit<LedgerEntry, "id">
): Promise<void> {
  await runTransaction(db, async (t) => {
    const custRef  = doc(db, "customers", customerId);
    const custSnap = await t.get(custRef);
    if (!custSnap.exists()) throw new Error("Customer not found");

    const currentDue: number = custSnap.data().outstandingDue || 0;
    const newDue =
      entry.direction === "debit"
        ? currentDue + entry.amount
        : Math.max(0, currentDue - entry.amount);

    // Add ledger entry
    const entryRef = doc(ledgerCol(customerId));
    t.set(entryRef, entry);

    // Update customer summary due
    t.update(custRef, { outstandingDue: newDue });
  });
}

// ── Record order placed (called when field agent creates order) ───
export async function recordOrderPlaced(
  customerId: string,
  orderId: string,
  orderAmount: number,
  agentId: string,
  agentName: string
): Promise<void> {
  await addLedgerEntry(customerId, {
    type: "order_placed",
    direction: "debit",
    amount: orderAmount,
    orderId,
    orderAmount,
    note: `Order #${orderId.slice(0, 8).toUpperCase()} placed`,
    createdBy: agentId,
    createdByName: agentName,
    createdAt: new Date().toISOString(),
  });
}

// ── Record delivery payment (called when delivery agent confirms) ─
export async function recordDeliveryPayment(
  customerId: string,
  orderId: string,
  amountCollected: number,
  agentId: string,
  agentName: string
): Promise<void> {
  if (amountCollected <= 0) return;
  await addLedgerEntry(customerId, {
    type: "delivery_payment",
    direction: "credit",
    amount: amountCollected,
    orderId,
    note: `Payment collected at delivery for order #${orderId.slice(0, 8).toUpperCase()}`,
    createdBy: agentId,
    createdByName: agentName,
    createdAt: new Date().toISOString(),
  });
}

// ── Record manual payment by admin ───────────────────────────────
export async function recordManualPayment(
  customerId: string,
  amount: number,
  note: string,
  adminId: string,
  adminName: string
): Promise<void> {
  await addLedgerEntry(customerId, {
    type: "manual_payment",
    direction: "credit",
    amount,
    note: note || "Manual payment received",
    createdBy: adminId,
    createdByName: adminName,
    createdAt: new Date().toISOString(),
  });
}

// ── Order-aware payment allocation ─────────────────────────────────
// This is the canonical way money should be recorded against orders from
// now on. `order.amountCollected` is the source of truth that every report
// and the order drawer reads from — a ledger-only credit (the old behaviour
// of recordManualPayment) left that field stale, which is the root cause of
// orders showing "Balance Due" / "Pending" even after being paid.
//
// Given a customer + an ordered list of target orders (oldest-first) and a
// total amount received, this fills each order's remaining balance in turn
// — fully settling earlier orders before any amount spills into the next —
// and writes one ledger entry per order actually touched (so the ledger
// stays traceable back to specific orders), plus a single customer
// outstandingDue reduction for the whole amount, all in one transaction.
export interface OrderPaymentAllocation {
  orderId: string;
  amountApplied: number;   // ₹ applied to this order from the payment
  newAmountCollected: number;
  fullySettled: boolean;
}

export async function applyPaymentToOrders(
  customerId: string,
  targetOrders: Array<{ id: string; totalAmount: number; amountCollected?: number; adminCollected?: number }>,
  totalAmountReceived: number,
  paymentMode: "cash" | "upi" | "bank" | "cheque" | "credit",
  note: string,
  adminId: string,
  adminName: string
): Promise<OrderPaymentAllocation[]> {
  if (totalAmountReceived <= 0) return [];

  // Oldest-first: caller is expected to have already sorted `targetOrders`,
  // but we don't rely on that — sort defensively isn't possible here since
  // we don't have createdAt in this minimal shape, so callers MUST pass
  // orders already in the order they want filled (oldest first).
  let remaining = totalAmountReceived;
  const allocations: OrderPaymentAllocation[] = [];

  for (const o of targetOrders) {
    if (remaining <= 0) break;
    const alreadyCollected = o.amountCollected ?? 0;
    const balance = Math.max(0, round2(o.totalAmount - alreadyCollected));
    if (balance <= 0) continue; // already fully paid, skip

    const applied = Math.min(balance, remaining);
    remaining = round2(remaining - applied);
    const newAmountCollected = round2(alreadyCollected + applied);

    allocations.push({
      orderId: o.id,
      amountApplied: applied,
      newAmountCollected,
      fullySettled: newAmountCollected >= o.totalAmount - 0.01,
    });
  }

  if (allocations.length === 0) return [];

  await runTransaction(db, async (t) => {
    const custRef  = doc(db, "customers", customerId);
    const custSnap = await t.get(custRef);
    if (!custSnap.exists()) throw new Error("Customer not found");

    const currentDue: number = custSnap.data().outstandingDue || 0;
    const totalApplied = round2(allocations.reduce((s, a) => s + a.amountApplied, 0));
    const newDue = Math.max(0, round2(currentDue - totalApplied));

    for (const alloc of allocations) {
      const orderRef = doc(db, "orders", alloc.orderId);
      const order = targetOrders.find((o) => o.id === alloc.orderId)!;
      const priorAdminCollected = order.adminCollected ?? 0;
      t.update(orderRef, {
        amountCollected: alloc.newAmountCollected,
        adminCollected: round2(priorAdminCollected + alloc.amountApplied),
        balanceDue: Math.max(0, round2(order.totalAmount - alloc.newAmountCollected)),
        paymentMode,
      });

      const entryRef = doc(ledgerCol(customerId));
      t.set(entryRef, {
        type: "manual_payment",
        direction: "credit",
        amount: alloc.amountApplied,
        orderId: alloc.orderId,
        note: note || `Payment (${paymentMode}) collected for order #${alloc.orderId.slice(0, 8).toUpperCase()}`,
        createdBy: adminId,
        createdByName: adminName,
        createdAt: new Date().toISOString(),
      });
    }

    t.update(custRef, { outstandingDue: newDue });
  });

  return allocations;
}

// Convenience wrapper for the common single-order "Record Payment" action
// in the order detail drawer (admin marks one specific order as paid,
// fully or partially).
export async function recordSingleOrderPayment(
  customerId: string,
  order: { id: string; totalAmount: number; amountCollected?: number; adminCollected?: number },
  amount: number,
  paymentMode: "cash" | "upi" | "bank" | "cheque" | "credit",
  note: string,
  adminId: string,
  adminName: string
): Promise<OrderPaymentAllocation | null> {
  const result = await applyPaymentToOrders(
    customerId, [order], amount, paymentMode, note, adminId, adminName
  );
  return result[0] ?? null;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ── DEV-ONLY: direct order payment-status reconciliation ────────────────────
// This is NOT part of the normal payment flow and must never be reachable by
// a real user. It exists for one specific data-repair scenario: an admin used
// the customer-level "Record Payment" tab (see Customers.tsx handlePayment)
// without selecting the specific order(s) the cash belonged to. That path
// calls recordManualPayment(), which correctly credits the ledger and reduces
// customer.outstandingDue — but never touches the underlying order's
// amountCollected/balanceDue, because it has no order to attach to. The
// result: the ledger and outstandingDue are already correct, but the order
// still shows as unpaid everywhere that reads amountCollected (order drawer,
// Pending Collections report, Customers → Orders tab).
//
// This function ONLY fixes the order side of that gap. On purpose it:
//   - does NOT write a ledger entry
//   - does NOT touch customer.outstandingDue
//   - DOES bump adminCollected (consistent with applyPaymentToOrders), so
//     AgentCashCollection's cash-in-hand math keeps excluding this amount
//     from whichever delivery agent handled the order
//   - re-reads the order inside a transaction and validates against the
//     order's OWN remaining balance, so it can never push amountCollected
//     past totalAmount
//   - requires a non-empty note and stamps who/when, appended to
//     order.devReconciliations, so every use of this tool is auditable later
//
// Gate any UI that calls this behind AppUser.devAccess (see types/index.ts).
// Never call this to record a genuinely new payment — use
// recordSingleOrderPayment / applyPaymentToOrders for that, since those keep
// the ledger and outstandingDue in sync the normal way.
export async function devReconcileOrderPayment(
  orderId: string,
  amount: number,
  note: string,
  devId: string,
  devName: string
): Promise<{ newAmountCollected: number; newBalanceDue: number }> {
  const trimmedNote = note.trim();
  if (!(amount > 0)) throw new Error("Amount must be greater than zero.");
  if (!trimmedNote) {
    throw new Error("A note is required — it's written to this order's audit trail.");
  }

  const orderRef = doc(db, "orders", orderId);

  return runTransaction(db, async (t) => {
    const snap = await t.get(orderRef);
    if (!snap.exists()) throw new Error("Order not found.");
    const current = snap.data() as Order;

    const totalAmount = current.totalAmount ?? 0;
    const alreadyCollected = current.amountCollected ?? 0;
    const priorAdminCollected = current.adminCollected ?? 0;
    const remainingBalance = Math.max(0, round2(totalAmount - alreadyCollected));

    if (amount > remainingBalance + 0.01) {
      throw new Error(
        `Amount (₹${amount.toFixed(2)}) exceeds this order's own remaining balance (₹${remainingBalance.toFixed(2)}).`
      );
    }

    const newAmountCollected = round2(alreadyCollected + amount);
    const newBalanceDue = Math.max(0, round2(totalAmount - newAmountCollected));

    const entry: DevReconciliationEntry = {
      amount,
      at: new Date().toISOString(),
      by: devId,
      byName: devName,
      note: trimmedNote,
    };
    const priorLog: DevReconciliationEntry[] = current.devReconciliations ?? [];

    t.update(orderRef, {
      amountCollected: newAmountCollected,
      adminCollected: round2(priorAdminCollected + amount),
      balanceDue: newBalanceDue,
      devReconciliations: [...priorLog, entry],
      lastDevReconciledAt: entry.at,
      lastDevReconciledBy: devId,
      lastDevReconciledByName: devName,
    });

    return { newAmountCollected, newBalanceDue };
  });
}

// ── Record adjustment (positive = add due, negative = reduce due) ─
export async function recordAdjustment(
  customerId: string,
  amount: number,
  note: string,
  adminId: string,
  adminName: string
): Promise<void> {
  await addLedgerEntry(customerId, {
    type: "adjustment",
    direction: amount >= 0 ? "debit" : "credit",
    amount: Math.abs(amount),
    note: note || "Manual adjustment",
    createdBy: adminId,
    createdByName: adminName,
    createdAt: new Date().toISOString(),
  });
}