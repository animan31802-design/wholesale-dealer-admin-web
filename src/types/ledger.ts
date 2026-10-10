// Firestore path: customers/{customerId}/payments/{paymentId}
export type LedgerEntryType =
  | "order_placed"       // debit  — order created by field agent
  | "advance_collected"  // credit — advance collected at order creation (mobile & web)
  | "delivery_payment"   // credit — amount collected at delivery by delivery agent
  | "manual_payment"     // credit — admin records offline payment
  | "adjustment"         // debit or credit — admin correction
  | "order_cancelled";   // credit — order cancelled, reverses full debit

export interface LedgerPaymentAllocation {
  orderId: string;
  orderNo: string;    // real, human-facing order number — never a truncated Firestore doc ID
  amountApplied: number;
}

export interface LedgerEntry {
  id?: string;
  type: LedgerEntryType;
  amount: number;          // always positive — for manual_payment, the FULL amount received,
                            // not a per-order split (see `allocations` for the breakdown)
  direction: "debit" | "credit";
  orderId?: string;        // single linked order — set for order_placed/advance_collected/etc,
                            // and (for backward compatibility with pre-existing entries) older
                            // manual_payment entries written before grouping was introduced
  orderAmount?: number;    // total of that order
  orderNo?: string;        // human-facing order number — written on newer entries only
  // Breakdown of which order(s) a single payment was split across, oldest-
  // settled-first. Only present on manual_payment entries written by
  // applyPaymentToOrders going forward — older entries (one full ledger row
  // per order touched) don't have this and are rendered as-is. The Ledger
  // tab shows an expand/collapse for any entry that has more than one
  // allocation; entries with exactly one still carry it (for the real
  // orderNo), but the UI doesn't bother showing an expand toggle for those.
  allocations?: LedgerPaymentAllocation[];
  note?: string;
  createdBy: string;       // uid
  createdByName: string;
  createdAt: string;       // ISO string
}