// Firestore path: customers/{customerId}/payments/{paymentId}
export type LedgerEntryType =
  | "order_placed"       // debit  — order created by field agent
  | "advance_collected"  // credit — advance collected at order creation (mobile & web)
  | "delivery_payment"   // credit — amount collected at delivery by delivery agent
  | "manual_payment"     // credit — admin records offline payment
  | "adjustment"         // debit or credit — admin correction
  | "order_cancelled";   // credit — order cancelled, reverses full debit

export interface LedgerEntry {
  id?: string;
  type: LedgerEntryType;
  amount: number;          // always positive
  direction: "debit" | "credit";
  orderId?: string;        // linked order if applicable
  orderAmount?: number;    // total of that order
  note?: string;
  createdBy: string;       // uid
  createdByName: string;
  createdAt: string;       // ISO string
}