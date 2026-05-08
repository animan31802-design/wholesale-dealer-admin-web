import { useEffect, useState } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order } from "../types";

interface Stats {
  todayOrders: number;
  todayRevenue: number;
  pending: number;
  packed: number;
  assigned: number;
  outForDelivery: number;
  delivered: number;
  totalDue: number;
}

const EMPTY_STATS: Stats = {
  todayOrders: 0, todayRevenue: 0,
  pending: 0, packed: 0, assigned: 0,
  outForDelivery: 0, delivered: 0, totalDue: 0,
};

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  packed: "bg-blue-100 text-blue-700",
  assigned: "bg-indigo-100 text-indigo-700",
  out_for_delivery: "bg-purple-100 text-purple-700",
  delivered: "bg-green-100 text-green-700",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending", packed: "Packed", assigned: "Assigned",
  out_for_delivery: "Out for Delivery", delivered: "Delivered",
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order));
      const today = new Date().toDateString();
      const todayOrders = orders.filter((o) => new Date(o.createdAt).toDateString() === today);

      setStats({
        todayOrders: todayOrders.length,
        todayRevenue: todayOrders.reduce((s, o) => s + o.totalAmount, 0),
        pending:        orders.filter((o) => o.status === "pending").length,
        packed:         orders.filter((o) => o.status === "packed").length,
        assigned:       orders.filter((o) => o.status === "assigned").length,
        outForDelivery: orders.filter((o) => o.status === "out_for_delivery").length,
        delivered:      orders.filter((o) => o.status === "delivered").length,
        totalDue: 0, // populated from customers collection if needed
      });
      setRecentOrders(orders.slice(0, 8));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  if (loading) return <div className="p-8 text-gray-400">Loading dashboard...</div>;

  const stat = (label: string, value: string | number, icon: string, bg: string, sub?: string) => (
    <div className="bg-white rounded-2xl shadow-sm p-5 flex items-start gap-4">
      <div className={`${bg} rounded-xl w-11 h-11 flex items-center justify-center text-xl flex-shrink-0`}>{icon}</div>
      <div>
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        <p className="text-2xl font-bold text-gray-800 leading-tight">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );

  const flow = (label: string, count: number, color: string) => (
    <div className={`flex-1 rounded-xl p-4 ${color}`}>
      <p className="text-2xl font-bold">{count}</p>
      <p className="text-xs font-medium opacity-80 mt-0.5">{label}</p>
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Dashboard</h2>
          <p className="text-sm text-gray-400 mt-0.5">{new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-green-50 px-3 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"></span>
          Live updates
        </div>
      </div>

      {/* Today's numbers */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Today</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {stat("Orders Today",   stats.todayOrders,                      "📦", "bg-orange-100")}
        {stat("Revenue Today",  `₹${stats.todayRevenue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`, "💰", "bg-green-100")}
        {stat("Pending Packing", stats.pending,                         "⏳", "bg-yellow-100", "Needs packing")}
        {stat("Out for Delivery", stats.outForDelivery,                 "🚚", "bg-purple-100", "On the road")}
      </div>

      {/* Order pipeline */}
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Order Pipeline</p>
      <div className="flex gap-3 mb-6 overflow-x-auto pb-1">
        {flow("Pending",        stats.pending,        "bg-yellow-100 text-yellow-700")}
        <div className="flex items-center text-gray-300 text-xl">→</div>
        {flow("Packed",         stats.packed,         "bg-blue-100 text-blue-700")}
        <div className="flex items-center text-gray-300 text-xl">→</div>
        {flow("Assigned",       stats.assigned,       "bg-indigo-100 text-indigo-700")}
        <div className="flex items-center text-gray-300 text-xl">→</div>
        {flow("Out for Delivery", stats.outForDelivery, "bg-purple-100 text-purple-700")}
        <div className="flex items-center text-gray-300 text-xl">→</div>
        {flow("Delivered",      stats.delivered,      "bg-green-100 text-green-700")}
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
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[order.status]}`}>
                    {STATUS_LABEL[order.status]}
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
            <p>No orders yet. Orders from field agents will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
