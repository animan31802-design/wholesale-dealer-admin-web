import { useEffect, useState } from "react";
import { collection, getDocs, query, orderBy, limit, where } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order } from "../types";

interface Stats {
  totalOrders: number;
  pendingOrders: number;
  packedOrders: number;
  deliveredOrders: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({ totalOrders: 0, pendingOrders: 0, packedOrders: 0, deliveredOrders: 0 });
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const ordersSnap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
        const orders = ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Order));

        setStats({
          totalOrders: orders.length,
          pendingOrders: orders.filter((o) => o.status === "pending").length,
          packedOrders: orders.filter((o) => o.status === "packed").length,
          deliveredOrders: orders.filter((o) => o.status === "delivered").length,
        });
        setRecentOrders(orders.slice(0, 5));
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const statusColor: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-700",
    packed: "bg-blue-100 text-blue-700",
    out_for_delivery: "bg-purple-100 text-purple-700",
    delivered: "bg-green-100 text-green-700",
  };

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Dashboard</h2>

      {loading ? (
        <p className="text-gray-400">Loading...</p>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
            {[
              { label: "Total Orders", value: stats.totalOrders, color: "bg-orange-500", icon: "📦" },
              { label: "Pending", value: stats.pendingOrders, color: "bg-yellow-500", icon: "⏳" },
              { label: "Packed", value: stats.packedOrders, color: "bg-blue-500", icon: "📫" },
              { label: "Delivered", value: stats.deliveredOrders, color: "bg-green-500", icon: "✅" },
            ].map((stat) => (
              <div key={stat.label} className="bg-white rounded-xl shadow-sm p-6 flex items-center gap-4">
                <div className={`${stat.color} text-white rounded-full w-12 h-12 flex items-center justify-center text-xl`}>
                  {stat.icon}
                </div>
                <div>
                  <p className="text-sm text-gray-500">{stat.label}</p>
                  <p className="text-2xl font-bold text-gray-800">{stat.value}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Recent Orders */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h3 className="text-lg font-semibold text-gray-700 mb-4">Recent Orders</h3>
            {recentOrders.length === 0 ? (
              <p className="text-gray-400 text-sm">No orders yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="pb-3">Customer</th>
                    <th className="pb-3">Agent</th>
                    <th className="pb-3">Amount</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recentOrders.map((order) => (
                    <tr key={order.id}>
                      <td className="py-3 font-medium text-gray-800">{order.customerName}</td>
                      <td className="py-3 text-gray-600">{order.agentName}</td>
                      <td className="py-3 text-gray-800">₹{order.totalAmount.toFixed(2)}</td>
                      <td className="py-3">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor[order.status]}`}>
                          {order.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="py-3 text-gray-500">{new Date(order.createdAt).toLocaleDateString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
