import * as XLSX from "xlsx";
import { useEffect, useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection, onSnapshot, doc, updateDoc, orderBy, query, getDoc, runTransaction,
  getDocs, where
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, AppUser } from "../types";
import { useAuthStore } from "../store/authStore";
import { buildInvoicePDF } from "../utils/invoice";
import Pagination from "../components/Pagination";
import { Customer, InvoiceType, BillingMode } from "../types";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";

const STATUS_COLORS: Record<string, string> = {
  pending:                "bg-yellow-100 text-yellow-700",
  packed:                 "bg-blue-100 text-blue-700",
  assigned:               "bg-indigo-100 text-indigo-700",
  out_for_delivery:       "bg-purple-100 text-purple-700",
  attempted:              "bg-orange-100 text-orange-700",
  returned_to_warehouse:  "bg-red-100 text-red-700",
  delivered:              "bg-green-100 text-green-700",
  cancelled:              "bg-gray-100 text-gray-500",
};
const STATUS_LABELS: Record<string, string> = {
  pending:               "Pending",
  packed:                "Packed",
  assigned:              "Assigned",
  out_for_delivery:      "Out for Delivery",
  attempted:             "Attempted",
  returned_to_warehouse: "Returned to Warehouse",
  delivered:             "Delivered",
  cancelled:             "Cancelled",
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
  const [returnOrder, setReturnOrder]     = useState<Order | null>(null);
  const [receiveBackOrder, setReceiveBackOrder] = useState<Order | null>(null);
  const [reassignOrder, setReassignOrder] = useState<Order | null>(null);
  const [smartRegionMatch, setSmartRegionMatch] = useState(true);
  const { user } = useAuthStore();
  const navigate = useNavigate();

  // ── Filter state ─────────────────────────────────────────────
  const [activeTab, setActiveTab]   = useState<"all"|"pending"|"packed"|"assigned"|"out_for_delivery"|"attempted"|"returned_to_warehouse"|"delivered"|"cancelled">("all");
  const [filterAgent, setFilterAgent] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [filterDelivery, setFilterDelivery] = useState("");
  const [dateFrom, setDateFrom]     = useState("");
  const [dateTo, setDateTo]         = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const PER_PAGE = 20;

  // ── Tamil-aware search ────────────────────────────────────────────────────
  // Flattened fields: customerName, agentName, deliveryPersonName, id.
  // Works with English typing for Tamil customer/agent names.
  const ordersForSearch = useMemo(() =>
    orders.map((o) => ({
      ...o,
      // Join all product names so Tamil product search works too
      _productNames: o.items.map((i) => i.productName).join(" "),
    })),
    [orders]
  );
  const { query: search, setQuery: setSearch, results: searchResults } =
    useTamilSearch(ordersForSearch as unknown as Record<string, unknown>[], [
      "customerName", "agentName", "deliveryPersonName", "id", "_productNames",
    ]);

  const prevPendingCount = useRef<number | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const playAlert = () => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      [0, 0.2].forEach((delay) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = delay === 0 ? 880 : 1100;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.3, ctx.currentTime + delay);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.35);
      });
    } catch { /* audio not supported */ }
  };

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, (snap) => {
      const all = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order));
      const pendingCount = all.filter((o) => o.status === "pending").length;
      if (prevPendingCount.current !== null && pendingCount > prevPendingCount.current && soundEnabled) {
        playAlert();
      }
      prevPendingCount.current = pendingCount;
      setOrders(all);
      setLoading(false);
    });
    getDocs(query(collection(db, "users"), where("role", "==", "delivery"))).then((snap) => {
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
    // FIX (MEDIUM): Use a transaction so we verify status is still "pending"
    // before writing — prevents double-packing on stale UI / race conditions.
    try {
      await runTransaction(db, async (t) => {
        const snap = await t.get(doc(db, "orders", orderId));
        if (!snap.exists()) throw new Error("Order not found.");
        if (snap.data().status !== "pending") throw new Error("Order is no longer pending.");
        t.update(doc(db, "orders", orderId), {
          status: "packed",
          packedAt: new Date().toISOString(),
          packedBy: user?.uid,
          packedByName: user?.name,
        });
      });
    } catch (err: any) {
      alert(err.message || "Could not mark as packed. Please refresh and try again.");
    }
  };

  const bulkAssignDelivery = async (person: AppUser, vehicle: string) => {
    const ids = [...selectedIds].filter((id) =>
      orders.find((o) => o.id === id)?.status === "packed"
    );
    // Use transactions per order so we re-validate status is still "packed"
    // before writing — prevents assigning an already-cancelled/delivered order.
    const results = await Promise.allSettled(
      ids.map((id) =>
        runTransaction(db, async (t) => {
          const snap = await t.get(doc(db, "orders", id));
          if (!snap.exists()) throw new Error(`Order ${id} not found.`);
          if (snap.data().status !== "packed") throw new Error(`Order ${id} is no longer packed.`);
          t.update(doc(db, "orders", id), {
            deliveryPersonId:   person.uid,
            deliveryPersonName: person.name,
            vehicleNumber:      vehicle,
            status:             "assigned",
            assignedAt:         new Date().toISOString(),
          });
        })
      )
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      alert(`${failed} order(s) could not be assigned (status changed). Please refresh.`);
    }
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
    let list = (searchResults as unknown as Order[]);
    if (activeTab !== "all") list = list.filter((o) => o.status === activeTab);
    if (filterAgent)    list = list.filter((o) => o.agentId === filterAgent);
    if (filterRegion)   list = list.filter((o) => o.regionName === filterRegion);
    if (filterDelivery) list = list.filter((o) => o.deliveryPersonId === filterDelivery);
    if (dateFrom)       list = list.filter((o) => o.createdAt >= dateFrom);
    if (dateTo)         list = list.filter((o) => o.createdAt <= dateTo + "T23:59:59");
    return list;
  }, [searchResults, activeTab, filterAgent, filterRegion, filterDelivery, dateFrom, dateTo]);

  const tabCounts = {
    all:                    orders.length,
    pending:                orders.filter((o) => o.status === "pending").length,
    packed:                 orders.filter((o) => o.status === "packed").length,
    assigned:               orders.filter((o) => o.status === "assigned").length,
    out_for_delivery:       orders.filter((o) => o.status === "out_for_delivery").length,
    attempted:              orders.filter((o) => o.status === "attempted").length,
    returned_to_warehouse:  orders.filter((o) => o.status === "returned_to_warehouse").length,
    delivered:              orders.filter((o) => o.status === "delivered").length,
    cancelled:              orders.filter((o) => o.status === "cancelled").length,
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

  const handleExcelExport = () => {
    const rows = filtered.map((o) => ({
      "Order Date":        new Date(o.createdAt).toLocaleDateString("en-IN"),
      "Customer":          o.customerName,
      "Address":           o.customerAddress || "",
      "Field Agent":       o.agentName,
      "Region":            (o as any).regionName || "",
      "Items":             o.items.map((i) => `${i.productName} x${i.quantity}`).join(", "),
      "Total Amount":      o.totalAmount,
      "Amount Collected":  o.amountCollected ?? "",
      "Balance Due":       o.amountCollected !== undefined ? Math.max(0, o.totalAmount - (o.advancePaid ?? 0) - o.amountCollected) : "",
      "Status":            STATUS_LABELS[o.status] || o.status,
      "Delivery Agent":    o.deliveryPersonName || "",
      "Vehicle":           o.vehicleNumber || "",
      "Invoice No":        o.invoiceNumber || "",
      "Packed At":         o.packedAt ? new Date(o.packedAt).toLocaleDateString("en-IN") : "",
      "Delivered At":      o.deliveredAt ? new Date(o.deliveredAt).toLocaleDateString("en-IN") : "",
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Orders");
    // Auto column widths
    const colWidths = Object.keys(rows[0] || {}).map((k) => ({ wch: Math.max(k.length, 15) }));
    ws["!cols"] = colWidths;
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `orders-export-${date}.xlsx`);
  };

  if (loading) return (
    <div className="p-8 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading orders...
    </div>
  );

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold text-gray-800">Orders</h2>
        <div className="flex items-center gap-3">
          {user?.role === "admin" && (
            <button
              onClick={() => navigate("/create-order")}
              className="flex items-center gap-2 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-orange-600 transition-all shadow-sm"
            >
              <span className="text-base leading-none">＋</span> New Order
            </button>
          )}
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs text-red-500 hover:text-red-700 underline">
              Clear filters
            </button>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={handleExcelExport}
              className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50"
            >
              ⬇️ Export Excel
            </button>
            <button
              onClick={() => setSmartRegionMatch(p => !p)}
              title={smartRegionMatch ? "Smart region matching ON — matched delivery agents highlighted in assign modal" : "Smart region matching OFF"}
              className={`flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                smartRegionMatch
                  ? "bg-green-50 border-green-300 text-green-700"
                  : "bg-gray-50 border-gray-200 text-gray-400"
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${smartRegionMatch ? "bg-green-500" : "bg-gray-300"}`} />
              Region Match
            </button>
            <button
              onClick={() => setSoundEnabled(p => !p)}
              title={soundEnabled ? "Mute order alerts" : "Enable order alerts"}
              className={`text-lg transition-all ${soundEnabled ? "opacity-100" : "opacity-30"}`}
            >
              {soundEnabled ? "🔔" : "🔕"}
            </button>
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
              Live
            </div>
          </div>
        </div>
      </div>

      <div className="flex gap-1 mb-4 overflow-x-auto pb-1">
        {(["all","pending","packed","assigned","out_for_delivery","attempted","returned_to_warehouse","delivered","cancelled"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
              activeTab === tab
                ? "bg-gray-800 text-white"
                : tab === "attempted" && tabCounts.attempted > 0
                  ? "bg-orange-100 text-orange-700 border border-orange-300 hover:bg-orange-200"
                  : tab === "returned_to_warehouse" && tabCounts.returned_to_warehouse > 0
                    ? "bg-red-100 text-red-700 border border-red-300 hover:bg-red-200"
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
        {/* Tamil-aware Search */}
        <div className="flex-1 min-w-[200px]">
          <TamilSearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search customer, agent, product, order ID... (supports Tamil)"
          />
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
            <button
              onClick={handleExcelExport}
              className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50"
            >
              ⬇️ Export Excel
            </button>
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
              <th className="px-5 py-4">Order #</th>
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
                <td className="px-5 py-3 text-gray-500 text-xs font-mono">
                  {order.orderNo || (order.id ?? "").slice(0, 10).toUpperCase()}
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
                      <>
                        <span className="text-xs text-indigo-500 font-medium">Waiting for collection</span>
                        <button onClick={(e) => { e.stopPropagation(); setReassignOrder(order); }}
                          className="bg-indigo-100 text-indigo-600 text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-200 font-medium">
                          🔄 Reassign
                        </button>
                      </>
                    )}
                    {order.status === "attempted" && (
                      <button onClick={(e) => { e.stopPropagation(); setReceiveBackOrder(order); }}
                        className="bg-red-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-red-600 font-medium">
                        📦 Receive Items Back
                      </button>
                    )}
                    {order.status === "returned_to_warehouse" && (
                      <button onClick={(e) => { e.stopPropagation(); setReassignOrder(order); }}
                        className="bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-indigo-600">
                        🔄 Reassign Agent
                      </button>
                    )}
                    {(order.status === "pending" || order.status === "packed") && (
                      <button onClick={(e) => { e.stopPropagation(); setCancelOrder(order); }}
                        className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">
                        Cancel
                      </button>
                    )}
                    {order.status === "delivered" &&
                      order.amountCollected !== undefined && (() => {
                        const due = Math.max(0, order.totalAmount - (order.advancePaid ?? 0) - order.amountCollected);
                        return due > 0 ? (
                          <span className="bg-red-100 text-red-600 text-xs px-2 py-1 rounded-lg font-medium">
                            ₹{due.toFixed(2)} due
                          </span>
                        ) : null;
                      })()}
                    {order.status === "delivered" && (
                      <button onClick={(e) => { e.stopPropagation(); setReturnOrder(order); }}
                        className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">
                        ↩️ Return
                      </button>
                    )}
                    <button onClick={() => setInvoiceOrder(order)}
                      className={`text-xs px-3 py-1.5 rounded-lg font-medium ${
                        order.invoiceNumber
                          ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                          : "bg-orange-500 text-white hover:bg-orange-600"
                      }`}>
                      {order.invoiceNumber ? "👁 View Invoice" : "🧾 Generate Invoice"}
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

      {returnOrder && (
        <PartialReturnModal
          order={returnOrder}
          onClose={() => setReturnOrder(null)}
          onDone={() => setReturnOrder(null)}
        />
      )}

      {receiveBackOrder && (
        <ReceiveBackModal
          order={receiveBackOrder}
          onClose={() => setReceiveBackOrder(null)}
          onDone={() => setReceiveBackOrder(null)}
        />
      )}

      {reassignOrder && (
        <ReassignDeliveryModal
          order={reassignOrder}
          deliveryUsers={deliveryUsers}
          onClose={() => setReassignOrder(null)}
          onDone={() => setReassignOrder(null)}
          smartRegionMatch={smartRegionMatch}
        />
      )}

      {showBulkAssign && (
        <BulkAssignModal
          count={selectedIds.size}
          deliveryUsers={deliveryUsers}
          onAssign={bulkAssignDelivery}
          onClose={() => setShowBulkAssign(false)}
          smartRegionMatch={smartRegionMatch}
          selectedOrders={[...selectedIds].map(id => orders.find(o => o.id === id)).filter(Boolean) as Order[]}
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
        <InvoiceModal order={invoiceOrder} onClose={() => setInvoiceOrder(null)} isAdmin={user?.role === "admin"} />
      )}
      {selectedOrder && (
        <AssignDeliveryModal order={selectedOrder} deliveryUsers={deliveryUsers}
          onAssign={assignDelivery} onClose={() => setSelectedOrder(null)}
          smartRegionMatch={smartRegionMatch} />
      )}
    </div>
  );
}

// ── Invoice Modal ──────────────────────────────────────────────────
// States:
//   "setup"      — order has no invoice yet; user chooses type + due, then generates
//   "view"       — order already has an invoice; PDF renders immediately
//   "regenerate" — admin-only confirmation before voiding old number + minting new
//   "preview"    — PDF is ready to view / download / share
function InvoiceModal({ order, onClose, isAdmin }: {
  order: Order; onClose: () => void; isAdmin: boolean;
}) {
  const hasInvoice = !!order.invoiceNumber;

  // UI state machine
  type ModalState = "setup" | "view" | "regenerate" | "preview";
  const [modalState, setModalState] = useState<ModalState>(hasInvoice ? "view" : "setup");

  // Invoice options — pre-filled from saved data if already invoiced
  const [invoiceType, setInvoiceType] = useState<InvoiceType>(order.invoiceType ?? "estimate");
  const [billingMode, setBillingMode] = useState<BillingMode>(order.billingMode ?? "without_due");
  const [qrMode, setQrMode] = useState<"with_amount" | "without_amount">("without_amount");
  const [customerDue, setCustomerDue] = useState("");
  const [loadingDefaults, setLoadingDefaults] = useState(!hasInvoice); // only wait on first-time generation

  // Working invoice number — locked once minted, never changes except on regen
  const [invoiceNumber, setInvoiceNumber] = useState<string>(order.invoiceNumber || "");

  const [customerData, setCustomerData] = useState<any>(null);
  const [pdfUrl, setPdfUrl]             = useState<string | null>(null);
  const [loadingDue, setLoadingDue]     = useState(false);
  const [generating, setGenerating]     = useState(false);
  const [regenReason, setRegenReason]   = useState("");

  // Load customer data once
  useEffect(() => {
    if (!order.customerId) return;
    setLoadingDue(true);
    getDoc(doc(db, "customers", order.customerId)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setCustomerData(data);
        if (!hasInvoice) {
          const currentDue    = data.outstandingDue ?? 0;
          const orderBalance  = (order as any).balanceDue ?? 0;
          const historicalDue = Math.max(0, Math.round((currentDue - orderBalance) * 100) / 100);
          if (historicalDue > 0) {
            setCustomerDue(String(historicalDue));
            setBillingMode("with_due");
          }
        }
      }
      setLoadingDue(false);
    }).catch(() => setLoadingDue(false));

    // Also load biz settings to get default QR mode
    getDoc(doc(db, "settings", "business")).then((snap) => {
      if (snap.exists()) {
        const biz = snap.data();
        if (!hasInvoice) {
          if (biz.defaultInvoiceType) setInvoiceType(biz.defaultInvoiceType);
          if (biz.defaultBillingMode) setBillingMode(biz.defaultBillingMode);
        }
        setQrMode(biz.defaultQrMode ?? "without_amount");
      }
      setLoadingDefaults(false);
    }).catch(() => setLoadingDefaults(false));
  }, [order.customerId]);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); };
  }, [pdfUrl]);

  // Auto-render PDF when entering "view" state (existing invoice)
  useEffect(() => {
    if (modalState === "view" && !pdfUrl && !generating) {
      // Defer past React's commit phase so it doesn't compete with rendering
      const t = setTimeout(() => {
        renderPdf(order.invoiceNumber!, order.invoiceType ?? "estimate", order.billingMode ?? "without_due");
      }, 50);
      return () => clearTimeout(t);
    }
  }, [modalState]);

  // ── Core render — NEVER touches the invoice counter ──────────────
  const renderPdf = async (
    invNum: string,
    invType: InvoiceType,
    billMode: BillingMode,
    qrModeVal: "with_amount" | "without_amount" = qrMode,
  ) => {
    setGenerating(true);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    try {
      const orderWithMeta = { ...order, invoiceNumber: invNum, invoiceType: invType, billingMode: billMode };
      const pdf = await buildInvoicePDF(orderWithMeta as any, customerData || undefined, {
        invoiceType: invType,
        billingMode: billMode,
        customerDue: billMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
        qrMode: qrModeVal,
      });
      setPdfUrl(URL.createObjectURL(pdf.output("blob")));
      setModalState("preview");
    } finally {
      setGenerating(false);
    }
  };

  // ── GENERATE (first time) ─────────────────────────────────────────
  // Mint number → save to Firestore → render PDF. Counter increments exactly once.
  const handleGenerate = async () => {
    setGenerating(true);
    try {
      // 1. Fetch business settings to get prefix
      const bizSnap = await getDoc(doc(db, "settings", "business"));
      const prefix  = bizSnap.exists() ? (bizSnap.data().invoicePrefix || "INV") : "INV";

      // 2. Mint invoice number atomically (counter increments here, exactly once)
      const { mintInvoiceNumber } = await import("../utils/invoice");
      const minted = await mintInvoiceNumber(prefix);

      // 3. Persist everything to the order doc BEFORE rendering
      await updateDoc(doc(db, "orders", order.id!), {
        invoiceNumber: minted,
        invoiceType,
        billingMode,
        invoicedAt: new Date().toISOString(),
      });

      setInvoiceNumber(minted);

      // 4. Render PDF with the locked number
      await renderPdf(minted, invoiceType, billingMode, qrMode);
    } catch (e: any) {
      alert("Failed to generate invoice: " + e.message);
      setGenerating(false);
    }
  };

  // ── REGENERATE (admin only) ───────────────────────────────────────
  // Void old number (save to voidedInvoices[]) → mint new → save → render.
  const handleRegenerate = async () => {
    if (!regenReason.trim()) return;
    setGenerating(true);
    try {
      const { user: authUser } = useAuthStore.getState();

      const bizSnap = await getDoc(doc(db, "settings", "business"));
      const prefix  = bizSnap.exists() ? (bizSnap.data().invoicePrefix || "INV") : "INV";

      const { mintInvoiceNumber } = await import("../utils/invoice");
      const minted = await mintInvoiceNumber(prefix);

      // Record the voided invoice
      const voidedEntry = {
        invoiceNumber: order.invoiceNumber!,
        voidedAt:      new Date().toISOString(),
        voidedBy:      authUser!.uid,
        voidedByName:  authUser!.name,
        reason:        regenReason.trim(),
      };
      const existingVoided = (order as any).voidedInvoices ?? [];

      await updateDoc(doc(db, "orders", order.id!), {
        invoiceNumber:   minted,
        invoiceType,
        billingMode,
        invoicedAt:      new Date().toISOString(),
        voidedInvoices:  [...existingVoided, voidedEntry],
      });

      setInvoiceNumber(minted);
      setRegenReason("");
      await renderPdf(minted, invoiceType, billingMode, qrMode);
    } catch (e: any) {
      alert("Failed to regenerate invoice: " + e.message);
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    const prefix = invoiceType === "gst" ? "invoice" : "estimate";
    const orderWithMeta = { ...order, invoiceNumber, invoiceType, billingMode };
    const pdf = await buildInvoicePDF(orderWithMeta as any, customerData || undefined, {
      invoiceType,
      billingMode,
      customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
      qrMode,
    });
    pdf.save(`${prefix}-${invoiceNumber}.pdf`);
  };

  const handleShare = async () => {
    try {
      const prefix = invoiceType === "gst" ? "invoice" : "estimate";
      const orderWithMeta = { ...order, invoiceNumber, invoiceType, billingMode };
      const pdf = await buildInvoicePDF(orderWithMeta as any, customerData || undefined, {
        invoiceType,
        billingMode,
        customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
        qrMode,
      });
      const blob = pdf.output("blob");
      const file = new File([blob], `${prefix}-${invoiceNumber}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Invoice - ${order.customerName}`, text: `Invoice ₹${order.totalAmount.toFixed(2)}` });
      } else {
        const rawPhone = (order.customerPhone || "").replace(/[^\d]/g, "");
        const phone10  = rawPhone.slice(-10);
        if (phone10.length < 10) { alert("No valid phone for this customer."); return; }
        const msg = encodeURIComponent(`Dear ${order.customerName},\nYour invoice for ₹${order.totalAmount.toFixed(2)} is ready.\nInvoice No: ${invoiceNumber}\nThank you!`);
        window.open(`https://wa.me/91${phone10}?text=${msg}`, "_blank");
      }
    } catch (err: any) {
      if (err.name !== "AbortError") alert("Could not share: " + err.message);
    }
  };

  const isWide = modalState === "preview";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      {/* Modal is ALWAYS full size — never resizes, preventing page reflow glitch */}
      <div className="relative bg-white rounded-2xl shadow-2xl flex flex-col w-full max-w-4xl h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">
              {modalState === "setup" ? "Generate Invoice" :
               modalState === "regenerate" ? "Regenerate Invoice" : "Invoice"}
            </h3>
            <p className="text-sm text-gray-500 flex items-center gap-2 flex-wrap">
              <span>{order.customerName} · ₹{order.totalAmount.toFixed(2)}</span>
              {invoiceNumber && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-mono font-semibold">
                  #{invoiceNumber}
                </span>
              )}
              {invoiceType === "gst" && invoiceNumber && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Tax Invoice</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl p-1">✕</button>
        </div>

        {/* ── GENERATING OVERLAY — shown during PDF render ── */}
        {generating && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center rounded-2xl z-10">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
              <p className="text-sm font-medium text-gray-600">Building invoice…</p>
              <p className="text-xs text-gray-400">This takes a few seconds</p>
            </div>
          </div>
        )}

        {/* ── SETUP STATE — first-time generation ── */}
        {modalState === "setup" && (
          <div className="flex-1 overflow-y-auto flex items-start justify-center">
            {loadingDefaults ? (
              <div className="flex flex-col items-center justify-center gap-4 h-full py-24">
                <div className="w-10 h-10 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
                <p className="text-sm text-gray-500 font-medium">Loading invoice defaults…</p>
              </div>
            ) : (
            <div className="w-full max-w-md p-6 space-y-5">
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
                ⚠️ Choose carefully — once generated, the invoice number is <strong>permanently locked</strong> to this order. Only admins can regenerate with a new number.
              </div>

              {/* Invoice type */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Invoice Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["gst", "estimate"] as InvoiceType[]).map((t) => (
                    <button key={t} onClick={() => setInvoiceType(t)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        invoiceType === t ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{t === "gst" ? "🧾 Tax Invoice" : "📄 Bill of Supply"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{t === "gst" ? "CGST + SGST, for GST filing" : "No GST breakdown, not for IT filing"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Billing mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Outstanding Due on Bill</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["without_due", "with_due"] as BillingMode[]).map((m) => (
                    <button key={m} onClick={() => setBillingMode(m)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        billingMode === m ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{m === "without_due" ? "Current bill only" : "Include previous due"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{m === "without_due" ? "Due tracked internally" : "Shows grand total on bill"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {billingMode === "with_due" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Previous Outstanding before this order (₹)
                    {loadingDue && <span className="text-xs text-gray-400 ml-2">calculating…</span>}
                  </label>
                  <input type="number" min="0" step="0.01" value={customerDue}
                    onChange={(e) => setCustomerDue(e.target.value)} placeholder="0.00"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              )}

              {/* QR mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">UPI QR Code</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ["without_amount", "📷 QR only", "Customer types amount (B2B recommended)"],
                    ["with_amount",    "💰 QR + Amount", "Pre-fills balance due in UPI app"],
                  ] as const).map(([val, label, desc]) => (
                    <button key={val} onClick={() => setQrMode(val)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        qrMode === val ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button onClick={onClose}
                  className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleGenerate} disabled={generating}
                  className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-50">
                  {generating ? "Generating…" : "🧾 Generate Invoice"}
                </button>
              </div>
            </div>
            )}
          </div>
        )}

        {/* ── VIEW STATE — loading existing invoice ── */}
        {modalState === "view" && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-400">
              <div className="text-3xl mb-3 animate-spin">⏳</div>
              <p className="text-sm">Loading invoice #{invoiceNumber}…</p>
            </div>
          </div>
        )}

        {/* ── REGENERATE STATE — admin confirmation ── */}
        {modalState === "regenerate" && (
          <div className="flex-1 overflow-y-auto flex items-start justify-center">
            <div className="w-full max-w-md p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-4 text-sm text-red-700 space-y-1">
                <p className="font-semibold">⚠️ This will void the current invoice</p>
                <p>Invoice <span className="font-mono font-bold">#{order.invoiceNumber}</span> will be marked as cancelled in the GST report.</p>
                <p>A new invoice number will be permanently assigned to this order.</p>
              </div>

              {/* Invoice type */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">New Invoice Type</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["gst", "estimate"] as InvoiceType[]).map((t) => (
                    <button key={t} onClick={() => setInvoiceType(t)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        invoiceType === t ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{t === "gst" ? "🧾 Tax Invoice" : "📄 Bill of Supply"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{t === "gst" ? "CGST + SGST, for GST filing" : "No GST breakdown"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Billing mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Outstanding Due on Bill</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["without_due", "with_due"] as BillingMode[]).map((m) => (
                    <button key={m} onClick={() => setBillingMode(m)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        billingMode === m ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{m === "without_due" ? "Current bill only" : "Include previous due"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{m === "without_due" ? "Due tracked internally" : "Shows grand total on bill"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {billingMode === "with_due" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Previous Outstanding (₹)</label>
                  <input type="number" min="0" step="0.01" value={customerDue}
                    onChange={(e) => setCustomerDue(e.target.value)} placeholder="0.00"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              )}

              {/* QR mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">UPI QR Code</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ["without_amount", "📷 QR only", "Customer types amount"],
                    ["with_amount",    "💰 QR + Amount", "Pre-fills balance due"],
                  ] as const).map(([val, label, desc]) => (
                    <button key={val} onClick={() => setQrMode(val)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        qrMode === val ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Reason */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Reason for regeneration *</label>
                <input value={regenReason} onChange={(e) => setRegenReason(e.target.value)}
                  placeholder="e.g. Wrong customer details, GST number correction…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300" />
              </div>

              {(order as any).voidedInvoices?.length > 0 && (
                <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-500">
                  Previously voided: {(order as any).voidedInvoices.map((v: any) => (
                    <span key={v.invoiceNumber} className="font-mono mr-2 line-through text-red-400">#{v.invoiceNumber}</span>
                  ))}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={() => setModalState("preview")}
                  className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                  ← Cancel
                </button>
                <button onClick={handleRegenerate} disabled={generating || !regenReason.trim()}
                  className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50">
                  {generating ? "Regenerating…" : "🔄 Void & Regenerate"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── PREVIEW STATE — PDF ready ── */}
        {modalState === "preview" && pdfUrl && (
          <>
            <div className="flex-1 overflow-hidden">
              <iframe src={pdfUrl} className="w-full h-full border-0" title="Invoice Preview" />
            </div>
            <div className="flex gap-2 p-4 border-t border-gray-100 flex-shrink-0 flex-wrap">
              <button onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                Close
              </button>
              <button onClick={handleDownload}
                className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600">
                ⬇️ Download
              </button>
              <button onClick={handleShare}
                className="flex-1 bg-green-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-600">
                📱 Share
              </button>
              {isAdmin && (
                <button onClick={() => setModalState("regenerate")}
                  className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-xs hover:bg-red-50 mt-1">
                  🔄 Regenerate Invoice (Admin)
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Assign Delivery Modal ─────────────────────────────────────────
function AssignDeliveryModal({ order, deliveryUsers, onAssign, onClose, smartRegionMatch }: {
  order: Order; deliveryUsers: AppUser[];
  onAssign: (orderId: string, person: AppUser, vehicle: string) => void;
  onClose: () => void;
  smartRegionMatch?: boolean;
}) {
  const [selectedPerson, setSelectedPerson] = useState<AppUser | null>(null);
  const [vehicleNumber, setVehicleNumber]   = useState("");

  // Split agents into region-matched and others when smart matching is on
  const orderRegionId = (order as any).regionId as string | undefined;
  const matchedAgents = smartRegionMatch && orderRegionId
    ? deliveryUsers.filter(u => u.assignedRegions?.includes(orderRegionId))
    : [];
  const otherAgents = smartRegionMatch && orderRegionId
    ? deliveryUsers.filter(u => !u.assignedRegions?.includes(orderRegionId))
    : deliveryUsers;
  const hasMatches = matchedAgents.length > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Assign Delivery Agent</h3>
        <p className="text-sm text-gray-500 mb-4">
          Order for: <strong>{order.customerName}</strong> · ₹{order.totalAmount.toFixed(2)}
          {(order as any).regionName && <span className="ml-2 bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">{(order as any).regionName}</span>}
        </p>
        <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700 mb-4">
          ℹ️ Status becomes <strong>Assigned</strong>. Moves to <strong>Out for Delivery</strong> only after agent confirms collection.
        </div>

        {/* Smart region match section */}
        {smartRegionMatch && orderRegionId && (
          <div className="mb-4">
            {hasMatches ? (
              <div>
                <p className="text-xs font-semibold text-green-700 mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Region-matched agents ({matchedAgents.length})
                </p>
                <div className="space-y-2 mb-3">
                  {matchedAgents.map((u) => (
                    <button key={u.uid} type="button"
                      onClick={() => setSelectedPerson(selectedPerson?.uid === u.uid ? null : u)}
                      className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${
                        selectedPerson?.uid === u.uid
                          ? "border-green-500 bg-green-50 text-green-800"
                          : "border-green-200 bg-green-50/50 text-gray-700 hover:border-green-400"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-green-600">🎯</span>
                        <span>{u.name}</span>
                        {u.phone && <span className="text-xs text-gray-400">{u.phone}</span>}
                      </div>
                      {selectedPerson?.uid === u.uid && <span className="text-green-600 text-base">✓</span>}
                    </button>
                  ))}
                </div>
                {otherAgents.length > 0 && (
                  <p className="text-xs text-gray-400 mb-2">Other agents</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
                ⚠️ No delivery agent is assigned to <strong>{(order as any).regionName || "this region"}</strong>. You can still assign any agent below.
              </p>
            )}
          </div>
        )}

        <div className="space-y-4">
          {/* Only show the dropdown when no card is selected (or there are no matched cards) */}
          {!(smartRegionMatch && hasMatches && selectedPerson && matchedAgents.some(m => m.uid === selectedPerson.uid)) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {hasMatches && smartRegionMatch ? "Other agents" : "Delivery Agent"}
              </label>
              <select className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={selectedPerson && !matchedAgents.some(m => m.uid === selectedPerson.uid) ? selectedPerson.uid : ""}
                onChange={(e) => setSelectedPerson(deliveryUsers.find((u) => u.uid === e.target.value) || null)}>
                <option value="">— Select agent —</option>
                {(smartRegionMatch && hasMatches ? otherAgents : deliveryUsers).map((u) => (
                  <option key={u.uid} value={u.uid}>{u.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle Number <span className="text-gray-400 font-normal">(optional)</span></label>
            <input type="text" value={vehicleNumber}
              onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
              placeholder="TN 01 AB 1234"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onClose}
            className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={() => selectedPerson && onAssign(order.id!, selectedPerson, vehicleNumber)}
            disabled={!selectedPerson}
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

  const attempts = (order as any).deliveryAttempts as import("../types").DeliveryAttempt[] | undefined;

  const ATTEMPT_REASON_LABELS: Record<string, string> = {
    shop_closed:          "🔒 Shop Closed",
    customer_unavailable: "👤 Customer Unavailable",
    refused_delivery:     "🚫 Refused Delivery",
    other:                "📋 Other",
  };

  const timeline: { label: string; time?: string; done: boolean; color: string }[] = [
    { label: "Order Placed",          time: fmt(order.createdAt),                done: true,                                                                  color: order.status === "cancelled" ? "bg-red-400" : "bg-yellow-400" },
    { label: "Packed",                time: fmt(order.packedAt),                 done: !!order.packedAt,                                                      color: "bg-blue-400"   },
    { label: "Assigned to Agent",     time: fmt(order.assignedAt),               done: !!order.assignedAt,                                                    color: "bg-indigo-400" },
    { label: "Out for Delivery",      time: fmt((order as any).outForDeliveryAt), done: ["out_for_delivery","attempted","returned_to_warehouse","delivered"].includes(order.status), color: "bg-purple-400" },
    ...(attempts && attempts.length > 0 ? [{
      label: `Attempted (${attempts.length}x)`,
      time: fmt(attempts[attempts.length - 1].attemptedAt),
      done: true,
      color: "bg-orange-400",
    }] : []),
    ...((order as any).returnedToWarehouseAt ? [{
      label: "Returned to Warehouse",
      time: fmt((order as any).returnedToWarehouseAt),
      done: true,
      color: "bg-red-400",
    }] : []),
    { label: "Delivered",             time: fmt(order.deliveredAt),              done: order.status === "delivered",                                          color: "bg-green-400"  },
  ];

  const balance =
    order.amountCollected !== undefined
      ? Math.max(0, order.totalAmount - (order.advancePaid ?? 0) - order.amountCollected)
      : null;

  const [receiveBack, setReceiveBack]   = useState(false);
  const [reassign,    setReassign]      = useState(false);

  return (
    <>
      {receiveBack && (
        <ReceiveBackModal order={order} onClose={() => setReceiveBack(false)} onDone={() => { setReceiveBack(false); onClose(); }} />
      )}
      {reassign && (
        <ReassignDeliveryModal order={order} deliveryUsers={deliveryUsers} onClose={() => setReassign(false)} onDone={() => { setReassign(false); onClose(); }} />
      )}
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Slide-in panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-xl bg-white shadow-2xl z-50 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 bg-gray-50 flex-shrink-0">
          <div>
            <h3 className="text-lg font-bold text-gray-800">{order.customerName}</h3>
            {/* FIX: show orderNo written by mobile app; fall back to short Firestore ID */}
            <p className="text-xs text-gray-400 mt-0.5 font-mono">
              #{order.orderNo || (order.id ?? "").slice(0, 10).toUpperCase()}
            </p>
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
              {/* Advance paid by field agent at order creation */}
              {(order.advancePaid ?? 0) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-blue-600 font-medium">
                    💼 Advance (Field Agent)
                  </span>
                  <span className="font-medium text-blue-600">₹{(order.advancePaid ?? 0).toFixed(2)}</span>
                </div>
              )}
              {/* Amount collected by delivery agent — only if different from advance */}
              {order.amountCollected !== undefined &&
                order.status === "delivered" &&
                order.amountCollected !== (order.advancePaid ?? 0) && (
                <div className="flex justify-between text-sm">
                  <span className="text-green-600 font-medium">
                    🚚 Collected at Delivery
                  </span>
                  <span className="font-medium text-green-600">
                    ₹{(order.amountCollected - (order.advancePaid ?? 0)).toFixed(2)}
                  </span>
                </div>
              )}
              {/* Total collected so far (if any payment made) */}
              {order.amountCollected !== undefined && order.amountCollected > 0 && (
                <div className="flex justify-between text-sm border-t border-gray-100 pt-1.5">
                  <span className="text-gray-500">Total Collected</span>
                  <span className="font-semibold text-gray-700">₹{order.amountCollected.toFixed(2)}</span>
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

          {/* Delivery Attempt History */}
          {attempts && attempts.length > 0 && (
            <div className="px-6 py-5 border-b border-gray-100 bg-orange-50">
              <p className="text-xs font-semibold text-orange-400 uppercase tracking-widest mb-3">
                Delivery Attempts ({attempts.length})
              </p>
              <div className="space-y-3">
                {attempts.map((a, i) => (
                  <div key={i} className="bg-white border border-orange-200 rounded-xl px-4 py-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-orange-600">
                        {ATTEMPT_REASON_LABELS[a.reason] ?? a.reason}
                      </span>
                      <span className="text-xs text-gray-400">{fmt(a.attemptedAt)}</span>
                    </div>
                    <p className="text-xs text-gray-500">By: {a.agentName}</p>
                    {a.notes && (
                      <p className="text-xs text-gray-600 mt-1 bg-orange-50 rounded-lg px-2 py-1">
                        "{a.notes}"
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Returned to warehouse info */}
          {(order as any).returnedToWarehouseAt && (
            <div className="px-6 py-4 border-b border-gray-100 bg-red-50">
              <p className="text-xs font-semibold text-red-400 uppercase tracking-widest mb-2">
                Returned to Warehouse
              </p>
              <p className="text-sm text-gray-700">
                Received by <span className="font-medium">{(order as any).returnedToWarehouseByName ?? "Admin"}</span>
              </p>
              <p className="text-xs text-gray-400 mt-0.5">{fmt((order as any).returnedToWarehouseAt)}</p>
            </div>
          )}
          {order.status === "cancelled" && (
            <div className="px-6 py-5 border-b border-gray-100 bg-red-50">
              <p className="text-xs font-semibold text-red-400 uppercase tracking-widest mb-3">Cancellation Details</p>
              {/* Refund notice — shown when advance was collected and a physical refund is due */}
              {(order as any).refundDue > 0 && (
                <div className="bg-amber-100 border border-amber-300 rounded-lg p-3 mb-3">
                  <p className="text-sm font-semibold text-amber-800">💰 Physical Refund Required</p>
                  <p className="text-xs text-amber-700 mt-1">
                    ₹{((order as any).refundDue as number).toFixed(2)} must be returned physically to {order.customerName}.
                  </p>
                  {(order as any).refundNote && (
                    <p className="text-xs text-amber-600 mt-1">{(order as any).refundNote}</p>
                  )}
                </div>
              )}
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
            {order.status === "attempted" && (
              <button
                onClick={() => setReceiveBack(true)}
                className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-red-600"
              >
                📦 Receive Items Back
              </button>
            )}
            {order.status === "returned_to_warehouse" && (
              <button
                onClick={() => setReassign(true)}
                className="flex-1 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-600"
              >
                🔄 Reassign &amp; Send Out
              </button>
            )}
            {order.status === "assigned" && (
              <button
                onClick={() => setReassign(true)}
                className="flex-1 bg-indigo-100 text-indigo-700 py-2.5 rounded-xl text-sm font-medium hover:bg-indigo-200"
              >
                🔄 Reassign Agent
              </button>
            )}
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
              className={`flex-1 py-2.5 rounded-xl text-sm font-medium ${
                order.invoiceNumber
                  ? "bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200"
                  : "bg-orange-500 text-white hover:bg-orange-600"
              }`}
            >
              {order.invoiceNumber ? "👁 View Invoice" : "🧾 Generate Invoice"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Receive Items Back Modal ────────────────────────────────────────────────
function ReceiveBackModal({ order, onClose, onDone }: {
  order: Order; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuthStore();
  const [notes, setNotes]   = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await updateDoc(doc(db, "orders", order.id!), {
        status:                    "returned_to_warehouse",
        currentHolder:             "warehouse",
        returnedToWarehouseAt:     new Date().toISOString(),
        returnedToWarehouseBy:     user!.uid,
        returnedToWarehouseByName: user!.name,
        ...(notes.trim() ? { returnNotes: notes.trim() } : {}),
      });
      onDone();
    } catch (err: any) {
      alert(err.message || "Failed to update order.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">📦 Receive Items Back</h3>
            <p className="text-sm text-gray-500">{order.customerName} — #{order.orderNo ?? order.id?.slice(0, 8).toUpperCase()}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3 text-sm text-orange-700">
            Confirm you have physically received all items back from the delivery agent. The order will be marked as <strong>Returned to Warehouse</strong> and can be reassigned.
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. All items intact, ready for next delivery attempt"
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none"
            />
          </div>
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving}
            className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50">
            {saving ? "Saving..." : "✅ Confirm Received Back"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reassign Delivery Modal ─────────────────────────────────────────────────
function ReassignDeliveryModal({ order, deliveryUsers, onClose, onDone, smartRegionMatch }: {
  order: Order; deliveryUsers: AppUser[];
  onClose: () => void; onDone: () => void;
  smartRegionMatch?: boolean;
}) {
  const { user } = useAuthStore();
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving]         = useState(false);

  const orderRegionId = (order as any).regionId as string | undefined;
  const matched = smartRegionMatch && orderRegionId
    ? deliveryUsers.filter(u => u.assignedRegions?.includes(orderRegionId))
    : [];
  const others = smartRegionMatch && orderRegionId
    ? deliveryUsers.filter(u => !u.assignedRegions?.includes(orderRegionId))
    : deliveryUsers;

  const handleReassign = async () => {
    if (!selectedId) return;
    setSaving(true);
    const agent = deliveryUsers.find(u => u.uid === selectedId);
    try {
      await updateDoc(doc(db, "orders", order.id!), {
        deliveryPersonId:   selectedId,
        deliveryPersonName: agent?.name ?? "",
        assignedAt:         new Date().toISOString(),
        assignedBy:         user!.uid,
        assignedByName:     user!.name,
        status:             "assigned",
        currentHolder:      "warehouse",
      });
      onDone();
    } catch (err: any) {
      alert(err.message || "Failed to reassign.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">🔄 Reassign Delivery Agent</h3>
            <p className="text-sm text-gray-500">{order.customerName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="p-6 space-y-3">
          {order.deliveryPersonName && (
            <div className="bg-gray-50 rounded-xl px-4 py-2 text-sm text-gray-600">
              Currently assigned to: <span className="font-medium">{order.deliveryPersonName}</span>
            </div>
          )}
          {matched.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-600 mb-2">✅ Region Match</p>
              {matched.map(u => (
                <label key={u.uid} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer mb-2 ${selectedId === u.uid ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:bg-gray-50"}`}>
                  <input type="radio" name="agent" value={u.uid} checked={selectedId === u.uid} onChange={() => setSelectedId(u.uid)} className="accent-indigo-500" />
                  <span className="text-sm font-medium text-gray-800">{u.name}</span>
                </label>
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div>
              {matched.length > 0 && <p className="text-xs font-semibold text-gray-400 mb-2">Other Agents</p>}
              {others.map(u => (
                <label key={u.uid} className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer mb-2 ${selectedId === u.uid ? "border-indigo-400 bg-indigo-50" : "border-gray-200 hover:bg-gray-50"}`}>
                  <input type="radio" name="agent" value={u.uid} checked={selectedId === u.uid} onChange={() => setSelectedId(u.uid)} className="accent-indigo-500" />
                  <span className="text-sm font-medium text-gray-800">{u.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleReassign} disabled={saving || !selectedId}
            className="flex-1 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50">
            {saving ? "Reassigning..." : "🚚 Reassign"}
          </button>
        </div>
      </div>
    </div>
  );
}
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
        const customerRef  = doc(db, "customers", order.customerId);
        const [productSnaps, customerSnap] = await Promise.all([
          Promise.all(productRefs.map((ref) => t.get(ref))),
          t.get(customerRef),
        ]);

        // ── WRITES AFTER ALL READS ────────────────────────────────
        // FIX: Stock restore logic gated on order status.
        // • pending  → only reservedStock was held (stock never deducted by packing) → clear reservation only
        // • packed   → packing already deducted stock → restore stock AND clear reservation
        const isPacked = order.status === "packed";
        productSnaps.forEach((snap, i) => {
          if (!snap.exists()) return;
          const item = order.items[i];
          const data = snap.data();
          if (!data.trackInventory) return;

          const updates: Record<string, number | string> = {
            reservedStock: Math.max(0, (data.reservedStock ?? 0) - item.quantity),
            updatedAt:     new Date().toISOString(),
          };
          if (isPacked) {
            // Packing deducted actual stock — restore it
            updates.stock = (data.stock ?? 0) + item.quantity;
          }
          // pending orders: stock was never deducted — do NOT touch stock
          t.update(productRefs[i], updates);
        });

        t.update(doc(db, "orders", order.id!), {
          status:             "cancelled",
          cancelledAt:        new Date().toISOString(),
          cancelledBy:        user!.uid,
          cancelledByName:    user!.name,
          cancellationReason: reason.trim(),
        });

        // ── Reverse the order's effect on the customer ledger ──────────────
        // Logic:
        //   netDebit  = what was actually added to outstandingDue at order creation
        //             = totalAmount - advancePaid  (advance reduced the due at placement)
        //   newDue    = currentDue - netDebit  (always clamped to ≥ 0)
        //
        // If newDue goes to 0 AND advance > 0:  the advance was physical cash collected
        // by the field agent.  That cash must be physically returned to the customer.
        // We flag this with a "refundDue" field on the cancelled order so the admin
        // and field agent know money needs to go back.
        if (customerSnap.exists()) {
          const advance    = order.advancePaid ?? 0;
          const currentDue = customerSnap.data().outstandingDue ?? 0;
          const netDebit   = Math.max(0, order.totalAmount - advance);
          const rawNewDue  = Math.round((currentDue - netDebit) * 100) / 100;
          const newDue     = Math.max(0, rawNewDue);

          // If cancelling wipes out more due than exists → advance must be refunded
          const refundAmount = advance > 0 && rawNewDue < 0
            ? Math.round(Math.abs(rawNewDue) * 100) / 100
            : 0;

          t.update(customerRef, { outstandingDue: newDue, updatedAt: new Date().toISOString() });

          // Ledger entry — credit only what was actually reversed on outstandingDue
          const orderRef2 = order.orderNo || (order.id ?? "").slice(0, 8).toUpperCase();
          const ledgerEntryRef = doc(collection(db, "customers", order.customerId, "payments"));
          t.set(ledgerEntryRef, {
            type:          "order_cancelled",
            direction:     "credit",
            amount:        netDebit,      // exactly what was reversed on outstandingDue
            orderId:       order.id,
            orderNo:       order.orderNo ?? "",
            note:          `Order #${orderRef2} cancelled — ${reason.trim()}`,
            createdBy:     user!.uid,
            createdByName: user!.name,
            createdAt:     new Date().toISOString(),
          });

          // Flag refund needed on the order doc so admin / field agent can see it
          if (refundAmount > 0) {
            t.update(doc(db, "orders", order.id!), {
              refundDue:       refundAmount,
              refundNote:      `Advance of ₹${advance.toFixed(2)} was collected — ₹${refundAmount.toFixed(2)} must be returned to customer`,
            });
          }
        }
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

        {/* Advance refund notice — only shown when advance was collected */}
        {(order.advancePaid ?? 0) > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5">
            <p className="text-sm text-amber-800 font-semibold mb-1">
              💰 Advance was collected — physical refund may be required
            </p>
            <p className="text-xs text-amber-700">
              The field agent collected <strong>₹{(order.advancePaid ?? 0).toFixed(2)}</strong> as advance.
              {(order.advancePaid ?? 0) >= order.totalAmount
                ? " Since the full amount was already collected, the entire advance must be returned to the customer."
                : ` After cancellation, check the customer's remaining balance — if it reaches ₹0, the remaining advance of ₹${Math.max(0, (order.advancePaid ?? 0) - (order.totalAmount - (order.advancePaid ?? 0))).toFixed(2)} must be returned physically.`}
            </p>
          </div>
        )}

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
  smartRegionMatch,
  selectedOrders,
}: {
  count: number;
  deliveryUsers: AppUser[];
  onAssign: (person: AppUser, vehicle: string) => Promise<void>;
  onClose: () => void;
  smartRegionMatch?: boolean;
  selectedOrders?: Order[];
}) {
  const [selectedPerson, setSelectedPerson] = useState<AppUser | null>(null);
  const [vehicleNumber, setVehicleNumber]   = useState("");
  const [saving, setSaving]                 = useState(false);

  const handleAssign = async () => {
    if (!selectedPerson) return;
    setSaving(true);
    try {
      await onAssign(selectedPerson, vehicleNumber.trim());
    } catch {
      alert("Failed to assign. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // For bulk: find regions across all selected orders and match agents
  const selectedRegionIds = smartRegionMatch && selectedOrders
    ? [...new Set(selectedOrders.map(o => (o as any).regionId).filter(Boolean))]
    : [];
  // Agent must cover ALL selected regions to be suggested (not just some)
  const matchedAgents = selectedRegionIds.length > 0
    ? deliveryUsers.filter(u => selectedRegionIds.every(rid => u.assignedRegions?.includes(rid)))
    : [];
  const otherAgents = deliveryUsers.filter(u => !matchedAgents.some(m => m.uid === u.uid));
  const hasMatches = matchedAgents.length > 0;

  // Unique region names from selected orders for display
  const regionNames = selectedOrders
    ? [...new Set(selectedOrders.map(o => (o as any).regionName).filter(Boolean))]
    : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Bulk Assign Delivery</h3>
        <p className="text-sm text-gray-500 mb-1">
          Assigning <span className="font-semibold text-indigo-600">{count} packed order{count !== 1 ? "s" : ""}</span> to one delivery agent
        </p>
        {regionNames.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {regionNames.map(name => (
              <span key={name} className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">{name}</span>
            ))}
          </div>
        )}

        <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 text-xs text-indigo-700 mb-4">
          ℹ️ All selected orders will be assigned to the same agent and vehicle. Status will change to <strong>Assigned</strong>. Agent must confirm collection in their app.
        </div>

        {/* Smart region match section */}
        {smartRegionMatch && selectedRegionIds.length > 0 && (
          <div className="mb-4">
            {hasMatches ? (
              <div>
                <p className="text-xs font-semibold text-green-700 mb-2 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Region-matched agents ({matchedAgents.length})
                </p>
                <div className="space-y-2 mb-3">
                  {matchedAgents.map((u) => (
                    <button key={u.uid} type="button"
                      onClick={() => setSelectedPerson(selectedPerson?.uid === u.uid ? null : u)}
                      className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${
                        selectedPerson?.uid === u.uid
                          ? "border-green-500 bg-green-50 text-green-800"
                          : "border-green-200 bg-green-50/50 text-gray-700 hover:border-green-400"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-green-600">🎯</span>
                        <span>{u.name}</span>
                        {u.phone && <span className="text-xs text-gray-400">{u.phone}</span>}
                      </div>
                      {selectedPerson?.uid === u.uid && <span className="text-green-600 text-base">✓</span>}
                    </button>
                  ))}
                </div>
                {otherAgents.length > 0 && <p className="text-xs text-gray-400 mb-2">Other agents</p>}
              </div>
            ) : (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">
                ⚠️ No delivery agent is assigned to these regions. You can still assign any agent below.
              </p>
            )}
          </div>
        )}

        <div className="space-y-4">
          {/* Hide dropdown when a matched card is already selected */}
          {!(smartRegionMatch && hasMatches && selectedPerson && matchedAgents.some(m => m.uid === selectedPerson.uid)) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {hasMatches && smartRegionMatch ? "Other agents" : "Delivery Agent"}
              </label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                value={selectedPerson && !matchedAgents.some(m => m.uid === selectedPerson.uid) ? selectedPerson.uid : ""}
                onChange={(e) => setSelectedPerson(deliveryUsers.find((u) => u.uid === e.target.value) || null)}
              >
                <option value="">— Select agent —</option>
                {(smartRegionMatch && hasMatches ? otherAgents : deliveryUsers).map((u) => (
                  <option key={u.uid} value={u.uid}>{u.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle Number <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="text"
              value={vehicleNumber}
              onChange={(e) => setVehicleNumber(e.target.value.toUpperCase())}
              placeholder="TN 01 AB 1234"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
            />
          </div>
        </div>

        {selectedPerson && (
          <div className="mt-4 bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-600">
            <span className="font-medium">{count} order{count !== 1 ? "s" : ""}</span> → <span className="font-medium text-indigo-600">{selectedPerson.name}</span>{vehicleNumber ? ` · ${vehicleNumber}` : ""}
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
            disabled={!selectedPerson || saving}
            className="flex-1 bg-indigo-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50"
          >
            {saving ? "Assigning..." : `Assign ${count} Order${count !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
// ── Partial Return Modal ──────────────────────────────────────────
function PartialReturnModal({ order, onClose, onDone }: {
  order: Order; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuthStore();
  const [returnQtys, setReturnQtys] = useState<Record<string, number>>({});
  const [reason, setReason]         = useState("");
  const [saving, setSaving]         = useState(false);

  const hasReturns = Object.values(returnQtys).some((q) => q > 0);

  const handleSubmit = async () => {
    if (!hasReturns || !reason.trim()) return;
    setSaving(true);
    try {
      await runTransaction(db, async (t) => {
        // ── READ PHASE — all reads before any writes ──────────────
        const itemsWithReturn = order.items.filter((item) => (returnQtys[item.productId] || 0) > 0);
        const productRefs  = itemsWithReturn.map((item) => doc(db, "products", item.productId));
        const customerRef  = doc(db, "customers", order.customerId);
        const [productSnaps, customerSnap] = await Promise.all([
          Promise.all(productRefs.map((ref) => t.get(ref))),
          t.get(customerRef),
        ]);

        // ── WRITE PHASE ───────────────────────────────────────────
        // Write stock restores
        productSnaps.forEach((snap, i) => {
          if (!snap.exists()) return;
          const data = snap.data();
          if (!data.trackInventory) return;
          const returnQty = returnQtys[itemsWithReturn[i].productId] || 0;
          // Server-side cap: never restore more than was originally delivered
          const maxAllowed = itemsWithReturn[i].quantity - ((itemsWithReturn[i] as any).returnedQty || 0);
          if (returnQty > maxAllowed) {
            throw new Error(`Return qty for "${itemsWithReturn[i].productName}" exceeds delivered qty.`);
          }
          t.update(productRefs[i], { stock: (data.stock || 0) + returnQty });
        });

        // Update order with return info
        const returnItems = order.items.map((item) => ({
          ...item,
          returnedQty: returnQtys[item.productId] || 0,
        }));
        const returnedTotal = order.items.reduce((s, item) => {
          return s + (returnQtys[item.productId] || 0) * item.price;
        }, 0);

        t.update(doc(db, "orders", order.id!), {
          returnedItems:     returnItems,
          returnedTotal,
          returnReason:      reason.trim(),
          returnedAt:        new Date().toISOString(),
          returnedBy:        user!.uid,
          returnedByName:    user!.name,
        });

        // ── Credit the return value back to the customer ledger ───
        if (returnedTotal > 0) {
          if (customerSnap.exists()) {
            const currentDue = customerSnap.data().outstandingDue ?? 0;
            const newDue     = Math.max(0, Math.round((currentDue - returnedTotal) * 100) / 100);
            t.update(customerRef, { outstandingDue: newDue });
          }
          const ledgerEntryRef = doc(collection(db, "customers", order.customerId, "payments"));
          t.set(ledgerEntryRef, {
            type:          "adjustment",
            direction:     "credit",
            amount:        Math.round(returnedTotal * 100) / 100,
            orderId:       order.id,
            note:          `Return credit for order #${order.orderNo || (order.id ?? "").slice(0, 8).toUpperCase()} — ${reason.trim()}`,
            createdBy:     user!.uid,
            createdByName: user!.name,
            createdAt:     new Date().toISOString(),
          });
        }
      });
      onDone();
    } catch (err: any) {
      alert(err.message || "Failed to record return.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Record Return</h3>
            <p className="text-sm text-gray-500">{order.customerName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* FIX (MEDIUM): Warn clearly when a return was already filed */}
          {order.items.some((item) => (item as any).returnedQty > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
              ⚠️ A return has already been filed for this order. You can only return the remaining quantity for each item.
            </div>
          )}
          <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3 text-xs text-orange-700">
            Enter the quantity returned for each product. Stock will be restored automatically.
          </div>

          <div className="space-y-3">
            {order.items.map((item) => (
              <div key={item.productId} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-800">{item.productName}</p>
                  <p className="text-xs text-gray-400">
                    Delivered: {item.quantity} {item.unit}
                    {(item as any).returnedQty > 0 && (
                      <span className="text-orange-500 ml-1">(already returned: {(item as any).returnedQty})</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">Return:</span>
                  <input
                    type="number" min="0" max={item.quantity - ((item as any).returnedQty || 0)} step="1"
                    value={returnQtys[item.productId] || ""}
                    onChange={(e) => {
                      const raw = parseInt(e.target.value) || 0;
                      // Never allow more than originally delivered qty
                      const alreadyReturned = (item as any).returnedQty || 0;
                      const maxAllowed = item.quantity - alreadyReturned;
                      const v = Math.min(maxAllowed, Math.max(0, raw));
                      setReturnQtys((p) => ({ ...p, [item.productId]: v }));
                    }}
                    className="w-16 border border-gray-300 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-2 focus:ring-orange-300"
                  />
                  <span className="text-xs text-gray-400">{item.unit}</span>
                </div>
              </div>
            ))}
          </div>

          {hasReturns && (
            <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm">
              Return value: <span className="font-bold text-red-600">
                ₹{order.items.reduce((s, item) => s + (returnQtys[item.productId] || 0) * item.price, 0).toFixed(2)}
              </span>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason for return *</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Damaged, Wrong item, Excess quantity..."
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
          </div>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !hasReturns || !reason.trim()}
            className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50">
            {saving ? "Saving..." : "Record Return"}
          </button>
        </div>
      </div>
    </div>
  );
}