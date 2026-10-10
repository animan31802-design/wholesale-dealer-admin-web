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
  oldestUnpaidDate: string; // ISO createdAt of the oldest bill not yet covered by payments
  // The ledger debit that is overdue — normally an order_placed entry, but
  // it can be a debit adjustment. orderId/orderNo are set when it's an order.
  oldestUnpaidType: LedgerEntry["type"];
  oldestUnpaidOrderId?: string;
  oldestUnpaidOrderNo?: string;
  oldestUnpaidRemaining: number; // ₹ still unpaid on that oldest bill
}

export const DEFAULT_OVERDUE_THRESHOLD_DAYS = 30;

// Reads Settings → Overdue Alerts (settings/business.overdueThresholdDays).
// Falls back to 30 if the doc/field is missing or unreadable.
export async function getOverdueThresholdDays(): Promise<number> {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    const n = snap.exists() ? Number(snap.data().overdueThresholdDays) : NaN;
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_OVERDUE_THRESHOLD_DAYS;
  } catch {
    return DEFAULT_OVERDUE_THRESHOLD_DAYS;
  }
}

// ── Oldest unpaid bill (FIFO) ─────────────────────────────────────
// All credits (payments, credit adjustments) are pooled and applied to the
// debits oldest-first; the first debit the pool can't fully cover is the
// oldest unpaid bill.
//
// Why not a running-balance walk (the previous approach): it dated the
// overdue from "the last time the balance was ₹0". A regular customer who
// always owes something never touches ₹0, so every one of them looked
// overdue from their very first order (e.g. 126 days for a customer whose
// only unpaid bill was 5 days old). It also clamped the balance at 0, so the
// result depended on the order of same-timestamp entries. Pooling credits
// makes the result independent of entry order within the ledger.
//
// Cancelled orders are netted out first: an order_cancelled credit is
// matched against that order's own order_placed debit, so a cancellation
// never "pays" an unrelated older bill.
export function getOldestUnpaidDebit(
  entries: LedgerEntry[]
): { entry: LedgerEntry; remaining: number } | null {
  if (entries.length === 0) return null;

  // 1. Net cancellations against their own order's debit
  const cancelledByOrder = new Map<string, number>();
  for (const e of entries) {
    if (e.type === "order_cancelled" && e.direction === "credit" && e.orderId) {
      cancelledByOrder.set(e.orderId, round2((cancelledByOrder.get(e.orderId) ?? 0) + e.amount));
    }
  }

  let creditPool = 0;
  const debits: { entry: LedgerEntry; amount: number; idx: number }[] = [];

  entries.forEach((e, idx) => {
    if (e.direction === "credit") {
      // Cancellation credits that match an order's debit are consumed in step 1
      if (e.type === "order_cancelled" && e.orderId) return;
      creditPool += e.amount;
      return;
    }
    let amount = e.amount;
    if (e.type === "order_placed" && e.orderId && cancelledByOrder.has(e.orderId)) {
      const avail = cancelledByOrder.get(e.orderId)!;
      const used = Math.min(avail, amount);
      amount = round2(amount - used);
      cancelledByOrder.set(e.orderId, round2(avail - used));
    }
    if (amount > 0.01) debits.push({ entry: e, amount, idx });
  });

  // A cancellation credit with no matching debit in this ledger still
  // reduces what's owed — put any leftover into the general pool.
  for (const left of cancelledByOrder.values()) creditPool += left;
  creditPool = round2(creditPool);

  // 2. Oldest-first (stable on ties)
  debits.sort((a, b) =>
    (a.entry.createdAt || "").localeCompare(b.entry.createdAt || "") || a.idx - b.idx
  );

  // 3. Apply the pool FIFO
  for (const d of debits) {
    if (creditPool >= d.amount - 0.01) {
      creditPool = round2(creditPool - d.amount);
      continue;
    }
    return { entry: d.entry, remaining: round2(d.amount - creditPool) };
  }
  return null; // everything is covered
}

// Kept for any caller that only needs the date.
export function getOverdueStartDate(entries: LedgerEntry[]): string | null {
  return getOldestUnpaidDebit(entries)?.entry.createdAt ?? null;
}

// ── Fetch all overdue customers (due > 0 AND oldest unpaid bill ≥ threshold days) ─
// thresholdDays omitted → read from Settings (default 30).
export async function getOverdueCustomers(
  customers: Customer[],
  thresholdDays?: number
): Promise<OverdueCustomer[]> {
  const days = thresholdDays ?? await getOverdueThresholdDays();
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const thresholdMs = days * DAY_MS;

  // Only check customers that actually have a due
  const withDue = customers.filter((c) => (c.outstandingDue || 0) > 0);

  const results: OverdueCustomer[] = [];

  await Promise.all(
    withDue.map(async (customer) => {
      try {
        const entries = await getLedger(customer.id!);
        const dueAmount = calcBalance(entries);
        if (dueAmount <= 0.01) return;

        const oldest = getOldestUnpaidDebit(entries);
        if (!oldest) return;

        const ageMs = now - new Date(oldest.entry.createdAt).getTime();
        if (!Number.isFinite(ageMs) || ageMs < thresholdMs) return;

        results.push({
          customer,
          dueAmount,
          daysOverdue: Math.floor(ageMs / DAY_MS),
          oldestUnpaidDate: oldest.entry.createdAt,
          oldestUnpaidType: oldest.entry.type,
          oldestUnpaidOrderId: oldest.entry.orderId,
          oldestUnpaidOrderNo: oldest.entry.orderNo || undefined,
          oldestUnpaidRemaining: oldest.remaining,
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
// Given a customer + an ordered list of target order IDs (oldest-first) and
// a total amount received, this fills each order's remaining balance in
// turn — fully settling earlier orders before any amount spills into the
// next — and writes ONE ledger entry for the whole payment (with a
// per-order `allocations` breakdown), plus a single customer outstandingDue
// reduction, all in one transaction.
//
// Every order is re-read fresh INSIDE the transaction (see READ PHASE
// below) rather than trusting amountCollected/adminCollected the caller's
// browser saw moments ago. A real bug traced through a live customer's data
// showed exactly what goes wrong without this: a payment submitted minutes
// after an earlier one, from a browser that hadn't refreshed, silently
// re-applied money to an order that had already been settled — the order
// ended up credited for more than was ever actually paid. Reading fresh
// inside the transaction, and aborting if the live balances can't absorb
// the full amount (see the `remaining > 0` check), closes that gap: a
// stale or duplicate submission now fails loudly instead of quietly
// over-crediting an order.
export interface OrderPaymentAllocation {
  orderId: string;
  orderNo?: string;
  amountApplied: number;   // ₹ applied to this order from the payment
  newAmountCollected: number;
  fullySettled: boolean;
}

function defaultPaymentNote(paymentMode: string, allocations: OrderPaymentAllocation[]): string {
  const nos = allocations.map((a) => a.orderNo || a.orderId.slice(0, 8).toUpperCase());
  if (nos.length === 1) return `Payment (${paymentMode}) collected for order #${nos[0]}`;
  if (nos.length === 2) return `Payment (${paymentMode}) settled orders #${nos[0]} + #${nos[1]}`;
  return `Payment (${paymentMode}) settled ${nos.length} orders (see breakdown)`;
}

export async function applyPaymentToOrders(
  customerId: string,
  orderIds: string[],   // oldest-first — caller controls fill order
  totalAmountReceived: number,
  paymentMode: "cash" | "upi" | "bank" | "cheque" | "credit",
  note: string,
  adminId: string,
  adminName: string
): Promise<OrderPaymentAllocation[]> {
  if (totalAmountReceived <= 0 || orderIds.length === 0) return [];

  return runTransaction(db, async (t) => {
    const custRef = doc(db, "customers", customerId);

    // ── READ PHASE — every read must happen before any write in a Firestore
    // transaction, so the customer doc and every target order are fetched
    // fresh here, live, right before we decide how to allocate the money.
    const custSnap = await t.get(custRef);
    if (!custSnap.exists()) throw new Error("Customer not found");

    const orderRefs  = orderIds.map((id) => doc(db, "orders", id));
    const orderSnaps = await Promise.all(orderRefs.map((ref) => t.get(ref)));
    const snapByOrderId = new Map(orderIds.map((id, i) => [id, orderSnaps[i]]));

    let remaining = round2(totalAmountReceived);
    const allocations: OrderPaymentAllocation[] = [];

    for (const orderId of orderIds) {
      if (remaining <= 0) break;
      const snap = snapByOrderId.get(orderId)!;
      if (!snap.exists()) continue; // shouldn't happen, but don't fail the whole payment over it
      const order = snap.data() as Order;
      const alreadyCollected = order.amountCollected ?? 0;
      const balance = Math.max(0, round2(order.totalAmount - alreadyCollected));
      if (balance <= 0) continue; // already fully settled (by this transaction's live read) — skip

      const applied = Math.min(balance, remaining);
      remaining = round2(remaining - applied);
      const newAmountCollected = round2(alreadyCollected + applied);

      allocations.push({
        orderId,
        orderNo: order.orderNo,
        amountApplied: applied,
        newAmountCollected,
        fullySettled: newAmountCollected >= order.totalAmount - 0.01,
      });
    }

    if (allocations.length === 0) {
      throw new Error("None of the selected orders could be settled — they may already have been paid by another transaction. Please refresh and try again.");
    }
    // The amount was validated against balances the browser had a moment
    // ago; if live data now shows less due than that (another payment, a
    // dev reconciliation, or a duplicate submission already settled some of
    // it), abort rather than silently dropping the extra money or applying
    // it somewhere the admin never chose.
    if (remaining > 0.01) {
      throw new Error(
        `₹${remaining.toFixed(2)} of this payment couldn't be matched to a remaining balance — the selected order(s) may have just been settled elsewhere. Please refresh and try again before re-entering the payment.`
      );
    }

    // ── WRITE PHASE ──
    const currentDue: number = custSnap.data().outstandingDue || 0;
    const totalApplied = round2(allocations.reduce((s, a) => s + a.amountApplied, 0));
    const newDue = Math.max(0, round2(currentDue - totalApplied));

    for (const alloc of allocations) {
      const orderRef = doc(db, "orders", alloc.orderId);
      const order = snapByOrderId.get(alloc.orderId)!.data() as Order;
      const priorAdminCollected = order.adminCollected ?? 0;
      t.update(orderRef, {
        amountCollected: alloc.newAmountCollected,
        adminCollected: round2(priorAdminCollected + alloc.amountApplied),
        balanceDue: Math.max(0, round2(order.totalAmount - alloc.newAmountCollected)),
        paymentMode,
        lastPaymentAt: new Date().toISOString(),
      });
    }

    // ── ONE ledger entry for the entire payment ──────────────────────
    // Previously this wrote one full row per order touched, which is also
    // what let a now-removed dedup-on-view routine mistake a second,
    // legitimate payment against the same order for a duplicate and
    // silently delete it. One entry per payment, with the breakdown living
    // in `allocations`, removes that collision entirely — see the Ledger
    // tab's expand/collapse in Customers.tsx.
    const entryRef = doc(ledgerCol(customerId));
    t.set(entryRef, {
      type: "manual_payment",
      direction: "credit",
      amount: totalApplied,
      allocations: allocations.map((a) => ({
        orderId: a.orderId,
        orderNo: a.orderNo || a.orderId.slice(0, 8).toUpperCase(),
        amountApplied: a.amountApplied,
      })),
      note: note || defaultPaymentNote(paymentMode, allocations),
      createdBy: adminId,
      createdByName: adminName,
      createdAt: new Date().toISOString(),
    });

    t.update(custRef, { outstandingDue: newDue });

    return allocations;
  });
}

// Convenience wrapper for the common single-order "Record Payment" action
// in the order detail drawer (admin marks one specific order as paid,
// fully or partially).
export async function recordSingleOrderPayment(
  customerId: string,
  orderId: string,
  amount: number,
  paymentMode: "cash" | "upi" | "bank" | "cheque" | "credit",
  note: string,
  adminId: string,
  adminName: string
): Promise<OrderPaymentAllocation | null> {
  const result = await applyPaymentToOrders(
    customerId, [orderId], amount, paymentMode, note, adminId, adminName
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
      lastPaymentAt: entry.at,
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