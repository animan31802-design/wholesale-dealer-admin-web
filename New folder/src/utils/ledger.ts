import {
  collection, addDoc, getDocs, orderBy, query,
  doc, updateDoc, runTransaction, getDoc
} from "firebase/firestore";
import { db } from "../firebase/config";
import { LedgerEntry } from "../types/ledger";

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