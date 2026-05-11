import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, Product } from "../types";

interface Stats {
  todayOrders: number;
  todayRevenue: number;
  pending: number;
  packed: number;
  assigned: number;
  outForDelivery: number;
  delivered: number;
}

const STATUS_COLOR: Record<string, string> = {
  pending:          "bg-yellow-100 text-yellow-700",
  packed:           "bg-blue-100 text-blue-700",
  assigned:         "bg-indigo-100 text-indigo-700",
  out_for_delivery: "bg-purple-100 text-purple-700",
  delivered:        "bg-green-100 text-green-700",
  cancelled:        "bg-gray-100 text-gray-500",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending", packed: "Packed", assigned: "Assigned",
  out_for_delivery: "Out for Delivery", delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats]               = useState<Stats>({
    todayOrders: 0, todayRevenue: 0,
    pending: 0, packed: 0, assigned: 0, outForDelivery: 0, delivered: 0,
  });
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [products, setProducts]         = useState<Product[]>([]);
  const [loading, setLoading]           = useState(true);
  const [stockModal, setStockModal]     = useState<"low" | "out" | null>(null);

  useEffect(() => {
    const unsub1 = onSnapshot(
      query(collection(db, "orders"), orderBy("createdAt", "desc")),
      (snap) => {
        const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order));
        const today  = new Date().toDateString();
        const todayO = orders.filter((o) => new Date(o.createdAt).toDateString() === today);
        setStats({
          todayOrders:    todayO.length,
          todayRevenue:   todayO.reduce((s, o) => s + o.totalAmount, 0),
          pending:        orders.filter((o) => o.status === "pending").length,
          packed:         orders.filter((o) => o.status === "packed").length,
          assigned:       orders.filter((o) => o.status === "assigned").length,
          outForDelivery: orders.filter((o) => o.status === "out_for_delivery").length,
          delivered:      orders.filter((o) => o.status === "delivered").length,
        });
        setRecentOrders(orders.filter((o) => o.status !== "cancelled").slice(0, 8));
        setLoading(false);
      }
    );

    const unsub2 = onSnapshot(
      query(collection(db, "products"), orderBy("name")),
      (snap) => setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product)))
    );

    return () => { unsub1(); unsub2(); };
  }, []);

  // Stock calculations
  const trackedProducts = products.filter((p) => p.trackInventory);
  const outOfStock      = trackedProducts.filter((p) => p.stock <= 0);
  const lowStock        = trackedProducts.filter((p) => p.stock > 0 && p.stock <= p.minStockAlert);

  if (loading) return <div className="p-8 text-gray-400">Loading dashboard...</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Dashboard</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-green-50 px-3 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
          Live updates
        </div>
      </div>

      {/* Stock alerts — shown prominently if any issues */}
      {(outOfStock.length > 0 || lowStock.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          {outOfStock.length > 0 && (
            <button
              onClick={() => setStockModal("out")}
              className="flex items-center gap-4 bg-red-50 border border-red-200 rounded-2xl p-4 text-left hover:bg-red-100 transition-all"
            >
              <div className="bg-red-100 rounded-xl w-12 h-12 flex items-center justify-center text-2xl flex-shrink-0">
                🚫
              </div>
              <div>
                <p className="text-xs text-red-400 font-semibold uppercase tracking-wide">Out of Stock</p>
                <p className="text-3xl font-bold text-red-600 leading-tight">{outOfStock.length}</p>
                <p className="text-xs text-red-400 mt-0.5">
                  {outOfStock.slice(0, 2).map((p) => p.name).join(", ")}
                  {outOfStock.length > 2 ? ` +${outOfStock.length - 2} more` : ""}
                </p>
              </div>
              <div className="ml-auto text-red-300 text-lg">→</div>
            </button>
          )}
          {lowStock.length > 0 && (
            <button
              onClick={() => setStockModal("low")}
              className="flex items-center gap-4 bg-yellow-50 border border-yellow-200 rounded-2xl p-4 text-left hover:bg-yellow-100 transition-all"
            >
              <div className="bg-yellow-100 rounded-xl w-12 h-12 flex items-center justify-center text-2xl flex-shrink-0">
                ⚠️
              </div>
              <div>
                <p className="text-xs text-yellow-500 font-semibold uppercase tracking-wide">Low Stock</p>
                <p className="text-3xl font-bold text-yellow-600 leading-tight">{lowStock.length}</p>
                <p className="text-xs text-yellow-500 mt-0.5">
                  {lowStock.slice(0, 2).map((p) => p.name).join(", ")}
                  {lowStock.length > 2 ? ` +${lowStock.length - 2} more` : ""}
                </p>
              </div>
              <div className="ml-auto text-yellow-300 text-lg">→</div>
            </button>
          )}
        </div>
      )}

      {/* Today stats */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Today</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Orders Today",     value: stats.todayOrders,  icon: "📦", bg: "bg-orange-100" },
          { label: "Revenue Today",    value: `₹${stats.todayRevenue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, icon: "💰", bg: "bg-green-100" },
          { label: "Pending Packing",  value: stats.pending,      icon: "⏳", bg: "bg-yellow-100" },
          { label: "Out for Delivery", value: stats.outForDelivery, icon: "🚚", bg: "bg-purple-100" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-2xl shadow-sm p-5 flex items-start gap-4">
            <div className={`${s.bg} rounded-xl w-11 h-11 flex items-center justify-center text-xl flex-shrink-0`}>
              {s.icon}
            </div>
            <div>
              <p className="text-xs text-gray-400 font-medium">{s.label}</p>
              <p className="text-2xl font-bold text-gray-800 leading-tight">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Order pipeline */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Order Pipeline</p>
      <div className="flex gap-3 mb-6 overflow-x-auto pb-1">
        {[
          { label: "Pending",        count: stats.pending,        color: "bg-yellow-100 text-yellow-700" },
          { label: "Packed",         count: stats.packed,         color: "bg-blue-100 text-blue-700"    },
          { label: "Assigned",       count: stats.assigned,       color: "bg-indigo-100 text-indigo-700"},
          { label: "Out for Delivery", count: stats.outForDelivery, color: "bg-purple-100 text-purple-700"},
          { label: "Delivered",      count: stats.delivered,      color: "bg-green-100 text-green-700"  },
        ].map((f, i, arr) => (
          <>
            <div key={f.label} className={`flex-1 rounded-xl p-4 ${f.color}`}>
              <p className="text-2xl font-bold">{f.count}</p>
              <p className="text-xs font-medium opacity-80 mt-0.5">{f.label}</p>
            </div>
            {i < arr.length - 1 && (
              <div key={`arrow-${i}`} className="flex items-center text-gray-300 text-xl">→</div>
            )}
          </>
        ))}
      </div>

      {/* Recent orders */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Recent Orders</p>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-400 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-5 py-3">Customer</th>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">Amount</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {recentOrders.map((order) => (
              <tr key={order.id} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-medium text-gray-800">{order.customerName}</td>
                <td className="px-5 py-3 text-gray-500 text-xs">{order.agentName}</td>
                <td className="px-5 py-3 font-medium text-gray-800">₹{order.totalAmount.toFixed(2)}</td>
                <td className="px-5 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[order.status] || ""}`}>
                    {STATUS_LABEL[order.status] || order.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-gray-400 text-xs">
                  {new Date(order.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {recentOrders.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <p className="text-3xl mb-2">📭</p>
            <p>No orders yet.</p>
          </div>
        )}
      </div>

      {/* Stock Alert Modal */}
      {stockModal && (
        <StockAlertModal
          type={stockModal}
          products={stockModal === "out" ? outOfStock : lowStock}
          onClose={() => setStockModal(null)}
          onGoToProducts={() => { setStockModal(null); navigate("/products"); }}
        />
      )}
    </div>
  );
}

// ── Stock Alert Modal ─────────────────────────────────────────────
function StockAlertModal({
  type, products, onClose, onGoToProducts,
}: {
  type: "low" | "out";
  products: Product[];
  onClose: () => void;
  onGoToProducts: () => void;
}) {
  const isOut = type === "out";

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 rounded-t-2xl ${isOut ? "bg-red-50 border-b border-red-100" : "bg-yellow-50 border-b border-yellow-100"}`}>
          <div>
            <h3 className={`text-lg font-bold ${isOut ? "text-red-700" : "text-yellow-700"}`}>
              {isOut ? "🚫 Out of Stock Products" : "⚠️ Low Stock Products"}
            </h3>
            <p className={`text-sm mt-0.5 ${isOut ? "text-red-500" : "text-yellow-600"}`}>
              {products.length} product{products.length !== 1 ? "s" : ""} {isOut ? "with zero stock" : "below minimum alert level"}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        {/* Product list */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="px-5 py-3 text-left">Product</th>
                <th className="px-5 py-3 text-left">Category</th>
                <th className="px-5 py-3 text-right">Stock</th>
                <th className="px-5 py-3 text-right">Min Alert</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((p) => (
                <tr key={p.id} className={`hover:bg-gray-50 ${p.stock <= 0 ? "bg-red-50/40" : "bg-yellow-50/30"}`}>
                  <td className="px-5 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-5 py-3 text-gray-500">{p.category || "—"}</td>
                  <td className="px-5 py-3 text-right">
                    <span className={`font-bold text-base ${p.stock <= 0 ? "text-red-600" : "text-yellow-600"}`}>
                      {p.stock} {p.unit}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-gray-400 text-xs">
                    {p.minStockAlert} {p.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
            Close
          </button>
          <button onClick={onGoToProducts}
            className={`flex-1 text-white py-2.5 rounded-xl text-sm font-semibold ${isOut ? "bg-red-500 hover:bg-red-600" : "bg-yellow-500 hover:bg-yellow-600"}`}>
            Go to Products →
          </button>
        </div>
      </div>
    </div>
  );
}