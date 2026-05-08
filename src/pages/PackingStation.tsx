import { useEffect, useState } from "react";
import {
  collection, onSnapshot, doc, updateDoc, orderBy, query, where
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order } from "../types";
import { useAuthStore } from "../store/authStore";

export default function PackingStation() {
  const { user } = useAuthStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    // Real-time listener — only pending orders
    const q = query(
      collection(db, "orders"),
      where("status", "==", "pending"),
      orderBy("createdAt", "asc") // oldest first — FIFO packing
    );

    const unsub = onSnapshot(q, (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
      setLoading(false);
    });

    return () => unsub();
  }, []);

  const markPacked = async (order: Order) => {
    setConfirmingId(order.id!);
    try {
      await updateDoc(doc(db, "orders", order.id!), {
        status: "packed",
        packedAt: new Date().toISOString(),
        packedBy: user?.uid,
        packedByName: user?.name,
      });
      // onSnapshot will auto-remove it from the list
    } catch (err) {
      console.error("Failed to mark packed:", err);
    } finally {
      setConfirmingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <div className="text-center">
          <div className="text-4xl mb-3">📦</div>
          <p>Loading orders...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Packing Queue</h2>
        <p className="text-gray-500 text-sm mt-1">
          Orders are sorted oldest first. Pack and confirm each one.
        </p>
      </div>

      {/* Live count badge */}
      <div className="flex items-center gap-3 mb-6">
        <div className="bg-yellow-100 border border-yellow-200 rounded-xl px-5 py-3 flex items-center gap-3">
          <span className="text-2xl font-bold text-yellow-700">{orders.length}</span>
          <span className="text-sm text-yellow-600 font-medium">Orders pending packing</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"></span>
          Live updates
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <div className="text-5xl mb-4">✅</div>
          <p className="text-lg font-medium text-gray-500">All packed!</p>
          <p className="text-sm mt-1">No pending orders right now. Check back later.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order, idx) => (
            <div
              key={order.id}
              className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden"
            >
              {/* Order header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <div>
                    <p className="font-semibold text-gray-800">{order.customerName}</p>
                    <p className="text-xs text-gray-400">{order.customerAddress}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-gray-800">₹{order.totalAmount.toFixed(2)}</p>
                  <p className="text-xs text-gray-400">
                    By {order.agentName} · {new Date(order.createdAt).toLocaleTimeString("en-IN", {
                      hour: "2-digit", minute: "2-digit"
                    })}
                  </p>
                </div>
              </div>

              {/* Order items */}
              <div className="px-6 py-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 border-b border-gray-100">
                      <th className="text-left pb-2">Product</th>
                      <th className="text-center pb-2">Qty</th>
                      <th className="text-right pb-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {order.items.map((item, i) => (
                      <tr key={i} className="py-1">
                        <td className="py-2 text-gray-700 font-medium">{item.productName}</td>
                        <td className="py-2 text-center text-gray-500">
                          {item.quantity} {item.unit}
                        </td>
                        <td className="py-2 text-right text-gray-700">₹{item.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {order.notes && (
                  <div className="mt-3 bg-yellow-50 border border-yellow-100 rounded-lg px-3 py-2 text-xs text-yellow-700">
                    📝 Note: {order.notes}
                  </div>
                )}
              </div>

              {/* Pack action */}
              <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <div className="text-xs text-gray-400">
                  {order.items.length} item{order.items.length !== 1 ? "s" : ""} to pack
                </div>
                <button
                  onClick={() => markPacked(order)}
                  disabled={confirmingId === order.id}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all flex items-center gap-2"
                >
                  {confirmingId === order.id ? (
                    <>
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block"></span>
                      Confirming...
                    </>
                  ) : (
                    <>✅ Mark as Packed</>
                  )}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
