import { useEffect, useState, useMemo } from "react";
import {
  collection, onSnapshot, doc, updateDoc, orderBy, query, getDoc, runTransaction,
  getDocs
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, AppUser } from "../types";
import { useAuthStore } from "../store/authStore";
import { buildInvoicePDF } from "../utils/invoice";
import Pagination from "../components/Pagination";
import { Customer, InvoiceType, BillingMode } from "../types";

const STATUS_COLORS: Record<string, string> = {
  pending:          "bg-yellow-100 text-yellow-700",
  packed:           "bg-blue-100 text-blue-700",
  assigned:         "bg-indigo-100 text-indigo-700",
  out_for_delivery: "bg-purple-100 text-purple-700",
  delivered:        "bg-green-100 text-green-700",
  cancelled:        "bg-gray-100 text-gray-500",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending", packed: "Packed", assigned: "Assigned",
  out_for_delivery: "Out for Delivery", delivered: "Delivered",
  cancelled: "Cancelled",
};

export default function Orders() {
  const [orders, setOrders]             = useState<Order[]>([]);
  const [allUsers, setAllUsers]         = useState<AppUser[]>([]);
  const [loading, setLoading]           = useState(true);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [invoiceOrder, setInvoiceOrder] = useState<Order | null>(null);
  const [detailOrder, setDetailOrder]   = useState<Order | null>(null);
  const [cancelOrder, setCancelOrder]   = useState<Order | null>(null);
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [showBulkAssign, setShowBulkAssign] = useState(false);
  const { user } = useAuthStore();

  // ── Filter state ─────────────────────────────────────────────
  const [activeTab, setActiveTab]   = useState<"all"|"pending"|"packed"|"assigned"|"out_for_delivery"|"delivered"|"cancelled">("all");
  const [search, setSearch]         = useState("");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterDelivery, setFilterDelivery] = useState("");
  const [dateFrom, setDateFrom]     = useState("");
  const [dateTo, setDateTo]         = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
      setLoading(false);
    });
    getDocs(query(collection(db, "users"))).then((snap) => {
      setAllUsers(snap.docs.map((d) => d.data() as AppUser));
    });
    return () => { unsub(); };
  }, []);

  const deliveryUsers  = allUsers.filter((u) => u.role === "delivery");
  const fieldAgents    = [...new Map(orders.map((o) => [o.agentId, { id: o.agentId, name: o.agentName }])).values()];
  const regions        = [...new Set(orders.map((o) => o.regionName).filter(Boolean))];

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allPackedSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        packedInView.forEach((o) => next.delete(o.id!));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        packedInView.forEach((o) => next.add(o.id!));
        return next;
      });
    }
  };

  const markPacked = async (orderId: string) => {
    await updateDoc(doc(db, "orders", orderId), {
      status: "packed",
      packedAt: new Date().toISOString(),
      packedBy: user?.uid,
      packedByName: user?.name,
    });
  };

  const bulkAssignDelivery = async (person: AppUser, vehicle: string) => {
    const ids = [...selectedIds].filter((id) =>
      orders.find((o) => o.id === id)?.status === "packed"
    );
    await Promise.all(
      ids.map((id) =>
        updateDoc(doc(db, "orders", id), {
          deliveryPersonId:   person.uid,
          deliveryPersonName: person.name,
          vehicleNumber:      vehicle,
          status:             "assigned",
          assignedAt:         new Date().toISOString(),
        })
      )
    );
    setSelectedIds(new Set());
    setShowBulkAssign(false);
  };

  const assignDelivery = async (orderId: string, person: AppUser, vehicle: string) => {
    await updateDoc(doc(db, "orders", orderId), {
      deliveryPersonId: person.uid, deliveryPersonName: person.name,
      vehicleNumber: vehicle, status: "assigned",
      assignedAt: new Date().toISOString(),
    });
    setSelectedOrder(null);
  };

  // ── Filtering logic ──────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = activeTab === "all" ? orders : orders.filter((o) => o.status === activeTab);

    if (search.trim()) {
      const s = search.toLowerCase();
      list = list.filter((o) =>
        o.customerName.toLowerCase().includes(s) ||
        o.agentName.toLowerCase().includes(s) ||
        (o.id || "").toLowerCase().includes(s) ||
        (o.deliveryPersonName || "").toLowerCase().includes(s) ||
        o.items.some((i) => i.productName.toLowerCase().includes(s))
      );
    }
    if (filterAgent)    list = list.filter((o) => o.agentId === filterAgent);
    if (filterRegion)   list = list.filter((o) => o.regionName === filterRegion);
    if (filterDelivery) list = list.filter((o) => o.deliveryPersonId === filterDelivery);
    if (dateFrom)       list = list.filter((o) => o.createdAt >= dateFrom);
    if (dateTo)         list = list.filter((o) => o.createdAt <= dateTo + "T23:59:59");

    return list;
  }, [orders, activeTab, search, filterAgent, filterRegion, filterDelivery, dateFrom, dateTo]);

  const tabCounts = {
    all:              orders.length,
    pending:          orders.filter((o) => o.status === "pending").length,
    packed:           orders.filter((o) => o.status === "packed").length,
    assigned:         orders.filter((o) => o.status === "assigned").length,
    out_for_delivery: orders.filter((o) => o.status === "out_for_delivery").length,
    delivered:        orders.filter((o) => o.status === "delivered").length,
    cancelled:        orders.filter((o) => o.status === "cancelled").length,
  };

  const hasActiveFilters = search || filterAgent || filterRegion || filterDelivery || dateFrom || dateTo;

  // Reset to page 1 and clear selection whenever filters/tab change
  useEffect(() => { setPage(1); setSelectedIds(new Set()); }, [activeTab, search, filterAgent, filterRegion, filterDelivery, dateFrom, dateTo]);

  const clearFilters = () => {
    setSearch(""); setFilterAgent(""); setFilterRegion("");
    setFilterDelivery(""); setDateFrom(""); setDateTo(""); setPage(1);
  };

  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // Only packed orders can be bulk assigned
  const packedInView = paginated.filter((o) => o.status === "packed");
  const allPackedSelected = packedInView.length > 0 && packedInView.every((o) => selectedIds.has(o.id!));

  if (loading) return <div className="p-8 text-gray-400">Loading orders...</div>;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-800">Orders</h2>
        <div className="flex items-center gap-3">
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs text-red-500 hover:text-red-700 underline">
              Clear filters
            </button>
          )}
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            Live
          </div>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {(["all","pending","packed","assigned","out_for_delivery","delivered","cancelled"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeTab === tab
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-500 hover:bg-gray-100 border border-gray-200"
            }`}
          >
            {tab === "all" ? "All" : STATUS_LABELS[tab]}
            <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${
              activeTab === tab ? "bg-white/20 text-white" : "bg-gray-100 text-gray-500"
            }`}>{tabCounts[tab]}</span>
          </button>
        ))}
      </div>

      {/* Search + Filter bar */}
      <div className="flex gap-2 mb-3 flex-wrap items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, agent, product, order ID..."
            className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
          />
          {search && (
            <button onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">✕</button>
          )}
        </div>

        {/* Toggle advanced filters */}
        <button
          onClick={() => setShowFilters((p) => !p)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition-all ${
            showFilters || (filterAgent || filterRegion || filterDelivery || dateFrom || dateTo)
              ? "bg-orange-100 text-orange-700 border-orange-300"
              : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
          }`}
        >
          ⚙️ Filters
          {(filterAgent || filterRegion || filterDelivery || dateFrom || dateTo) && (
            <span className="w-2 h-2 rounded-full bg-orange-500 inline-block" />
          )}
        </button>

        {/* Result count */}
        <span className="text-xs text-gray-400">
          {filtered.length} of {orders.length} orders
        </span>
      </div>

      {/* Advanced filters panel */}
      {showFilters && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Field Agent</label>
            <select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}
              className={sel}>
              <option value="">All Agents</option>
              {fieldAgents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Region</label>
            <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)}
              className={sel}>
              <option value="">All Regions</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Delivery Agent</label>
            <select value={filterDelivery} onChange={(e) => setFilterDelivery(e.target.value)}
              className={sel}>
              <option value="">All</option>
              {deliveryUsers.map((u) => <option key={u.uid} value={u.uid}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">From Date</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className={sel} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">To Date</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className={sel} />
          </div>
        </div>
      )}

      {/* Table */}
      {/* Bulk assign toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-xl px-5 py-3 mb-3">
          <div className="flex items-center gap-3">
            <span className="w-6 h-6 rounded-full bg-indigo-500 text-white text-xs font-bold flex items-center justify-center">
              {selectedIds.size}
            </span>
            <span className="text-sm font-medium text-indigo-700">
              {selectedIds.size} packed order{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-indigo-500 hover:text-indigo-700 px-3 py-1.5 rounded-lg hover:bg-indigo-100"
            >
              Clear
            </button>
            <button
              onClick={() => setShowBulkAssign(true)}
              className="bg-indigo-500 text-white text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-indigo-600"
            >
              🚚 Assign All to Delivery Agent
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-4 w-10">
                {packedInView.length > 0 && (
                  <input
                    type="checkbox"
                    checked={allPackedSelected}
                    onChange={toggleSelectAll}
                    onClick={(e) => e.stopPropagation()}
                    className="w-4 h-4 rounded accent-orange-500 cursor-pointer"
                    title="Select all packed orders"
                  />
                )}
              </th>
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
            {paginated.map((order) => (
              <tr key={order.id} className={`hover:bg-gray-50 cursor-pointer ${selectedIds.has(order.id!) ? "bg-orange-50" : ""}`} onClick={() => setDetailOrder(order)}>
                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                  {order.status === "packed" && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(order.id!)}
                      onChange={(e) => toggleSelect(order.id!, e as any)}
                      className="w-4 h-4 rounded accent-orange-500 cursor-pointer"
                    />
                  )}
                </td>
                <td className="px-5 py-3">
                  <p className="font-medium text-gray-800">{order.customerName}</p>
                  <p className="text-xs text-gray-400">
                    {order.customerAddress?.slice(0, 35)}{(order.customerAddress?.length ?? 0) > 35 ? "…" : ""}
                  </p>
                </td>
                <td className="px-5 py-3 text-gray-600 text-xs">{order.agentName}</td>
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
                  <div className="flex gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                    {order.status === "pending" && (
                      <button onClick={() => markPacked(order.id!)}
                        className="bg-blue-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-blue-600">
                        Mark Packed
                      </button>
                    )}
                    {order.status === "packed" && (
                      <button onClick={() => setSelectedOrder(order)}
                        className="bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-600">
                        Assign Agent
                      </button>
                    )}
                    {order.status === "assigned" && (
                      <span className="text-xs text-indigo-500 font-medium">Waiting for collection</span>
                    )}
                    {(order.status === "pending" || order.status === "packed") && (
                      <button onClick={(e) => { e.stopPropagation(); setCancelOrder(order); }}
                        className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">
                        Cancel
                      </button>
                    )}
                    {order.status === "delivered" &&
                      order.amountCollected !== undefined &&
                      order.amountCollected < order.totalAmount && (
                      <span className="bg-red-100 text-red-600 text-xs px-2 py-1 rounded-lg font-medium">
                        ₹{(order.totalAmount - order.amountCollected).toFixed(2)} due
                      </span>
                    )}
                    <button onClick={() => setInvoiceOrder(order)}
                      className="bg-orange-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-orange-600">
                      🧾 Invoice
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            {hasActiveFilters ? "No orders match your filters." : "No orders in this category."}
          </div>
        )}
        <Pagination total={filtered.length} page={page} perPage={PER_PAGE} onPage={setPage} />
      </div>

      {showBulkAssign && (
        <BulkAssignModal
          count={selectedIds.size}
          deliveryUsers={deliveryUsers}
          onAssign={bulkAssignDelivery}
          onClose={() => setShowBulkAssign(false)}
        />
      )}

      {cancelOrder && (
        <CancelOrderModal
          order={cancelOrder}
          onClose={() => setCancelOrder(null)}
          onCancelled={() => { setCancelOrder(null); setDetailOrder(null); }}
        />
      )}

      {detailOrder && (
        <OrderDetailPanel
          order={detailOrder}
          onClose={() => setDetailOrder(null)}
          onMarkPacked={(id) => { markPacked(id); setDetailOrder(null); }}
          onAssignAgent={(o) => { setSelectedOrder(o); setDetailOrder(null); }}
          onInvoice={(o) => { setInvoiceOrder(o); }}
          onCancel={(o) => { setCancelOrder(o); }}
          deliveryUsers={deliveryUsers}
        />
      )}
      {invoiceOrder && (
        <InvoiceModal order={invoiceOrder} onClose={() => setInvoiceOrder(null)} />
      )}
      {selectedOrder && (
        <AssignDeliveryModal order={selectedOrder} deliveryUsers={deliveryUsers}
          onAssign={assignDelivery} onClose={() => setSelectedOrder(null)} />
      )}
    </div>
  );
}

// ── Invoice Modal — preview in browser, option to download ───────
function InvoiceModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const [invoiceType, setInvoiceType] = useState<InvoiceType>("estimate");
  const [billingMode, setBillingMode] = useState<BillingMode>("without_due");
  const [customerDue, setCustomerDue]     = useState("");
  const [customerData, setCustomerData]   = useState<any>(null);
  const [pdfUrl, setPdfUrl]               = useState<string | null>(null);
  const [loadingDue, setLoadingDue]       = useState(false);
  const [generating, setGenerating]       = useState(false);

  // Auto-load full customer data (GSTIN + outstanding due)
  useEffect(() => {
    if (!order.customerId) return;
    setLoadingDue(true);
    getDoc(doc(db, "customers", order.customerId)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setCustomerData(data);
        const due = data.outstandingDue || 0;
        if (due > 0) { setCustomerDue(String(due)); setBillingMode("with_due"); }
      }
      setLoadingDue(false);
    }).catch(() => setLoadingDue(false));
  }, [order.customerId]);

  // Revoke object URL on unmount
  useEffect(() => {
    return () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); };
  }, [pdfUrl]);

  const handlePreview = async () => {
    setGenerating(true);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    const pdf = await buildInvoicePDF(order, customerData || undefined, {
      invoiceType,
      billingMode,
      customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
    });
    const blob = pdf.output("blob");
    setPdfUrl(URL.createObjectURL(blob));
    setGenerating(false);
  };

  const handleDownload = async () => {
    const pdf = await buildInvoicePDF(order, customerData || undefined, {
      invoiceType,
      billingMode,
      customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
    });
    const prefix = invoiceType === "gst" ? "invoice" : "estimate";
    pdf.save(`${prefix}-${order.id?.slice(0, 8)}.pdf`);
  };

  // Reset preview when options change
  useEffect(() => { setPdfUrl(null); }, [invoiceType, billingMode, customerDue]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-2xl shadow-2xl flex flex-col transition-all ${pdfUrl ? "w-full max-w-4xl h-[90vh]" : "w-full max-w-md"}`}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Invoice</h3>
            <p className="text-sm text-gray-500">{order.customerName} · ₹{order.totalAmount.toFixed(2)}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl p-1">✕</button>
        </div>

        {/* Options — hidden when preview is showing */}
        {!pdfUrl && (
          <div className="p-6 space-y-4">
            {/* Invoice type */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Invoice Type</label>
              <div className="grid grid-cols-2 gap-3">
                {(["gst", "estimate"] as InvoiceType[]).map((t) => (
                  <button key={t} onClick={() => setInvoiceType(t)}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      invoiceType === t ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                    }`}>
                    <p className="font-semibold text-sm">{t === "gst" ? "🧾 Tax Invoice" : "📄 Estimate Bill"}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{t === "gst" ? "CGST + SGST breakdown" : "No GST, simple format"}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Billing mode */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Outstanding Due</label>
              <div className="grid grid-cols-2 gap-3">
                {(["without_due", "with_due"] as BillingMode[]).map((m) => (
                  <button key={m} onClick={() => setBillingMode(m)}
                    className={`p-3 rounded-xl border-2 text-left transition-all ${
                      billingMode === m ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                    }`}>
                    <p className="font-semibold text-sm">{m === "without_due" ? "Current bill only" : "Show with due"}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{m === "without_due" ? "Due tracked internally" : "Grand total on bill"}</p>
                  </button>
                ))}
              </div>
            </div>

            {billingMode === "with_due" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Previous Outstanding (₹)
                  {loadingDue && <span className="text-xs text-gray-400 ml-2">loading...</span>}
                </label>
                <input type="number" min="0" step="0.01"
                  value={customerDue} onChange={(e) => setCustomerDue(e.target.value)}
                  placeholder="e.g. 1500"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handlePreview} disabled={generating}
                className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-50">
                {generating ? "Generating..." : "👁️ Preview Invoice"}
              </button>
            </div>
          </div>
        )}

        {/* PDF Preview */}
        {pdfUrl && (
          <>
            <div className="flex-1 overflow-hidden">
              <iframe src={pdfUrl} className="w-full h-full border-0" title="Invoice Preview" />
            </div>
            <div className="flex gap-3 p-4 border-t border-gray-100 flex-shrink-0">
              <button onClick={() => setPdfUrl(null)}
                className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                ← Back to Options
              </button>
              <button onClick={handleDownload}
                className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600">
                ⬇️ Download PDF
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Assign Delivery Modal ─────────────────────────────────────────
function AssignDeliveryModal({ order, deliveryUsers, onAssign, onClose }: {
  order: Order; deliveryUsers: AppUser[];
  onAssign: (orderId: string, person: AppUser, vehicle: string) => void;
  onClose: () => void;
}) {
  const [selectedPerson, setSelectedPerson] = useState<AppUser | null>(null);
  const [vehicleNumber, setVehicleNumber]   = useState("");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Assign Delivery Agent</h3>
        <p className="text-sm text-gray-500 mb-4">
          Order for: <strong>{order.customerName}</strong> · ₹{order.totalAmount.toFixed(2)}
        </p>
        <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700 mb-4">
          ℹ️ Status becomes <strong>Assigned</strong>. Moves to <strong>Out for Delivery</strong> only after agent confirms collection.
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Agent</label>
            <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              onChange={(e) => setSelectedPerson(deliveryUsers.find((u) => u.uid === e.target.value) || null)}>
              <option value="">— Select agent —</option>
              {deliveryUsers.map((u) => <option key={u.uid} value={u.uid}>{u.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle Number</label>
            <input type="text" value={vehicleNumber}
              onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
              placeholder="TN 01 AB 1234"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={() => selectedPerson && vehicleNumber && onAssign(order.id!, selectedPerson, vehicleNumber)}
            disabled={!selectedPerson || !vehicleNumber}
            className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50">Assign</button>
        </div>
      </div>
    </div>
  );
}

const sel = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300";

// ── Order Detail Panel ────────────────────────────────────────────
export function OrderDetailPanel({
  order,
  onClose,
  onMarkPacked,
  onAssignAgent,
  onInvoice,
  onCancel,
  deliveryUsers,
}: {
  order: Order;
  onClose: () => void;
  onMarkPacked: (id: string) => void;
  onAssignAgent: (order: Order) => void;
  onInvoice: (order: Order) => void;
  onCancel: (order: Order) => void;
  deliveryUsers: AppUser[];
}) {
  const fmt = (iso?: string): string | undefined =>
    iso
      ? new Date(iso).toLocaleString("en-IN", {
          day: "2-digit", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        })
      : undefined;

  const timeline: { label: string; time?: string; done: boolean; color: string }[] = [
    { label: "Order Placed",       time: fmt(order.createdAt),   done: true,                              color: order.status === "cancelled" ? "bg-red-400" : "bg-yellow-400" },
    { label: "Packed",             time: fmt(order.packedAt),    done: !!order.packedAt,                  color: "bg-blue-400"   },
    { label: "Assigned to Agent",  time: fmt(order.assignedAt),  done: !!order.assignedAt,                color: "bg-indigo-400" },
    { label: "Out for Delivery",   time: undefined,              done: order.status === "out_for_delivery" || order.status === "delivered", color: "bg-purple-400" },
    { label: "Delivered",          time: fmt(order.deliveredAt), done: order.status === "delivered",       color: "bg-green-400"  },
  ];

  const balance =
    order.amountCollected !== undefined
      ? order.totalAmount - order.amountCollected
      : null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Slide-in panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-xl bg-white shadow-2xl z-50 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 bg-gray-50 flex-shrink-0">
          <div>
            <h3 className="text-lg font-bold text-gray-800">{order.customerName}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{order.customerAddress}</p>
            {order.customerPhone && (
              <a href={`tel:${order.customerPhone}`} className="text-xs text-blue-500 hover:underline">
                📞 {order.customerPhone}
              </a>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[order.status]}`}>
              {STATUS_LABELS[order.status]}
            </span>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">

          {/* Timeline */}
          <div className="px-6 py-5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">Order Timeline</p>
            <div className="space-y-3">
              {timeline.map((step, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${step.done ? step.color : "bg-gray-200"}`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${step.done ? "text-gray-800" : "text-gray-400"}`}>
                      {step.label}
                    </p>
                    {step.time && (
                      <p className="text-xs text-gray-400 mt-0.5">{step.time}</p>
                    )}
                  </div>
                  {i < timeline.length - 1 && (
                    <div className={`w-px h-4 ml-1 mt-3 ${step.done ? "bg-gray-300" : "bg-gray-100"}`} />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Order items */}
          <div className="px-6 py-5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">
              Items ({order.items.length})
            </p>
            <div className="space-y-2">
              {order.items.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-gray-800">{item.productName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {item.quantity} {item.unit} × ₹{item.price.toFixed(2)}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-gray-800">₹{item.total.toFixed(2)}</p>
                </div>
              ))}
            </div>

            {/* Totals */}
            <div className="mt-4 pt-3 border-t border-gray-200 space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Order Total</span>
                <span className="font-bold text-gray-800">₹{order.totalAmount.toFixed(2)}</span>
              </div>
              {order.amountCollected !== undefined && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Collected at Delivery</span>
                  <span className="font-medium text-green-600">₹{order.amountCollected.toFixed(2)}</span>
                </div>
              )}
              {balance !== null && balance > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-red-600 font-medium">Balance Due</span>
                  <span className="font-bold text-red-600">₹{balance.toFixed(2)}</span>
                </div>
              )}
              {order.paymentMode && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Payment Mode</span>
                  <span className="font-medium text-gray-700 capitalize">{order.paymentMode}</span>
                </div>
              )}
            </div>
          </div>

          {/* Agent & Delivery info */}
          <div className="px-6 py-5 border-b border-gray-100">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-4">Assignment</p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-400 mb-1">Field Agent</p>
                <p className="font-medium text-gray-800">{order.agentName}</p>
              </div>
              {order.deliveryPersonName && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">Delivery Agent</p>
                  <p className="font-medium text-gray-800">{order.deliveryPersonName}</p>
                </div>
              )}
              {order.vehicleNumber && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">Vehicle</p>
                  <p className="font-medium text-gray-800">{order.vehicleNumber}</p>
                </div>
              )}
              {order.packedByName && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">Packed By</p>
                  <p className="font-medium text-gray-800">{order.packedByName}</p>
                </div>
              )}
              {(order as any).regionName && (
                <div>
                  <p className="text-xs text-gray-400 mb-1">Region</p>
                  <p className="font-medium text-gray-800">{(order as any).regionName}</p>
                </div>
              )}
            </div>
          </div>

          {/* Notes */}
          {order.notes && (
            <div className="px-6 py-5 border-b border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">Notes</p>
              <p className="text-sm text-gray-600 bg-yellow-50 border border-yellow-100 rounded-lg px-3 py-2">
                {order.notes}
              </p>
            </div>
          )}

          {/* Cancellation info */}
          {order.status === "cancelled" && (
            <div className="px-6 py-5 border-b border-gray-100 bg-red-50">
              <p className="text-xs font-semibold text-red-400 uppercase tracking-widest mb-3">Cancellation Details</p>
              <div className="space-y-2 text-sm">
                {order.cancellationReason && (
                  <div>
                    <p className="text-xs text-gray-400">Reason</p>
                    <p className="text-gray-700 font-medium">{order.cancellationReason}</p>
                  </div>
                )}
                {order.cancelledByName && (
                  <div>
                    <p className="text-xs text-gray-400">Cancelled by</p>
                    <p className="text-gray-700">{order.cancelledByName}</p>
                  </div>
                )}
                {order.cancelledAt && (
                  <div>
                    <p className="text-xs text-gray-400">Cancelled at</p>
                    <p className="text-gray-700">{fmt(order.cancelledAt)}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Signature collected */}
          {(order as any).signatureCollected && (
            <div className="px-6 py-4 border-b border-gray-100">
              <p className="text-sm text-green-600 font-medium">✅ Signature collected at delivery</p>
              {(order as any).billWithAgent && (
                <p className="text-xs text-red-500 mt-1">📋 Invoice retained by delivery agent (partial payment)</p>
              )}
            </div>
          )}
        </div>

        {/* Action footer */}
        <div className="flex-shrink-0 border-t border-gray-100 px-6 py-4 bg-gray-50">
          <div className="flex gap-2 flex-wrap">
            {order.status === "pending" && (
              <button
                onClick={() => { onMarkPacked(order.id!); onClose(); }}
                className="flex-1 bg-blue-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-blue-600"
              >
                ✅ Mark Packed
              </button>
            )}
            {order.status === "packed" && (
              <button
                onClick={() => { onAssignAgent(order); onClose(); }}
                className="flex-1 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-600"
              >
                🚚 Assign Delivery Agent
              </button>
            )}
            {(order.status === "pending" || order.status === "packed") && (
              <button
                onClick={() => onCancel(order)}
                className="flex-1 bg-red-100 text-red-600 py-2.5 rounded-xl text-sm font-medium hover:bg-red-200"
              >
                🚫 Cancel Order
              </button>
            )}
            <button
              onClick={() => onInvoice(order)}
              className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-orange-600"
            >
              🧾 Invoice
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Cancel Order Modal ────────────────────────────────────────────
function CancelOrderModal({
  order,
  onClose,
  onCancelled,
}: {
  order: Order;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const { user } = useAuthStore();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCancel = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    try {
      await runTransaction(db, async (t) => {
        // ── READS FIRST ──────────────────────────────────────────
        const productRefs = order.items.map((item) =>
          doc(db, "products", item.productId)
        );
        const productSnaps = await Promise.all(productRefs.map((ref) => t.get(ref)));

        // ── WRITES AFTER ALL READS ────────────────────────────────
        productSnaps.forEach((snap, i) => {
          if (!snap.exists()) return;
          const item        = order.items[i];
          const data        = snap.data();

          // Only restore stock for tracked products
          if (!data.trackInventory) return;

          // Restore actual stock number (what admin sees in Products page)
          const newStock    = (data.stock ?? 0) + item.quantity;
          // Also reduce reservedStock if it was set
          const newReserved = Math.max(0, (data.reservedStock ?? 0) - item.quantity);

          t.update(productRefs[i], {
            stock:         newStock,
            reservedStock: newReserved,
          });
        });

        t.update(doc(db, "orders", order.id!), {
          status:             "cancelled",
          cancelledAt:        new Date().toISOString(),
          cancelledBy:        user!.uid,
          cancelledByName:    user!.name,
          cancellationReason: reason.trim(),
        });
      });

      onCancelled();
    } catch (err: any) {
      alert(err.message || "Failed to cancel order. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Cancel Order</h3>
        <p className="text-sm text-gray-500 mb-4">
          {order.customerName} · ₹{order.totalAmount.toFixed(2)}
        </p>

        <div className="bg-red-50 border border-red-100 rounded-xl p-4 mb-5">
          <p className="text-sm text-red-700 font-medium">⚠️ This will:</p>
          <ul className="text-sm text-red-600 mt-2 space-y-1 list-disc list-inside">
            <li>Mark the order as Cancelled</li>
            <li>Restore reserved stock for all {order.items.length} item{order.items.length !== 1 ? "s" : ""}</li>
            <li>Cannot be undone</li>
          </ul>
        </div>

        <div className="mb-5">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Reason for cancellation <span className="text-red-500">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Customer request, duplicate order, out of stock..."
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 resize-none"
          />
        </div>

        {/* Items being restored */}
        <div className="bg-gray-50 rounded-lg p-3 mb-5">
          <p className="text-xs font-medium text-gray-500 mb-2">Stock to be restored:</p>
          {order.items.map((item, i) => (
            <div key={i} className="flex justify-between text-xs text-gray-600 py-0.5">
              <span>{item.productName}</span>
              <span className="text-green-600 font-medium">+{item.quantity} {item.unit}</span>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50"
          >
            Keep Order
          </button>
          <button
            onClick={handleCancel}
            disabled={saving || !reason.trim()}
            className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50"
          >
            {saving ? "Cancelling..." : "Yes, Cancel Order"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk Assign Modal ─────────────────────────────────────────────
function BulkAssignModal({
  count,
  deliveryUsers,
  onAssign,
  onClose,
}: {
  count: number;
  deliveryUsers: AppUser[];
  onAssign: (person: AppUser, vehicle: string) => Promise<void>;
  onClose: () => void;
}) {
  const [selectedPerson, setSelectedPerson] = useState<AppUser | null>(null);
  const [vehicleNumber, setVehicleNumber]   = useState("");
  const [saving, setSaving]                 = useState(false);

  const handleAssign = async () => {
    if (!selectedPerson || !vehicleNumber.trim()) return;
    setSaving(true);
    try {
      await onAssign(selectedPerson, vehicleNumber.trim());
    } catch {
      alert("Failed to assign. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Bulk Assign Delivery</h3>
        <p className="text-sm text-gray-500 mb-4">
          Assigning <span className="font-semibold text-indigo-600">{count} packed order{count !== 1 ? "s" : ""}</span> to one delivery agent
        </p>

        <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 text-xs text-indigo-700 mb-5">
          ℹ️ All selected orders will be assigned to the same agent and vehicle. Status will change to <strong>Assigned</strong>. Agent must confirm collection in their app.
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Delivery Agent</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              onChange={(e) => setSelectedPerson(deliveryUsers.find((u) => u.uid === e.target.value) || null)}
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
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
        </div>

        {selectedPerson && vehicleNumber && (
          <div className="mt-4 bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-600">
            <span className="font-medium">{count} order{count !== 1 ? "s" : ""}</span> → <span className="font-medium text-indigo-600">{selectedPerson.name}</span> · {vehicleNumber}
          </div>
        )}

        <div className="flex gap-3 mt-5">
          <button
            onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleAssign}
            disabled={!selectedPerson || !vehicleNumber.trim() || saving}
            className="flex-1 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50"
          >
            {saving ? "Assigning..." : `Assign ${count} Order${count !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}