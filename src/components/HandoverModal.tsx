import { useState } from "react";
import {
  doc, getDoc, updateDoc, addDoc, collection, writeBatch,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, DeliveredItem } from "../types";
import { useAuthStore } from "../store/authStore";

interface HandoverModalProps {
  order:   Order;
  onClose: () => void;
  onDone:  () => void;
}

type Step = "confirm_handover" | "next_step" | "done";

export default function HandoverModal({ order, onClose, onDone }: HandoverModalProps) {
  const { user } = useAuthStore();

  const deliveredItems: DeliveredItem[] = order.deliveredItems ?? [];
  const returnedItems = deliveredItems.filter((i) => i.deliveredQty < i.orderedQty);
  const collectedCash = order.amountCollected ?? 0;
  const partialAmt    = order.partialBilledAmount ?? order.totalAmount;

  const [step,           setStep]           = useState<Step>("confirm_handover");
  const [cashConfirmed,  setCashConfirmed]  = useState(false);
  const [goodsChecked,   setGoodsChecked]   = useState<Record<string, boolean>>({});
  const [saving,         setSaving]         = useState(false);
  const [error,          setError]          = useState("");

  const allGoodsConfirmed = returnedItems.every((i: any) => goodsChecked[i.productId]);
  const canConfirm = cashConfirmed && (returnedItems.length === 0 || allGoodsConfirmed);

  const fmt = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Step 1: Record handover ─────────────────────────────────────
  const handleConfirmHandover = async () => {
    if (!canConfirm) return;
    setSaving(true);
    setError("");
    try {
      const now   = new Date().toISOString();
      const batch = writeBatch(db);

      // Close the partial order
      batch.update(doc(db, "orders", order.id!), {
        status:         "partially_delivered_closed",
        handoverStatus: "handed_over",
        handoverAt:     now,
        handoverBy:     user?.uid  ?? "",
        handoverByName: user?.name ?? "",
        updatedAt:      now,
      });

      // Restore reservedStock for partially-returned items
      // (fully-rejected items were already cleared by the agent at delivery time)
      for (const item of returnedItems) {
        if (item.deliveredQty <= 0) continue; // already cleared
        if (!item.productId) continue;
        const productSnap = await getDoc(doc(db, "products", item.productId));
        if (!productSnap.exists()) continue;
        if (productSnap.data().trackInventory === false) continue;

        const returnedQty     = item.orderedQty - item.deliveredQty;
        const currentReserved = productSnap.data().reservedStock ?? 0;
        const newReserved     = Math.max(0, currentReserved - returnedQty);
        batch.update(doc(db, "products", item.productId), {
          reservedStock: newReserved,
          updatedAt:     now,
        });
      }

      await batch.commit();
      setStep("next_step");
    } catch (err: any) {
      setError(err.message ?? "Failed to record handover.");
    } finally {
      setSaving(false);
    }
  };

  // ── Step 2a: Re-order undelivered items ─────────────────────────
  const handleReorder = async () => {
    setSaving(true);
    setError("");
    try {
      const now = new Date().toISOString();
      const undeliveredItems = deliveredItems
        .filter((item) => item.deliveredQty < item.orderedQty)
        .map((item) => ({
          productId:   item.productId,
          productName: item.productName,
          unit:        item.unit,
          price:       item.price,
          quantity:    parseFloat((item.orderedQty - item.deliveredQty).toFixed(3)),
          total:       parseFloat(((item.orderedQty - item.deliveredQty) * item.price).toFixed(2)),
        }));
      const newTotal = undeliveredItems.reduce((s, i) => s + i.total, 0);

      await addDoc(collection(db, "orders"), {
        customerId:      order.customerId,
        customerName:    order.customerName,
        customerAddress: order.customerAddress,
        customerPhone:   order.customerPhone,
        customerLat:     order.customerLat ?? 0,
        customerLng:     order.customerLng ?? 0,
        regionId:        order.regionId,
        regionName:      order.regionName,
        agentId:         order.agentId,
        agentName:       order.agentName,
        items:           undeliveredItems,
        totalAmount:     Math.round(newTotal * 100) / 100,
        advancePaid:     0,
        balanceDue:      Math.round(newTotal * 100) / 100,
        status:          "pending",
        paymentMode:     "credit",
        source:          "partial_reorder",
        parentOrderId:   order.id!,
        createdAt:       now,
        updatedAt:       now,
      });

      // Add to customer outstandingDue
      const customerSnap = await getDoc(doc(db, "customers", order.customerId!));
      if (customerSnap.exists()) {
        const liveDue = customerSnap.data().outstandingDue ?? 0;
        await updateDoc(doc(db, "customers", order.customerId!), {
          outstandingDue: Math.round((liveDue + newTotal) * 100) / 100,
          updatedAt:      now,
        });
      }

      setStep("done");
    } catch (err: any) {
      setError(err.message ?? "Failed to create follow-up order.");
    } finally {
      setSaving(false);
    }
  };

  // ── Step 2b: Cancel remaining items ─────────────────────────────
  const handleCancelRemaining = async () => {
    setSaving(true);
    setError("");
    try {
      await updateDoc(doc(db, "orders", order.id!), {
        remainingItemsCancelled: true,
        updatedAt:               new Date().toISOString(),
      });
      setStep("done");
    } catch (err: any) {
      setError(err.message ?? "Failed to cancel remaining items.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Record Handover</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              #{order.invoiceNumber || (order.id ?? "").slice(0, 8).toUpperCase()} · {order.customerName}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className="px-6 py-5 space-y-4">

          {/* ── STEP 1: Confirm handover ─────────────────────────── */}
          {step === "confirm_handover" && (
            <>
              {/* Summary banner */}
              <div className="bg-amber-50 rounded-xl p-4 space-y-2 text-sm">
                <p className="font-semibold text-amber-800">
                  {order.deliveryPersonName || "Delivery Agent"} is handing over:
                </p>
                <div className="flex justify-between text-gray-700">
                  <span>Partial billed amount</span>
                  <span className="font-semibold">₹{fmt(partialAmt)}</span>
                </div>
                <div className="flex justify-between text-gray-700">
                  <span>Cash collected at door</span>
                  <span className="font-semibold text-green-700">₹{fmt(collectedCash)}</span>
                </div>
              </div>

              {/* Cash checkbox */}
              <label
                className="flex items-start gap-3 cursor-pointer p-3 rounded-xl border-2 border-dashed transition-all"
                style={{
                  borderColor: cashConfirmed ? "#22c55e" : "#d1d5db",
                  background:  cashConfirmed ? "#f0fdf4"  : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={cashConfirmed}
                  onChange={(e) => setCashConfirmed(e.target.checked)}
                  className="mt-0.5 w-4 h-4 accent-green-500"
                />
                <div>
                  <p className="font-medium text-sm text-gray-800">
                    ✅ Received ₹{fmt(collectedCash)} cash from {order.deliveryPersonName || "delivery agent"}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">Tick to confirm you physically received the cash.</p>
                </div>
              </label>

              {/* Goods checkboxes */}
              {returnedItems.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-gray-700">Confirm returned goods received:</p>
                  {returnedItems.map((item) => {
                    const returnQty = parseFloat((item.orderedQty - item.deliveredQty).toFixed(3));
                    const checked   = goodsChecked[item.productId] ?? false;
                    return (
                      <label
                        key={item.productId}
                        className="flex items-start gap-3 cursor-pointer p-3 rounded-xl border-2 border-dashed transition-all"
                        style={{
                          borderColor: checked ? "#f97316" : "#d1d5db",
                          background:  checked ? "#fff7ed" : "transparent",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setGoodsChecked((prev) => ({ ...prev, [item.productId]: e.target.checked }))
                          }
                          className="mt-0.5 w-4 h-4 accent-orange-500"
                        />
                        <div>
                          <p className="font-medium text-sm text-gray-800">
                            📦 {returnQty} {item.unit} — {item.productName}
                          </p>
                          <p className="text-xs text-gray-500">
                            Ordered {item.orderedQty.toFixed(2)}, delivered {item.deliveredQty.toFixed(2)}, returning {returnQty.toFixed(2)}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg p-3">{error}</p>}

              <button
                onClick={handleConfirmHandover}
                disabled={!canConfirm || saving}
                className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
              >
                {saving ? "Saving…" : "✅ Confirm — All Received"}
              </button>
            </>
          )}

          {/* ── STEP 2: What to do with undelivered items ─────────── */}
          {step === "next_step" && (
            <>
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
                <span className="text-2xl">✅</span>
                <div>
                  <p className="font-semibold text-green-800 text-sm">Handover recorded successfully</p>
                  <p className="text-xs text-green-700 mt-0.5">Order is now closed. What should happen to the undelivered items?</p>
                </div>
              </div>

              {returnedItems.length > 0 && (
                <div className="bg-gray-50 rounded-xl p-3 text-xs text-gray-600 space-y-1">
                  <p className="font-semibold text-gray-700 mb-1">Undelivered items:</p>
                  {returnedItems.map((item) => (
                    <div key={item.productId} className="flex justify-between">
                      <span>{item.productName}</span>
                      <span className="font-medium">{(item.orderedQty - item.deliveredQty).toFixed(2)} {item.unit}</span>
                    </div>
                  ))}
                </div>
              )}

              {error && <p className="text-red-500 text-sm bg-red-50 rounded-lg p-3">{error}</p>}

              <div className="space-y-3">
                <button
                  onClick={handleReorder}
                  disabled={saving}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
                >
                  {saving ? "Creating…" : "🔄 Re-order — Send for Next Delivery"}
                </button>
                <button
                  onClick={handleCancelRemaining}
                  disabled={saving}
                  className="w-full border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50 font-semibold py-3 rounded-xl text-sm transition-colors"
                >
                  {saving ? "Saving…" : "❌ Cancel Remaining Items"}
                </button>
              </div>
            </>
          )}

          {/* ── STEP 3: Done ─────────────────────────────────────── */}
          {step === "done" && (
            <>
              <div className="bg-green-50 border border-green-200 rounded-xl p-5 text-center space-y-2">
                <p className="text-3xl">🎉</p>
                <p className="font-bold text-green-800">All done!</p>
                <p className="text-sm text-green-700">The partial delivery has been fully closed.</p>
              </div>
              <button
                onClick={onDone}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3 rounded-xl text-sm"
              >
                Close
              </button>
            </>
          )}

        </div>
      </div>
    </div>
  );
}