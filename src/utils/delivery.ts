// ── Admin "Mark as Delivered" ─────────────────────────────────────────
// Normally only the delivery app moves an order to "delivered". Many orders
// are delivered by the business itself (no delivery-app step), so they sat
// at "assigned" forever — and every report that counts revenue/collections
// only looks at status === "delivered". This lets an admin complete an order
// from the web, doing the same bookkeeping a real delivery would:
//
//   • pending  → also does the Mark Packed stock deduction (+ stock movement log)
//   • optional payment collected at delivery → same effect as the Payment tab
//     (order.amountCollected/adminCollected, ONE ledger credit, customer due ↓)
//   • audit fields (deliveredByAdmin, deliveredBy, adminDeliveredAt) so it's
//     always visible that the web, not the delivery app, completed it
//
// Everything happens in ONE transaction that re-reads the order live, so if
// the delivery app changed the order a moment ago this fails loudly instead
// of overwriting it.

import { collection, deleteField, doc, runTransaction } from "firebase/firestore";
import { db } from "../firebase/config";
import type { Order } from "../types";

export const ADMIN_DELIVERABLE_STATUSES = ["pending", "packed", "assigned", "out_for_delivery"] as const;
export const BULK_DELIVERABLE_STATUSES  = ["packed", "assigned"] as const;

export function canAdminMarkDelivered(status: string): boolean {
  return (ADMIN_DELIVERABLE_STATUSES as readonly string[]).includes(status);
}

// Undo is only for deliveries the web marked, and only while nothing else
// (returns, partial delivery, handover) has been layered on top.
export function canAdminUndoDelivered(o: Order): boolean {
  return (
    o.status === "delivered" &&
    o.deliveredByAdmin === true &&
    !(o.items ?? []).some((i: any) => (i.returnedQty ?? 0) > 0) &&
    !(o as any).returnedAt
  );
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export interface MarkDeliveredInput {
  orderId: string;
  deliveredAt: string;              // ISO — chosen date/time (may be in the past)
  amount?: number;                  // optional payment collected at delivery
  paymentMode?: "cash" | "upi" | "bank" | "cheque";
  note?: string;
  adminId: string;
  adminName: string;
}

export async function adminMarkDelivered(input: MarkDeliveredInput): Promise<void> {
  const { orderId, deliveredAt, adminId, adminName } = input;
  const amount = round2(input.amount ?? 0);
  if (amount < 0) throw new Error("Amount cannot be negative.");
  if (new Date(deliveredAt).getTime() > Date.now() + 60_000) {
    throw new Error("Delivery date can't be in the future.");
  }
  const nowIso = new Date().toISOString();

  await runTransaction(db, async (t) => {
    // ── READ PHASE ─────────────────────────────────────────────
    const orderRef  = doc(db, "orders", orderId);
    const orderSnap = await t.get(orderRef);
    if (!orderSnap.exists()) throw new Error("Order not found.");
    const order = { ...(orderSnap.data() as Order), id: orderSnap.id };

    if (!canAdminMarkDelivered(order.status)) {
      throw new Error(`Order #${order.orderNo || orderId.slice(0, 8)} is now "${order.status}" — it can't be marked delivered. Please refresh.`);
    }
    // Delivery can't be before the order existed (also keeps the payment's
    // ledger row after the bill's ledger row).
    if (order.createdAt && new Date(deliveredAt).getTime() < new Date(order.createdAt).getTime()) {
      throw new Error(`Delivery date is before the order date (${new Date(order.createdAt).toLocaleString("en-IN")}).`);
    }

    const needsPacking = order.status === "pending";
    const productRefs  = needsPacking ? order.items.map((i) => doc(db, "products", i.productId)) : [];
    const productSnaps = needsPacking ? await Promise.all(productRefs.map((r) => t.get(r))) : [];

    const customerRef  = doc(db, "customers", order.customerId);
    const customerSnap = amount > 0 ? await t.get(customerRef) : null;

    const collected = order.amountCollected ?? 0;
    const balance   = Math.max(0, round2(order.totalAmount - collected));
    if (amount > balance + 0.01) {
      throw new Error(`Amount ₹${amount.toFixed(2)} is more than this bill's balance (₹${balance.toFixed(2)}).`);
    }
    const payAmount = Math.min(amount, balance);   // never push collected past the bill

    // ── WRITE PHASE ────────────────────────────────────────────
    const update: Record<string, unknown> = {
      status:           "delivered",
      deliveredAt,
      deliveredByAdmin: true,
      deliveredBy:      adminId,
      deliveredByName:  adminName,
      adminDeliveredAt: nowIso,          // when the admin actually clicked
    };
    if (input.note?.trim()) update.adminDeliveryNote = input.note.trim();

    // Pending → also pack: deduct stock + clear reservation (same as Mark Packed)
    if (needsPacking) {
      productSnaps.forEach((snap, i) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (!data.trackInventory) return;
        const item        = order.items[i];
        const before      = data.stock ?? 0;
        const newStock    = Math.max(0, before - item.quantity);
        const newReserved = Math.max(0, (data.reservedStock ?? 0) - item.quantity);
        t.update(productRefs[i], { stock: newStock, reservedStock: newReserved, updatedAt: nowIso });
        t.set(doc(collection(db, "products", item.productId, "stockMovements")), {
          type:          "sale_out",
          direction:     "out",
          qty:           item.quantity,
          stockBefore:   before,
          stockAfter:    newStock,
          reason:        `Order packed (marked delivered by admin): #${order.invoiceNumber || order.orderNo || orderId.slice(0, 8).toUpperCase()} — ${order.customerName}`,
          orderId,
          createdBy:     adminId,
          createdByName: adminName,
          createdAt:     nowIso,
        });
      });
      update.packedAt     = nowIso;
      update.packedBy     = adminId;
      update.packedByName = adminName;
    }

    // Optional payment at delivery — mirrors applyPaymentToOrders
    if (payAmount > 0 && customerSnap) {
      const newCollected = round2(collected + payAmount);
      const mode = input.paymentMode ?? "cash";
      update.amountCollected = newCollected;
      update.adminCollected  = round2((order.adminCollected ?? 0) + payAmount); // not delivery-agent cash
      update.balanceDue      = Math.max(0, round2(order.totalAmount - newCollected));
      update.paymentMode     = mode;
      // Most recent money on this order — never move it backwards if a later
      // payment was already recorded and this delivery is back-dated.
      update.lastPaymentAt = order.lastPaymentAt && order.lastPaymentAt > deliveredAt
        ? order.lastPaymentAt
        : deliveredAt;

      const orderNo = order.orderNo || orderId.slice(0, 8).toUpperCase();
      t.set(doc(collection(db, "customers", order.customerId, "payments")), {
        type:          "manual_payment",
        direction:     "credit",
        amount:        payAmount,
        orderId,
        orderNo,
        allocations:   [{ orderId, orderNo, amountApplied: payAmount }],
        note:          `Payment (${mode}) collected at delivery for order #${orderNo} (marked delivered by admin)`,
        createdBy:     adminId,
        createdByName: adminName,
        createdAt:     deliveredAt,
      });

      const currentDue = customerSnap.exists() ? (customerSnap.data().outstandingDue ?? 0) : 0;
      t.update(customerRef, { outstandingDue: Math.max(0, round2(currentDue - payAmount)), updatedAt: nowIso });
    }

    t.update(orderRef, update);
  });
}

// ── Undo an admin-marked delivery ─────────────────────────────────────
// Status goes back to "assigned" (or "packed" if no delivery person). Stock
// is not touched (packing already happened and stays). Payments recorded
// stay — they were real money; use Payment/Adjust if that needs changing.
export async function adminUndoDelivered(orderId: string, adminId: string, adminName: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await runTransaction(db, async (t) => {
    const orderRef  = doc(db, "orders", orderId);
    const snap      = await t.get(orderRef);
    if (!snap.exists()) throw new Error("Order not found.");
    const order = { ...(snap.data() as Order), id: snap.id };
    if (!canAdminUndoDelivered(order)) {
      throw new Error("Only deliveries marked by an admin (with no returns) can be undone.");
    }
    const log = (order as any).deliveryUndoLog ?? [];
    t.update(orderRef, {
      status:           order.deliveryPersonId ? "assigned" : "packed",
      deliveredAt:      deleteField(),
      deliveredByAdmin: deleteField(),
      deliveredBy:      deleteField(),
      deliveredByName:  deleteField(),
      adminDeliveredAt: deleteField(),
      adminDeliveryNote: deleteField(),
      deliveryUndoLog: [...log, {
        undoneAt: nowIso, undoneBy: adminId, undoneByName: adminName,
        previousDeliveredAt: order.deliveredAt ?? null,
      }],
    });
  });
}
