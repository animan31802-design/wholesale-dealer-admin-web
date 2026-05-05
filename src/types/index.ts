export type UserRole = "admin" | "field_agent" | "delivery";

export interface AppUser {
  uid: string;
  email: string;
  name: string;
  role: UserRole;
  phone?: string;
  createdAt: string;
}

export type GSTRate = "none" | "5" | "12" | "18" | "28";
export type ProductUnit = "Piece" | "KG" | "Gram" | "Liter" | "ML" | "Box" | "Packet" | "Dozen" | "Bag" | "Bottle" | "Other";

export interface PriceSlab {
  minQty: number;
  maxQty: number | null; // null = "and above"
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
  minStockAlert: number;
  safetyBuffer?: SafetyBuffer;
  sellInFraction: boolean;
  priceSlabs: PriceSlab[];
  barcode?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Customer {
  id?: string;
  shopName: string;
  ownerName: string;
  phone: string;
  address: string;
  area: string;
  createdAt?: string;
}

export interface OrderItem {
  productId: string;
  productName: string;
  price: number;
  unit: string;
  quantity: number;
  total: number;
}

export type OrderStatus = "pending" | "packed" | "out_for_delivery" | "delivered";

export interface Order {
  id?: string;
  customerId: string;
  customerName: string;
  customerAddress: string;
  agentId: string;
  agentName: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  deliveryPersonId?: string;
  deliveryPersonName?: string;
  vehicleNumber?: string;
  notes?: string;
  createdAt: string;
  packedAt?: string;
  deliveredAt?: string;
  signature?: string;
}
