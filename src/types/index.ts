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
  balanceDue?: number;       // totalAmount - advancePaid; remaining for delivery
  amountCollected?: number;  // updated by delivery agent at delivery
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
}