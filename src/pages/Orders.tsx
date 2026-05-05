import { useEffect, useState } from "react";
import { collection, getDocs, doc, updateDoc, orderBy, query } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, AppUser } from "../types";
import { generateInvoicePDF } from "../utils/invoice";

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [deliveryUsers, setDeliveryUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  const fetchOrders = async () => {
    const snap = await getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")));
    setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
  };

  useEffect(() => {
    const fetchAll = async () => {
      await fetchOrders();
      const usersSnap = await getDocs(collection(db, "users"));
      const users = usersSnap.docs.map((d) => d.data() as AppUser);
      setDeliveryUsers(users.filter((u) => u.role === "delivery"));
      setLoading(false);
    };
    fetchAll();
  }, []);

  const updateStatus = async (orderId: string, status: string, extra?: object) => {
    await updateDoc(doc(db, "orders", orderId), {
      status,
      ...(status === "packed" ? { packedAt: new Date().toISOString() } : {}),
      ...(status === "delivered" ? { deliveredAt: new Date().toISOString() } : {}),
      ...extra,
    });
    await fetchOrders();
  };

  const assignDelivery = async (orderId: string, deliveryPerson: AppUser, vehicleNumber: string) => {
    await updateDoc(doc(db, "orders", orderId), {
      deliveryPersonId: deliveryPerson.uid,
      deliveryPersonName: deliveryPerson.name,
      vehicleNumber,
      status: "out_for_delivery",
    });
    await fetchOrders();
    setSelectedOrder(null);
  };

  const statusColor: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-700",
    packed: "bg-blue-100 text-blue-700",
    out_for_delivery: "bg-purple-100 text-purple-700",
    delivered: "bg-green-100 text-green-700",
  };

  if (loading) return <div className="p-8 text-gray-400">Loading orders...</div>;

  return (
    <div className="p-8">
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Orders</h2>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left">
            <tr>
              <th className="px-6 py-4">Customer</th>
              <th className="px-6 py-4">Agent</th>
              <th className="px-6 py-4">Amount</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4">Date</th>
              <th className="px-6 py-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {orders.map((order) => (
              <tr key={order.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 font-medium text-gray-800">{order.customerName}</td>
                <td className="px-6 py-4 text-gray-600">{order.agentName}</td>
                <td className="px-6 py-4 text-gray-800">₹{order.totalAmount.toFixed(2)}</td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusColor[order.status]}`}>
                    {order.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-6 py-4 text-gray-500">{new Date(order.createdAt).toLocaleDateString("en-IN")}</td>
                <td className="px-6 py-4 flex gap-2 flex-wrap">
                  {order.status === "pending" && (
                    <button
                      onClick={() => updateStatus(order.id!, "packed")}
                      className="bg-blue-500 text-white text-xs px-3 py-1 rounded-lg hover:bg-blue-600"
                    >
                      Mark Packed
                    </button>
                  )}
                  {order.status === "packed" && (
                    <button
                      onClick={() => setSelectedOrder(order)}
                      className="bg-purple-500 text-white text-xs px-3 py-1 rounded-lg hover:bg-purple-600"
                    >
                      Assign Delivery
                    </button>
                  )}
                  <button
                    onClick={() => generateInvoicePDF(order)}
                    className="bg-orange-500 text-white text-xs px-3 py-1 rounded-lg hover:bg-orange-600"
                  >
                    Invoice PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {orders.length === 0 && (
          <div className="text-center py-12 text-gray-400">No orders yet.</div>
        )}
      </div>

      {/* Assign Delivery Modal */}
      {selectedOrder && (
        <AssignDeliveryModal
          order={selectedOrder}
          deliveryUsers={deliveryUsers}
          onAssign={assignDelivery}
          onClose={() => setSelectedOrder(null)}
        />
      )}
    </div>
  );
}

function AssignDeliveryModal({
  order,
  deliveryUsers,
  onAssign,
  onClose,
}: {
  order: Order;
  deliveryUsers: AppUser[];
  onAssign: (orderId: string, person: AppUser, vehicle: string) => void;
  onClose: () => void;
}) {
  const [selectedPerson, setSelectedPerson] = useState<AppUser | null>(null);
  const [vehicleNumber, setVehicleNumber] = useState("");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Assign Delivery</h3>
        <p className="text-sm text-gray-500 mb-4">Order for: <strong>{order.customerName}</strong></p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Select Delivery Person</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              onChange={(e) => {
                const person = deliveryUsers.find((u) => u.uid === e.target.value);
                setSelectedPerson(person || null);
              }}
            >
              <option value="">-- Select --</option>
              {deliveryUsers.map((u) => (
                <option key={u.uid} value={u.uid}>{u.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle Number</label>
            <input
              type="text"
              value={vehicleNumber}
              onChange={(e) => setVehicleNumber(e.target.value)}
              placeholder="TN 01 AB 1234"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={() => selectedPerson && vehicleNumber && onAssign(order.id!, selectedPerson, vehicleNumber)}
            disabled={!selectedPerson || !vehicleNumber}
            className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50"
          >
            Assign & Send
          </button>
        </div>
      </div>
    </div>
  );
}
