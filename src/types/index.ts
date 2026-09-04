export type UserRole = "admin" | "field_agent" | "delivery" | "packing_staff";

export interface AppUser {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  phone?: string;
  assignedRegions?: string[];
  isActive?: boolean;
  createdAt: string;
  // DEV-ONLY flag, toggled directly on this user's Firestore doc
  // (users/{uid}) from the console — never exposed in the Users admin UI.
  // When true, unlocks hidden developer/reconciliation tools for THIS user's
  // session only (e.g. the order drawer's "Mark as Paid" dev tool). Meant to
  // be switched on briefly while doing data-fix work, then switched back off.
  devAccess?: boolean;
}

// Audit trail entry written whenever a dev-mode tool directly mutates a
// live order's payment fields (bypassing the normal ledger-linked flow).
// Kept on the order doc itself so there's always a record of who touched
// what, when, and why — see utils/ledger.ts: devReconcileOrderPayment.
export interface DevReconciliationEntry {
  amount: number;
  at: string;       // ISO timestamp
  by: string;        // uid
  byName: string;
  note: string;      // required justification, e.g. "cash already recorded via customer ledger on 2 Sep, order wasn't linked"
}

export interface Region {
  id?: string;
  name: string;
  createdAt: string;
}

export interface Customer {
  id?: string;
  shopName: string;
  ownerName: string;
  phone: string;
  alternatePhone?: string;
  address: string;
  area: string;
  regionId: string;
  regionName: string;
  lat?: number;
  lng?: number;
  locationAddress?: string;
  gstin?: string;
  notes?: string;
  outstandingDue?: number;
  creditLimit?: number;
  createdAt?: string;
  createdBy?: string;      // uid of field agent who created this customer
  lastOrderAt?: string;    // ISO timestamp of most recent order
  lastOrderId?: string;    // Firestore id of most recent order
  updatedAt?: string;
}

export type GSTRate = "none" | "5" | "12" | "18" | "28";
export type ProductUnit =
  | "Piece" | "KG" | "Gram" | "Liter" | "ML"
  | "Box" | "Packet" | "Dozen" | "Bag" | "Bottle" | "Other";

export interface PriceSlab {
  minQty: number;
  maxQty: number | null;
  price: number;
}

export interface SafetyBuffer {
  type: "fixed" | "percentage";
  value: number;
}

export interface Product {
  id?: string;
  name: string;
  category: string;
  unit: ProductUnit;
  sellingPrice: number;
  costPrice: number;
  gst: GSTRate;
  trackInventory: boolean;
  stock: number;
  reservedStock?: number;
  minStockAlert: number;
  safetyBuffer?: SafetyBuffer;
  sellInFraction: boolean;
  priceSlabs: PriceSlab[];
  barcode?: string;
  hsn?: string;
  taxInclusive?: boolean;
  coverImage?: string;        // Cloudinary URL — shown in all product list views
  productImages?: string[];   // Cloudinary URLs — additional product gallery images
  createdAt?: string;
  updatedAt?: string;
}

// ── Per-bill product overrides ───────────────────────────────────
// Lets a field agent fix a product's name, price, unit, GST%, category, or
// fractional-sale setting without leaving the "add to cart" flow.
export interface OrderItemOverride {
  name?: string;
  price?: number;
  unit?: ProductUnit;
  gst?: GSTRate;
  category?: string;
  sellInFraction?: boolean;
}

export interface OrderItem {
  productId: string;
  productName: string;
  price: number;
  unit: string;
  quantity: number;
  total: number;
  hsn?: string;
  gst?: string;
  taxInclusive?: boolean;
}

export type OrderStatus =
  | "pending"
  | "packed"
  | "assigned"
  | "out_for_delivery"
  | "attempted"
  | "returned_to_warehouse"
  | "delivered"
  | "partially_delivered"
  | "partially_delivered_closed"
  | "cancelled";

export interface DeliveryAttempt {
  attemptedAt: string;
  agentId: string;
  agentName: string;
  reason: "shop_closed" | "customer_unavailable" | "refused_delivery" | "other";
  notes: string;
  deliveryLat?: number;
  deliveryLng?: number;
}

export type InvoiceType = "gst" | "estimate";
export type BillingMode = "with_due" | "without_due";

// ── Charges & Discounts (admin-configurable, applied per-invoice) ────────────
export type ChargeDiscountKind = "charge" | "discount";
export type ChargeDiscountMode = "flat" | "percentage";

// Admin-configured type, stored in settings/business.chargeDiscountTypes[]
export interface ChargeDiscountType {
  id: string;               // stable id (uuid-ish), used to reference from orders
  name: string;             // e.g. "Loading Charge", "Festival Discount"
  kind: ChargeDiscountKind;
  mode: ChargeDiscountMode; // flat ₹ or % of totalPayable
  defaultValue?: number;    // pre-filled value at invoice time (₹ or %)
  active: boolean;          // soft-disable without deleting (keeps old invoices intact)
}

// Resolved instance applied to a specific order/invoice
export interface AppliedChargeDiscount {
  id: string;        // ChargeDiscountType.id this was created from
  name: string;       // snapshot of the name at the time of invoicing
  kind: ChargeDiscountKind;
  mode: ChargeDiscountMode;
  value: number;      // the raw entered value (₹ if flat, % if percentage)
  amount: number;     // resolved ₹ amount (computed at generation time, used for printing)
}

export interface Order {
  id?: string;
  orderNo?: string;          // human-readable order number (written by both apps)
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerArea?: string;       // copied from customer.area at order creation
  customerPhone?: string;
  customerGstin?: string;    // written by web and (fixed) mobile at order creation
  customerLat?: number;
  customerLng?: number;
  agentId: string;
  agentName: string;
  regionId?: string;
  regionName?: string;
  items: OrderItem[];
  totalAmount: number;
  advancePaid?: number;      // advance collected by field agent at order creation
  balanceDue?: number;       // totalAmount - amountCollected; remaining balance
  amountCollected?: number;  // cumulative total collected so far (advance + delivery + admin-recorded)
  adminCollected?: number;   // portion of amountCollected added via admin "Record Payment" (NOT physically held by the delivery agent — excluded from their cash-in-hand)
  paymentMode?: "cash" | "upi" | "bank" | "credit" | "pending";
  status: OrderStatus;
  deliveryPersonId?: string;
  deliveryPersonName?: string;
  vehicleNumber?: string;
  assignedAt?: string;
  notes?: string;
  invoiceNumber?: string;
  invoiceType?: InvoiceType;
  invoicedAt?: string;
  billingMode?: BillingMode;
  invoicedDue?: number;      // customer's previous outstanding due, frozen at the time this invoice was generated (or last regenerated) — needed to reproduce the "Previous Due" line when the invoice is re-viewed later
  invoicedQrMode?: "with_amount" | "without_amount"; // QR mode frozen at generation time, so reopening reproduces the original invoice even if the business default changes later
  invoicedPaperSize?: "a4" | "a5"; // paper size frozen at generation time, same reasoning as invoicedQrMode
  appliedCharges?: AppliedChargeDiscount[];  // charges/discounts applied at invoice time
  voidedInvoices?: Array<{ invoiceNumber: string; voidedAt: string; voidedBy: string; voidedByName: string }>;
  deliveryAttempts?: DeliveryAttempt[];  // history of every failed delivery attempt
  currentHolder?: "delivery_agent" | "warehouse"; // where items are RIGHT NOW
  returnedToWarehouseAt?: string;        // when items came back to warehouse
  returnedToWarehouseBy?: string;
  returnedToWarehouseByName?: string;
  collectedAt?: string;                  // when delivery agent confirmed collection
  outForDeliveryAt?: string;
  signature?: string;
  signatureCollected?: boolean;
  billWithAgent?: boolean;
  createdAt: string;
  packedAt?: string;
  packedBy?: string;
  packedByName?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelledByName?: string;
  cancellationReason?: string;
  // ── Partial delivery ─────────────────────────────────────────
  deliveredItems?: DeliveredItem[];        // what was actually handed to customer
  partialBilledAmount?: number;           // recalculated total for delivered items only
  handoverStatus?: "pending_handover" | "handed_over" | "";
  handoverAt?: string;
  handoverBy?: string;
  handoverByName?: string;
  remainingItemsCancelled?: boolean;
  parentOrderId?: string;                 // set on follow-up reorders
  source?: string;                        // "partial_reorder" | etc.
  // ── Dev-only reconciliation audit trail ──────────────────────
  // Populated only by devReconcileOrderPayment (utils/ledger.ts), never by
  // the normal payment flows. See that function for what it does/doesn't touch.
  devReconciliations?: DevReconciliationEntry[];
  lastDevReconciledAt?: string;
  lastDevReconciledBy?: string;
  lastDevReconciledByName?: string;
}

export interface DeliveredItem {
  productId:     string;
  productName:   string;
  unit:          string;
  price:         number;
  orderedQty:    number;
  deliveredQty:  number;   // 0 = customer rejected entirely
  deliveredTotal: number;  // deliveredQty × price
}