import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, onSnapshot, query, orderBy, getDocs } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, Product, Customer } from "../types";
import { getOverdueCustomers, OverdueCustomer } from "../utils/ledger";
import { useAuthStore } from "../store/authStore";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const STATUS_COLOR: Record<string, string> = {
  pending:"bg-yellow-100 text-yellow-700", packed:"bg-blue-100 text-blue-700",
  assigned:"bg-indigo-100 text-indigo-700", out_for_delivery:"bg-purple-100 text-purple-700",
  delivered:"bg-green-100 text-green-700", cancelled:"bg-gray-100 text-gray-500",
};
const STATUS_LABEL: Record<string, string> = {
  pending:"Pending", packed:"Packed", assigned:"Assigned",
  out_for_delivery:"Out for Delivery", delivered:"Delivered", cancelled:"Cancelled",
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";
  const [orders, setOrders]     = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading]   = useState(true);
  const [stockModal, setStockModal] = useState<"low"|"out"|null>(null);
  const [chartDays, setChartDays]   = useState<7|30>(7);

  // ── Overdue due state (admin only) ────────────────────────────
  const [overdueList, setOverdueList]     = useState<OverdueCustomer[]>([]);
  const [overdueModal, setOverdueModal]   = useState(false);
  const [overdueLoading, setOverdueLoading] = useState(false);

  useEffect(() => {
    const unsub1 = onSnapshot(query(collection(db, "orders"), orderBy("createdAt", "desc")), (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
      setLoading(false);
    });
    const unsub2 = onSnapshot(query(collection(db, "products"), orderBy("name")), (snap) => {
      setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product)));
    });

    // ── Fetch overdue customers (admin only, once on mount) ────
    if (isAdmin) {
      setOverdueLoading(true);
      getDocs(query(collection(db, "customers"), orderBy("shopName")))
        .then(async (snap) => {
          const customers = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer));
          const overdue = await getOverdueCustomers(customers, 30);
          setOverdueList(overdue);
        })
        .catch(() => {})
        .finally(() => setOverdueLoading(false));
    }

    return () => { unsub1(); unsub2(); };
  }, []);

  const today = new Date().toDateString();
  const activeOrders = orders.filter((o) => o.status !== "cancelled");
  const todayOrders  = activeOrders.filter((o) => new Date(o.createdAt).toDateString() === today);

  // Pipeline counts
  const counts = {
    pending: activeOrders.filter((o) => o.status === "pending").length,
    packed:  activeOrders.filter((o) => o.status === "packed").length,
    assigned: activeOrders.filter((o) => o.status === "assigned").length,
    outForDelivery: activeOrders.filter((o) => o.status === "out_for_delivery").length,
    delivered: activeOrders.filter((o) => o.status === "delivered").length,
  };

  // Stock alerts
  const tracked    = products.filter((p) => p.trackInventory);
  const outOfStock = tracked.filter((p) => p.stock <= 0);
  const lowStock   = tracked.filter((p) => p.stock > 0 && p.stock <= p.minStockAlert);

  // Revenue chart data
  const chartData = (() => {
    const days = Array.from({ length: chartDays }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (chartDays - 1 - i));
      return { date: d.toDateString(), label: d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }), revenue: 0, orders: 0 };
    });
    activeOrders.forEach((o) => {
      const ds = new Date(o.createdAt).toDateString();
      const day = days.find((d) => d.date === ds);
      if (day) { day.revenue += o.totalAmount; day.orders += 1; }
    });
    return days;
  })();

  // Top 5 products by revenue
  const topProducts = (() => {
    const map: Record<string, { name: string; revenue: number; qty: number }> = {};
    activeOrders.forEach((o) => {
      o.items.forEach((item) => {
        if (!map[item.productId]) map[item.productId] = { name: item.productName, revenue: 0, qty: 0 };
        map[item.productId].revenue += item.total;
        map[item.productId].qty     += item.quantity;
      });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  })();

  const maxRevenue = Math.max(...topProducts.map((p) => p.revenue), 1);

  if (loading) return (
    <div className="p-8 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading dashboard...
    </div>
  );

  return (
    <div className="p-3 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Dashboard</h2>
          <p className="text-sm text-gray-400 mt-0.5">{new Date().toLocaleDateString("en-IN", { weekday:"long", day:"numeric", month:"long", year:"numeric" })}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-green-50 px-3 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />Live
        </div>
      </div>

      {/* Stock alerts */}
      {(outOfStock.length > 0 || lowStock.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          {outOfStock.length > 0 && (
            <button onClick={() => setStockModal("out")}
              className="flex items-center gap-4 bg-red-50 border border-red-200 rounded-2xl p-4 text-left hover:bg-red-100 transition-all">
              <div className="bg-red-100 rounded-xl w-12 h-12 flex items-center justify-center text-2xl flex-shrink-0">🚫</div>
              <div>
                <p className="text-xs text-red-400 font-semibold uppercase tracking-wide">Out of Stock</p>
                <p className="text-3xl font-bold text-red-600 leading-tight">{outOfStock.length}</p>
                <p className="text-xs text-red-400 mt-0.5">{outOfStock.slice(0,2).map((p) => p.name).join(", ")}{outOfStock.length > 2 ? ` +${outOfStock.length-2} more` : ""}</p>
              </div>
              <div className="ml-auto text-red-300 text-lg">→</div>
            </button>
          )}
          {lowStock.length > 0 && (
            <button onClick={() => setStockModal("low")}
              className="flex items-center gap-4 bg-yellow-50 border border-yellow-200 rounded-2xl p-4 text-left hover:bg-yellow-100 transition-all">
              <div className="bg-yellow-100 rounded-xl w-12 h-12 flex items-center justify-center text-2xl flex-shrink-0">⚠️</div>
              <div>
                <p className="text-xs text-yellow-500 font-semibold uppercase tracking-wide">Low Stock</p>
                <p className="text-3xl font-bold text-yellow-600 leading-tight">{lowStock.length}</p>
                <p className="text-xs text-yellow-500 mt-0.5">{lowStock.slice(0,2).map((p) => p.name).join(", ")}{lowStock.length > 2 ? ` +${lowStock.length-2} more` : ""}</p>
              </div>
              <div className="ml-auto text-yellow-300 text-lg">→</div>
            </button>
          )}
        </div>
      )}

      {/* Overdue due alert (admin only) */}
      {isAdmin && (overdueLoading || overdueList.length > 0) && (
        <div className="mb-6">
          <button
            onClick={() => !overdueLoading && setOverdueModal(true)}
            className="w-full flex items-center gap-4 bg-orange-50 border border-orange-200 rounded-2xl p-4 text-left hover:bg-orange-100 transition-all"
          >
            <div className="bg-orange-100 rounded-xl w-12 h-12 flex items-center justify-center text-2xl flex-shrink-0">
              {overdueLoading ? <span className="animate-spin text-base">⏳</span> : "🔔"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-orange-500 font-semibold uppercase tracking-wide">Overdue Balances · 30+ Days</p>
              {overdueLoading ? (
                <p className="text-sm text-orange-400 mt-0.5">Checking customer dues...</p>
              ) : (
                <>
                  <p className="text-3xl font-bold text-orange-600 leading-tight">{overdueList.length}</p>
                  <p className="text-xs text-orange-400 mt-0.5 truncate">
                    {overdueList.slice(0, 2).map((o) => o.customer.shopName).join(", ")}
                    {overdueList.length > 2 ? ` +${overdueList.length - 2} more` : ""}
                    {" · "}Total ₹{overdueList.reduce((s, o) => s + o.dueAmount, 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })} pending
                  </p>
                </>
              )}
            </div>
            {!overdueLoading && <div className="ml-auto text-orange-300 text-lg flex-shrink-0">→</div>}
          </button>
        </div>
      )}

      {/* Today stats */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Today</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label:"Orders Today",     value: todayOrders.length,  icon:"📦", bg:"bg-orange-100" },
          { label:"Revenue Today",    value: `₹${todayOrders.reduce((s,o) => s+o.totalAmount,0).toLocaleString("en-IN",{maximumFractionDigits:0})}`, icon:"💰", bg:"bg-green-100" },
          { label:"Pending Packing",  value: counts.pending,      icon:"⏳", bg:"bg-yellow-100" },
          { label:"Out for Delivery", value: counts.outForDelivery, icon:"🚚", bg:"bg-purple-100" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-2xl shadow-sm p-5 flex items-start gap-4">
            <div className={`${s.bg} rounded-xl w-11 h-11 flex items-center justify-center text-xl flex-shrink-0`}>{s.icon}</div>
            <div>
              <p className="text-xs text-gray-400 font-medium">{s.label}</p>
              <p className="text-2xl font-bold text-gray-800 leading-tight">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Revenue chart + Top products */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
        {/* Revenue chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-gray-700">Revenue Trend</p>
            <div className="flex gap-1">
              {([7,30] as const).map((d) => (
                <button key={d} onClick={() => setChartDays(d)}
                  className={`px-3 py-1 text-xs rounded-lg font-medium transition-all ${chartDays === d ? "bg-orange-500 text-white" : "text-gray-400 hover:bg-gray-100"}`}>
                  {d}D
                </button>
              ))}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
                tickFormatter={(v) => `₹${v >= 1000 ? (v/1000).toFixed(0)+"k" : v}`} />
              <Tooltip formatter={(v: any) => [`₹${Number(v).toLocaleString("en-IN")}`, "Revenue"]}
                labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Line type="monotone" dataKey="revenue" stroke="#f97316" strokeWidth={2.5}
                dot={{ r: 3, fill: "#f97316" }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Top products */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">🏆 Top Products</p>
          {topProducts.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">No orders yet</div>
          ) : (
            <div className="space-y-3">
              {topProducts.map((p, i) => (
                <div key={p.name}>
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-bold w-5 ${i === 0 ? "text-yellow-500" : i === 1 ? "text-gray-400" : i === 2 ? "text-orange-400" : "text-gray-300"}`}>
                        #{i+1}
                      </span>
                      <span className="text-xs text-gray-700 font-medium truncate max-w-[80px] sm:max-w-[140px]">{p.name}</span>
                    </div>
                    <span className="text-xs font-semibold text-gray-800">₹{p.revenue.toLocaleString("en-IN",{maximumFractionDigits:0})}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-orange-400 rounded-full" style={{ width: `${(p.revenue/maxRevenue)*100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Order pipeline */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Order Pipeline</p>
      <div className="flex gap-3 mb-6 overflow-x-auto pb-1">
        {[
          { label:"Pending", count:counts.pending, color:"bg-yellow-100 text-yellow-700" },
          { label:"Packed", count:counts.packed, color:"bg-blue-100 text-blue-700" },
          { label:"Assigned", count:counts.assigned, color:"bg-indigo-100 text-indigo-700" },
          { label:"Out for Delivery", count:counts.outForDelivery, color:"bg-purple-100 text-purple-700" },
          { label:"Delivered", count:counts.delivered, color:"bg-green-100 text-green-700" },
        ].map((f, i, arr) => (
          <div key={f.label} className="flex items-center gap-3 flex-shrink-0">
            <div className={`rounded-xl p-4 min-w-[90px] ${f.color}`}>
              <p className="text-2xl font-bold">{f.count}</p>
              <p className="text-xs font-medium opacity-80 mt-0.5">{f.label}</p>
            </div>
            {i < arr.length-1 && <span className="text-gray-300 text-xl">→</span>}
          </div>
        ))}
      </div>

      {/* Recent orders */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Recent Orders</p>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
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
            {orders.filter((o) => o.status !== "cancelled").slice(0,8).map((o) => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="px-5 py-3 font-medium text-gray-800">{o.customerName}</td>
                <td className="px-5 py-3 text-gray-500 text-xs">{o.agentName}</td>
                <td className="px-5 py-3 font-medium text-gray-800">₹{o.totalAmount.toFixed(2)}</td>
                <td className="px-5 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[o.status]||""}`}>{STATUS_LABEL[o.status]||o.status}</span></td>
                <td className="px-5 py-3 text-gray-400 text-xs">{new Date(o.createdAt).toLocaleDateString("en-IN",{day:"2-digit",month:"short"})}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {orders.length === 0 && <div className="text-center py-12 text-gray-400"><p className="text-3xl mb-2">📭</p><p>No orders yet.</p></div>}
      </div>

      {/* Stock alert modal */}
      {stockModal && (
        <StockAlertModal type={stockModal}
          products={stockModal === "out" ? outOfStock : lowStock}
          onClose={() => setStockModal(null)}
          onGoToProducts={() => { setStockModal(null); navigate("/products"); }} />
      )}

      {/* Overdue due modal */}
      {overdueModal && (
        <OverdueDueModal
          overdueList={overdueList}
          onClose={() => setOverdueModal(false)}
          onGoToCustomers={() => { setOverdueModal(false); navigate("/customers"); }}
        />
      )}
    </div>
  );
}

function StockAlertModal({ type, products, onClose, onGoToProducts }: {
  type:"low"|"out"; products:Product[]; onClose:()=>void; onGoToProducts:()=>void;
}) {
  const isOut = type === "out";
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className={`flex items-center justify-between px-6 py-4 rounded-t-2xl ${isOut ? "bg-red-50 border-b border-red-100" : "bg-yellow-50 border-b border-yellow-100"}`}>
          <div>
            <h3 className={`text-lg font-bold ${isOut ? "text-red-700" : "text-yellow-700"}`}>{isOut ? "🚫 Out of Stock" : "⚠️ Low Stock"}</h3>
            <p className={`text-sm mt-0.5 ${isOut ? "text-red-500" : "text-yellow-600"}`}>{products.length} product{products.length !== 1 ? "s" : ""}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide sticky top-0">
              <tr><th className="px-5 py-3 text-left">Product</th><th className="px-5 py-3 text-left">Category</th><th className="px-5 py-3 text-right">Stock</th><th className="px-5 py-3 text-right">Min</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-5 py-3 text-gray-500">{p.category||"—"}</td>
                  <td className="px-5 py-3 text-right"><span className={`font-bold ${p.stock <= 0 ? "text-red-600" : "text-yellow-600"}`}>{p.stock} {p.unit}</span></td>
                  <td className="px-5 py-3 text-right text-gray-400 text-xs">{p.minStockAlert} {p.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Close</button>
          <button onClick={onGoToProducts} className={`flex-1 text-white py-2.5 rounded-xl text-sm font-semibold ${isOut ? "bg-red-500 hover:bg-red-600" : "bg-yellow-500 hover:bg-yellow-600"}`}>Go to Products →</button>
        </div>
      </div>
    </div>
  );
}
// ── Overdue Due Modal ─────────────────────────────────────────────
function OverdueDueModal({ overdueList, onClose, onGoToCustomers }: {
  overdueList: OverdueCustomer[];
  onClose: () => void;
  onGoToCustomers: () => void;
}) {
  const totalDue = overdueList.reduce((s, o) => s + o.dueAmount, 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 rounded-t-2xl bg-orange-50 border-b border-orange-100 flex-shrink-0">
          <div>
            <h3 className="text-lg font-bold text-orange-700">🔔 Overdue Balances · 30+ Days</h3>
            <p className="text-sm text-orange-500 mt-0.5">
              {overdueList.length} customer{overdueList.length !== 1 ? "s" : ""} · Total ₹{totalDue.toLocaleString("en-IN", { maximumFractionDigits: 2 })} pending
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide sticky top-0">
              <tr>
                <th className="px-5 py-3 text-left">Shop</th>
                <th className="px-5 py-3 text-left">Phone</th>
                <th className="px-5 py-3 text-right">Due Amount</th>
                <th className="px-5 py-3 text-right">Days Overdue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {overdueList.map((o) => {
                const urgency =
                  o.daysOverdue >= 90 ? "text-red-600 bg-red-50" :
                  o.daysOverdue >= 60 ? "text-orange-600 bg-orange-50" :
                  "text-yellow-600 bg-yellow-50";
                return (
                  <tr key={o.customer.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3">
                      <p className="font-medium text-gray-800">{o.customer.shopName}</p>
                      <p className="text-xs text-gray-400">{o.customer.ownerName}</p>
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-xs">{o.customer.phone}</td>
                    <td className="px-5 py-3 text-right font-bold text-red-600">
                      ₹{o.dueAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${urgency}`}>
                        {o.daysOverdue}d overdue
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 border-t border-gray-200">
              <tr>
                <td colSpan={2} className="px-5 py-3 text-xs font-semibold text-gray-500">Total Overdue</td>
                <td className="px-5 py-3 text-right font-bold text-red-600">
                  ₹{totalDue.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
            Close
          </button>
          <button onClick={onGoToCustomers} className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600">
            Go to Customers →
          </button>
        </div>
      </div>
    </div>
  );
}