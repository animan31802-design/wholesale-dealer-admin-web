export type UserRole = "admin" | "field_agent" | "delivery" | "packing_staff";

export interface AppUser {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  phone?: string;
  assignedRegions?: string[];
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
  | "delivered"
  | "cancelled";

export type InvoiceType = "gst" | "estimate";
export type BillingMode = "with_due" | "without_due";

export interface Order {
  id?: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  customerPhone?: string;
  customerLat?: number;
  customerLng?: number;
  agentId: string;
  agentName: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  deliveryPersonId?: string;
  deliveryPersonName?: string;
  vehicleNumber?: string;
  assignedAt?: string;
  notes?: string;
  invoiceNumber?: string;
  invoiceType?: InvoiceType;
  signatureUrl?: string;
  signature?: string;
  amountCollected?: number;
  paymentMode?: "cash" | "upi" | "bank" | "credit";
  createdAt: string;
  packedAt?: string;
  packedBy?: string;
  packedByName?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelledByName?: string;
  cancellationReason?: string;
  regionId?: string;
  regionName?: string;
}