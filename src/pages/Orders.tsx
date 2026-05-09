import { useEffect, useState } from "react";
import {
  collection, onSnapshot, doc, updateDoc, orderBy, query
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, AppUser } from "../types";
import { useAuthStore } from "../store/authStore";
import { generateInvoicePDF, generateGSTInvoice, generateEstimateInvoice } from "../utils/invoice";
import { Customer, InvoiceType, BillingMode } from "../types";

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  packed: "bg-blue-100 text-blue-700",
  assigned: "bg-indigo-100 text-indigo-700",
  out_for_delivery: "bg-purple-100 text-purple-700",
  delivered: "bg-green-100 text-green-700",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  packed: "Packed",
  assigned: "Assigned",
  out_for_delivery: "Out for Delivery",
  delivered: "Delivered",
};

export default function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [deliveryUsers, setDeliveryUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [invoiceOrder, setInvoiceOrder] = useState<Order | null>(null);
  const { user } = useAuthStore();
  // Both admin and packing_staff can manage orders
  const canManageOrders = user?.role === "admin" || user?.role === "packing_staff";
  const [activeTab, setActiveTab] = useState<"all" | "pending" | "packed" | "assigned" | "out_for_delivery" | "delivered">("all");

  useEffect(() => {
    // Real-time listener for orders
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
      setLoading(false);
    });

    // Fetch delivery users once
    const usersQ = query(collection(db, "users"));
    const unsubUsers = onSnapshot(usersQ, (snap) => {
      const users = snap.docs.map((d) => d.data() as AppUser);
      setDeliveryUsers(users.filter((u) => u.role === "delivery"));
    });

    return () => { unsub(); unsubUsers(); };
  }, []);

  const markPacked = async (orderId: string) => {
    await updateDoc(doc(db, "orders", orderId), {
      status: "packed",
      packedAt: new Date().toISOString(),
    });
  };

  // Fixed: assign sets status to 'assigned', NOT 'out_for_delivery'
  const assignDelivery = async (
    orderId: string,
    deliveryPerson: AppUser,
    vehicleNumber: string
  ) => {
    await updateDoc(doc(db, "orders", orderId), {
      deliveryPersonId: deliveryPerson.uid,
      deliveryPersonName: deliveryPerson.name,
      vehicleNumber,
      status: "assigned",           // agent must confirm collection to move forward
      assignedAt: new Date().toISOString(),
    });
    setSelectedOrder(null);
  };

  const filteredOrders =
    activeTab === "all" ? orders : orders.filter((o) => o.status === activeTab);

  const tabCounts = {
    all: orders.length,
    pending: orders.filter((o) => o.status === "pending").length,
    packed: orders.filter((o) => o.status === "packed").length,
    assigned: orders.filter((o) => o.status === "assigned").length,
    out_for_delivery: orders.filter((o) => o.status === "out_for_delivery").length,
    delivered: orders.filter((o) => o.status === "delivered").length,
  };

  if (loading) return <div className="p-8 text-gray-400">Loading orders...</div>;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-2xl font-bold text-gray-800">Orders</h2>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block"></span>
          Live
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {(["all", "pending", "packed", "assigned", "out_for_delivery", "delivered"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeTab === tab
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-500 hover:bg-gray-100 border border-gray-200"
            }`}
          >
            {tab === "all" ? "All" : STATUS_LABELS[tab]}
            <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${
              activeTab === tab ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"
            }`}>
              {tabCounts[tab]}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left">
            <tr>
              <th className="px-5 py-4">Customer</th>
              <th className="px-5 py-4">Agent</th>
              <th className="px-5 py-4">Amount</th>
              <th className="px-5 py-4">Status</th>
              <th className="px-5 py-4">Delivery Agent</th>
              <th className="px-5 py-4">Date</th>
              <th className="px-5 py-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filteredOrders.map((order) => (
              <tr key={order.id} className="hover:bg-gray-50">
                <td className="px-5 py-3">
                  <p className="font-medium text-gray-800">{order.customerName}</p>
                  <p className="text-xs text-gray-400">{order.customerAddress?.slice(0, 35)}{order.customerAddress?.length > 35 ? "…" : ""}</p>
                </td>
                <td className="px-5 py-3 text-gray-600">{order.agentName}</td>
                <td className="px-5 py-3 font-medium text-gray-800">₹{order.totalAmount.toFixed(2)}</td>
                <td className="px-5 py-3">
                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[order.status]}`}>
                    {STATUS_LABELS[order.status]}
                  </span>
                </td>
                <td className="px-5 py-3 text-gray-500 text-xs">
                  {order.deliveryPersonName
                    ? <><p className="font-medium text-gray-700">{order.deliveryPersonName}</p><p>{order.vehicleNumber}</p></>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-5 py-3 text-gray-400 text-xs">
                  {new Date(order.createdAt).toLocaleDateString("en-IN")}
                </td>
                <td className="px-5 py-3">
                  <div className="flex gap-2 flex-wrap">
                    {order.status === "pending" && (
                      <button
                        onClick={() => markPacked(order.id!)}
                        className="bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-blue-600"
                      >
                        Mark Packed
                      </button>
                    )}
                    {order.status === "packed" && (
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-600"
                      >
                        Assign Agent
                      </button>
                    )}
                    {order.status === "assigned" && (
                      <span className="text-xs text-indigo-500 font-medium">
                        Waiting for collection
                      </span>
                    )}
                    <button
                      onClick={() => setInvoiceOrder(order)}
                      className="bg-orange-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-orange-600"
                    >
                      Invoice
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filteredOrders.length === 0 && (
          <div className="text-center py-12 text-gray-400">No orders in this category.</div>
        )}
      </div>

      {invoiceOrder && (
        <InvoiceModal
          order={invoiceOrder}
          onClose={() => setInvoiceOrder(null)}
        />
      )}

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

function InvoiceModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const [invoiceType, setInvoiceType] = useState<InvoiceType>("estimate");
  const [billingMode, setBillingMode] = useState<BillingMode>("without_due");
  const [customerDue, setCustomerDue] = useState("");

  const handleGenerate = () => {
    const opts = {
      invoiceType,
      billingMode,
      customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
      yourBusinessName: "WHOLESALE DEALER",
    };
    generateInvoicePDF(order, undefined, opts);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Generate Invoice</h3>
        <p className="text-sm text-gray-500 mb-5">
          {order.customerName} · ₹{order.totalAmount.toFixed(2)}
        </p>

        {/* Invoice type */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">Invoice Type</label>
          <div className="grid grid-cols-2 gap-3">
            {(["gst", "estimate"] as InvoiceType[]).map((t) => (
              <button
                key={t}
                onClick={() => setInvoiceType(t)}
                className={`p-3 rounded-xl border-2 text-left transition-all ${
                  invoiceType === t ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                }`}
              >
                <p className="font-semibold text-sm text-gray-800">
                  {t === "gst" ? "🧾 Tax Invoice" : "📄 Estimate Bill"}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t === "gst" ? "With CGST + SGST breakdown" : "No GST, simple format"}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Billing mode */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">Outstanding Due</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setBillingMode("without_due")}
              className={`p-3 rounded-xl border-2 text-left transition-all ${
                billingMode === "without_due" ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <p className="font-semibold text-sm text-gray-800">Current bill only</p>
              <p className="text-xs text-gray-400 mt-0.5">Due tracked internally</p>
            </button>
            <button
              onClick={() => setBillingMode("with_due")}
              className={`p-3 rounded-xl border-2 text-left transition-all ${
                billingMode === "with_due" ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
              }`}
            >
              <p className="font-semibold text-sm text-gray-800">Show with due</p>
              <p className="text-xs text-gray-400 mt-0.5">Grand total on bill</p>
            </button>
          </div>
        </div>

        {billingMode === "with_due" && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Previous Outstanding Amount (₹)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={customerDue}
              onChange={(e) => setCustomerDue(e.target.value)}
              placeholder="e.g. 1500"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm font-semibold hover:bg-orange-600"
          >
            Download PDF
          </button>
        </div>
      </div>
    </div>
  );
}


function AssignDeliveryModal({
  order, deliveryUsers, onAssign, onClose,
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
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Assign Delivery Agent</h3>
        <p className="text-sm text-gray-500 mb-4">
          Order for: <strong>{order.customerName}</strong> · ₹{order.totalAmount.toFixed(2)}
        </p>

        <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700 mb-4">
          ℹ️ Status will become <strong>Assigned</strong>. It moves to <strong>Out for Delivery</strong> only after the delivery agent confirms collection in their app.
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Agent</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              onChange={(e) => {
                const person = deliveryUsers.find((u) => u.uid === e.target.value);
                setSelectedPerson(person || null);
              }}
            >
              <option value="">— Select agent —</option>
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
              onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
              placeholder="TN 01 AB 1234"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              selectedPerson && vehicleNumber && onAssign(order.id!, selectedPerson, vehicleNumber)
            }
            disabled={!selectedPerson || !vehicleNumber}
            className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50"
          >
            Assign
          </button>
        </div>
      </div>
    </div>
  );
}
