import * as XLSX from "xlsx";
import { useEffect, useState, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection, onSnapshot, doc, updateDoc, orderBy, query, runTransaction,
  getDocs, where
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, AppUser } from "../types";
import { useAuthStore } from "../store/authStore";
import { useModalKeyboard } from "../hooks/useModalKeyboard";
const fmtQ = (n: number) => parseFloat(n.toFixed(4)).toString();
import { recordSingleOrderPayment, devReconcileOrderPayment, getUnpaidOrderIdsOldestFirst, planSpill, writeSpill } from "../utils/ledger";
import Pagination from "../components/Pagination";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";
import HandoverModal from "../components/HandoverModal";
import InvoiceModal from "../components/InvoiceModal";
import { adminMarkDelivered, adminUndoDelivered, canAdminMarkDelivered, canAdminUndoDelivered, BULK_DELIVERABLE_STATUSES } from "../utils/delivery";

const STATUS_COLORS: Record<string, string> = {
  pending:                "bg-yellow-100 text-yellow-700",
  packed:                 "bg-blue-100 text-blue-700",
  assigned:               "bg-indigo-100 text-indigo-700",
  out_for_delivery:       "bg-purple-100 text-purple-700",
  attempted:              "bg-orange-100 text-orange-700",
  returned_to_warehouse:  "bg-red-100 text-red-700",
  delivered:              "bg-green-100 text-green-700",
  partially_delivered:         "bg-amber-100 text-amber-700",
  partially_delivered_closed:  "bg-teal-100 text-teal-700",
  cancelled:              "bg-gray-100 text-gray-500",
};
const STATUS_LABELS: Record<string, string> = {
  pending:                     "Pending",
  packed:                      "Packed",
  assigned:                    "Assigned",
  out_for_delivery:            "Out for Delivery",
  attempted:                   "Attempted",
  returned_to_warehouse:       "Returned to Warehouse",
  delivered:                   "Delivered",
  partially_delivered:         "Partial Delivery",
  partially_delivered_closed:  "Partial — Closed",
  cancelled:                   "Cancelled",
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
  const [deliverOrder, setDeliverOrder]     = useState<Order | null>(null);
  const [showBulkDeliver, setShowBulkDeliver] = useState(false);
  const [returnOrder, setReturnOrder]     = useState<Order | null>(null);
  const [receiveBackOrder, setReceiveBackOrder] = useState<Order | null>(null);
  const [reassignOrder, setReassignOrder] = useState<Order | null>(null);
  const [handoverOrder, setHandoverOrder] = useState<Order | null>(null);
  const [smartRegionMatch, setSmartRegionMatch] = useState(true);
  const { user } = useAuthStore();
  const navigate = useNavigate();

  // ── Filter state ─────────────────────────────────────────────
  const [activeTab, setActiveTab]   = useState<"all"|"pending"|"packed"|"assigned"|"out_for_delivery"|"attempted"|"returned_to_warehouse"|"delivered"|"partially_delivered"|"cancelled">("all");
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
      "customerName", "agentName", "deliveryPersonName", "id", "orderNo", "invoiceNumber", "_productNames",
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
    // Only admin can query all users — packing staff don't need the delivery agents list
    if (user?.role === "admin") {
      getDocs(query(collection(db, "users"), where("role", "==", "delivery"))).then((snap) => {
        setAllUsers(snap.docs.map((d) => d.data() as AppUser));
      });
    }
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
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;
    try {
      await runTransaction(db, async (t) => {
        // ── READ PHASE ────────────────────────────────────────────
        const orderRef  = doc(db, "orders", orderId);
        const orderSnap = await t.get(orderRef);
        if (!orderSnap.exists())                   throw new Error("Order not found.");
        if (orderSnap.data().status !== "pending") throw new Error("Order is no longer pending.");

        // Read all tracked products
        const productRefs  = order.items.map((item) => doc(db, "products", item.productId));
        const productSnaps = await Promise.all(productRefs.map((ref) => t.get(ref)));

        // ── WRITE PHASE ───────────────────────────────────────────
        // Deduct actual stock AND clear reservation — same as PackingStation
        productSnaps.forEach((snap, i) => {
          if (!snap.exists()) return;
          const data = snap.data();
          if (!data.trackInventory) return;
          const item        = order.items[i];
          const newStock    = Math.max(0, (data.stock         ?? 0) - item.quantity);
          const newReserved = Math.max(0, (data.reservedStock ?? 0) - item.quantity);
          t.update(productRefs[i], {
            stock:         newStock,
            reservedStock: newReserved,
            updatedAt:     new Date().toISOString(),
          });
        });

        t.update(orderRef, {
          status:      "packed",
          packedAt:    new Date().toISOString(),
          packedBy:    user?.uid,
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
    partially_delivered:    orders.filter((o) => o.status === "partially_delivered").length,
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

  // Packed orders can be bulk assigned; admins can also select Assigned
  // orders (bulk Mark Delivered). Variable name kept for minimal churn.
  const isSelectable = (o: Order) =>
    o.status === "packed" || (user?.role === "admin" && o.status === "assigned");
  const packedInView = paginated.filter(isSelectable);
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
      "Balance Due":       o.amountCollected !== undefined ? Math.max(0, Math.round((o.totalAmount - o.amountCollected) * 100) / 100) : "",
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
    <div className="p-3 md:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-4 gap-3">
        <h2 className="text-2xl font-bold text-gray-800">Orders</h2>
        <div className="flex flex-wrap items-center gap-2">
          {(user?.role === "admin" || user?.role === "packing_staff") && (
            <button
              onClick={() => navigate("/create-order")}
              className="flex items-center gap-2 bg-orange-500 text-white px-3 py-1.5 rounded-lg text-sm font-semibold hover:bg-orange-600 transition-all shadow-sm"
            >
              <span className="text-base leading-none">＋</span> New Order
            </button>
          )}
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs text-red-500 hover:text-red-700 underline">
              Clear filters
            </button>
          )}
          <button
            onClick={handleExcelExport}
            className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50"
          >
            ⬇️ Excel
          </button>
          <button
            onClick={() => setSmartRegionMatch(p => !p)}
            title={smartRegionMatch ? "Smart region matching ON" : "Smart region matching OFF"}
            className={`flex items-center gap-1.5 border rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
              smartRegionMatch
                ? "bg-green-50 border-green-300 text-green-700"
                : "bg-gray-50 border-gray-200 text-gray-400"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full inline-block ${smartRegionMatch ? "bg-green-500" : "bg-gray-300"}`} />
            Region
          </button>
          <button
            onClick={() => setSoundEnabled(p => !p)}
            title={soundEnabled ? "Mute order alerts" : "Enable order alerts"}
            className={`text-lg transition-all ${soundEnabled ? "opacity-100" : "opacity-30"}`}
          >
            {soundEnabled ? "🔔" : "🔕"}
          </button>
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            Live
          </div>
        </div>
      </div>

      <div className="flex gap-1 mb-4 overflow-x-auto pb-1 -mx-3 px-3 md:mx-0 md:px-0">
        {(["all","pending","packed","assigned","out_for_delivery","attempted","returned_to_warehouse","delivered","partially_delivered","cancelled"] as const).map((tab) => (
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
            placeholder="Search customer, agent, product, order no, invoice no... (supports Tamil)"
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
              {selectedIds.size} order{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-indigo-500 hover:text-indigo-700 px-3 py-1.5 rounded-lg hover:bg-indigo-100"
            >
              Clear
            </button>
            {(() => {
              const sel = [...selectedIds].map((id) => orders.find((o) => o.id === id)).filter(Boolean) as Order[];
              const packedCount = sel.filter((o) => o.status === "packed").length;
              const deliverable = sel.filter((o) => (BULK_DELIVERABLE_STATUSES as readonly string[]).includes(o.status));
              return (
                <>
                  {packedCount > 0 && (
                    <button
                      onClick={() => setShowBulkAssign(true)}
                      className="bg-indigo-500 text-white text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-indigo-600"
                    >
                      🚚 Assign {packedCount} to Delivery Agent
                    </button>
                  )}
                  {user?.role === "admin" && deliverable.length > 0 && (
                    <button
                      onClick={() => setShowBulkDeliver(true)}
                      className="bg-green-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-green-700"
                    >
                      ✅ Mark {deliverable.length} Delivered
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── Pending Handover Panel ─────────────────────────────── */}
      {(() => {
        const pendingHandovers = orders.filter(
          (o) => o.status === "partially_delivered" && o.handoverStatus === "pending_handover"
        );
        if (pendingHandovers.length === 0) return null;
        return (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xl">⚠️</span>
              <div>
                <h3 className="font-semibold text-amber-800">Pending Handovers ({pendingHandovers.length})</h3>
                <p className="text-xs text-amber-600">These delivery agents need to return goods + cash today.</p>
              </div>
            </div>
            <div className="space-y-2">
              {pendingHandovers.map((o) => {
                const returnedItems = (o.deliveredItems ?? []).filter(
                  (item) => item.deliveredQty < item.orderedQty
                );
                const partialAmt = o.partialBilledAmount ?? o.totalAmount;
                return (
                  <div key={o.id} className="bg-white rounded-lg border border-amber-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-gray-800 text-sm">
                        #{o.invoiceNumber || (o.id ?? "").slice(0, 8).toUpperCase()} — {o.customerName}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Agent: <span className="font-medium">{o.deliveryPersonName || "—"}</span>
                        &nbsp;·&nbsp;Billed: <span className="font-medium text-orange-600">₹{partialAmt.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                        &nbsp;·&nbsp;Collected: <span className="font-medium text-green-600">₹{(o.amountCollected ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                      </p>
                      {returnedItems.length > 0 && (
                        <p className="text-xs text-amber-700 mt-0.5">
                          Return: {returnedItems.map((item) =>
                            `${(item.orderedQty - item.deliveredQty).toFixed(2)} ${item.unit} ${item.productName}`
                          ).join(" · ")}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => setHandoverOrder(o)}
                      className="bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold px-4 py-2 rounded-lg"
                    >
                      Record Handover
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
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
                    title="Select all packed / assigned orders"
                  />
                )}
              </th>
              <th className="px-5 py-4">Customer</th>
              <th className="px-5 py-4">Region</th>
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
                  {isSelectable(order) && (
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
                <td className="px-5 py-3 text-gray-600 text-xs">
                  {order.regionName || <span className="text-gray-300">—</span>}
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
                    {user?.role === "admin" && canAdminMarkDelivered(order.status) && (
                      <button onClick={(e) => { e.stopPropagation(); setDeliverOrder(order); }}
                        className="bg-green-100 text-green-700 text-xs px-3 py-1.5 rounded-lg hover:bg-green-200 font-medium">
                        ✅ Mark Delivered
                      </button>
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
                    {order.status === "returned_to_warehouse" && user?.role === "admin" && (
                      <button onClick={(e) => { e.stopPropagation(); setCancelOrder(order); }}
                        className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">
                        🚫 Cancel
                      </button>
                    )}
                    {(order.status === "pending" || order.status === "packed") && user?.role === "admin" && (
                      <button onClick={(e) => { e.stopPropagation(); setCancelOrder(order); }}
                        className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">
                        Cancel
                      </button>
                    )}
                    {order.status === "delivered" &&
                      order.amountCollected !== undefined && (() => {
                        const due = Math.max(0, Math.round((order.totalAmount - order.amountCollected) * 100) / 100);
                        return due > 0 ? (
                          <span className="bg-red-100 text-red-600 text-xs px-2 py-1 rounded-lg font-medium">
                            ₹{due.toFixed(2)} due
                          </span>
                        ) : null;
                      })()}
                    {order.status === "delivered" && user?.role === "admin" && (
                      <button onClick={(e) => { e.stopPropagation(); setReturnOrder(order); }}
                        className="bg-red-100 text-red-600 text-xs px-3 py-1.5 rounded-lg hover:bg-red-200 font-medium">
                        ↩️ Return
                      </button>
                    )}
                    {(user?.role === "admin" || user?.role === "packing_staff") && (
                      <button onClick={() => setInvoiceOrder(order)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium ${
                          order.invoiceNumber
                            ? "bg-gray-100 text-gray-700 hover:bg-gray-200"
                            : "bg-orange-500 text-white hover:bg-orange-600"
                        }`}>
                        {order.invoiceNumber ? "👁 View Invoice" : "🧾 Generate Invoice"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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

      {handoverOrder && (
        <HandoverModal
          order={handoverOrder}
          onClose={() => setHandoverOrder(null)}
          onDone={() => setHandoverOrder(null)}
        />
      )}

      {showBulkAssign && (
        <BulkAssignModal
          count={[...selectedIds].filter((id) => orders.find((o) => o.id === id)?.status === "packed").length}
          deliveryUsers={deliveryUsers}
          onAssign={bulkAssignDelivery}
          onClose={() => setShowBulkAssign(false)}
          smartRegionMatch={smartRegionMatch}
          selectedOrders={[...selectedIds].map(id => orders.find(o => o.id === id)).filter((o) => o?.status === "packed") as Order[]}
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
          onMarkDelivered={(o) => { setDeliverOrder(o); setDetailOrder(null); }}
          deliveryUsers={deliveryUsers}
        />
      )}
      {deliverOrder && (
        <MarkDeliveredModal
          orders={[deliverOrder]}
          onClose={() => setDeliverOrder(null)}
          onDone={() => setDeliverOrder(null)}
        />
      )}
      {showBulkDeliver && (
        <MarkDeliveredModal
          orders={([...selectedIds].map((id) => orders.find((o) => o.id === id)).filter(Boolean) as Order[])
            .filter((o) => (BULK_DELIVERABLE_STATUSES as readonly string[]).includes(o.status))}
          onClose={() => setShowBulkDeliver(false)}
          onDone={() => { setShowBulkDeliver(false); setSelectedIds(new Set()); }}
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

// ── Mark Delivered Modal (admin) ──────────────────────────────────
// One order: date + optional payment collected at delivery.
// Several orders (bulk): date only.
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function MarkDeliveredModal({ orders, onClose, onDone }: {
  orders: Order[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { user } = useAuthStore();
  const single = orders.length === 1 ? orders[0] : null;
  const [when, setWhen]       = useState<string>(toLocalInput(new Date()));
  const [amount, setAmount]   = useState("");
  const [mode, setMode]       = useState<"cash" | "upi" | "bank" | "cheque">("cash");
  const [note, setNote]       = useState("");
  const [saving, setSaving]   = useState(false);
  const [progress, setProgress] = useState("");

  const balance = single
    ? Math.max(0, Math.round((single.totalAmount - (single.amountCollected ?? 0)) * 100) / 100)
    : 0;
  const amt = parseFloat(amount);
  const amtValid = amount.trim() === "" || (!isNaN(amt) && amt >= 0 && amt <= balance + 0.01);
  const whenDate = new Date(when);
  const whenValid = !isNaN(whenDate.getTime()) && whenDate.getTime() <= Date.now() + 60_000;
  // Orders placed AFTER the chosen date can't have been delivered on it
  const placedAfter = orders.filter((o) => o.createdAt && new Date(o.createdAt).getTime() > whenDate.getTime());
  const singleTooEarly = !!single && placedAfter.length > 0;
  const canSave = orders.length > 0 && whenValid && !singleTooEarly && amtValid && !saving
    && placedAfter.length < orders.length;

  const hasPending = orders.some((o) => o.status === "pending");
  const hasOutForDelivery = orders.some((o) => o.status === "out_for_delivery");

  const handleSave = async () => {
    if (!canSave || !user) return;
    setSaving(true);
    const iso = whenDate.toISOString();
    if (single) {
      try {
        await adminMarkDelivered({
          orderId: single.id!, deliveredAt: iso,
          amount: amount.trim() === "" ? 0 : amt, paymentMode: mode, note,
          adminId: user.uid, adminName: user.name,
        });
        onDone();
      } catch (e: any) {
        alert(e.message || "Could not mark as delivered.");
      } finally { setSaving(false); }
      return;
    }
    // Bulk — one transaction per order; report failures at the end
    const failed: string[] = [];
    const toDeliver = orders.filter((o) => !placedAfter.includes(o));
    for (let i = 0; i < toDeliver.length; i++) {
      const o = toDeliver[i];
      setProgress(`${i + 1} / ${toDeliver.length}`);
      try {
        await adminMarkDelivered({
          orderId: o.id!, deliveredAt: iso, note,
          adminId: user.uid, adminName: user.name,
        });
      } catch (e: any) {
        failed.push(`#${o.orderNo || o.id!.slice(0, 8)} (${o.customerName}): ${e.message}`);
      }
    }
    setSaving(false); setProgress("");
    if (failed.length > 0 || placedAfter.length > 0) {
      alert(
        `${toDeliver.length - failed.length} marked delivered` +
        (placedAfter.length ? `, ${placedAfter.length} skipped (placed after the chosen date)` : "") +
        (failed.length ? `, ${failed.length} failed:\n\n${failed.join("\n")}` : ".")
      );
    }
    onDone();
  };

  useModalKeyboard({ onClose, onConfirm: handleSave, disabled: !canSave });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">✅ Mark as Delivered</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {single
                ? <>#{single.orderNo || single.id!.slice(0, 8).toUpperCase()} · {single.customerName}</>
                : <>{orders.length} orders · ₹{orders.reduce((s, o) => s + o.totalAmount, 0).toFixed(2)}</>}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {hasOutForDelivery && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl px-4 py-3 text-xs text-amber-800">
              <p className="font-semibold text-sm">⚠ Delivery agent has the goods</p>
              This order is Out for Delivery. After you mark it delivered here, the delivery app can
              no longer update it. If the agent collected cash, record it via Agent Cash / the Payment tab —
              not twice.
            </div>
          )}
          {hasPending && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-800">
              This order is still <span className="font-semibold">Pending</span>. Marking it delivered will
              also pack it — stock is deducted exactly like "Mark Packed".
            </div>
          )}
          {!single && (
            <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-40 overflow-y-auto text-xs">
              {orders.map((o) => (
                <div key={o.id} className="flex justify-between px-3 py-1.5">
                  <span className="truncate">#{o.orderNo || o.id!.slice(0, 8)} · {o.customerName}</span>
                  <span className="text-gray-500 flex-shrink-0 ml-2">₹{o.totalAmount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Delivered on *</label>
            <input type="datetime-local" value={when} max={toLocalInput(new Date())}
              min={single?.createdAt ? toLocalInput(new Date(single.createdAt)) : undefined}
              onChange={(e) => setWhen(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300" />
            <p className="text-xs text-gray-400 mt-1">
              Reports use this date. Pick the real delivery date for older orders.
            </p>
            {!whenValid && <p className="text-xs text-red-500 mt-1">Date can't be in the future.</p>}
            {singleTooEarly && (
              <p className="text-xs text-red-500 mt-1">
                Order was placed on {new Date(single!.createdAt).toLocaleString("en-IN")} — delivery can't be earlier.
              </p>
            )}
            {!single && placedAfter.length > 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
                {placedAfter.length} of {orders.length} order(s) were placed after this date and will be skipped.
              </p>
            )}
          </div>

          {single && (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-gray-500">Bill</span><span>₹{single.totalAmount.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Already collected</span><span className="text-green-600">₹{(single.amountCollected ?? 0).toFixed(2)}</span></div>
                <div className="flex justify-between font-semibold"><span className="text-gray-600">Balance</span><span className={balance > 0 ? "text-red-600" : "text-green-600"}>₹{balance.toFixed(2)}</span></div>
              </div>

              {balance > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Amount collected at delivery (₹) <span className="text-xs text-gray-400 font-normal">optional</span>
                  </label>
                  <input type="number" min="0" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)} placeholder="0.00 — leave blank if not collected"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300" />
                  <div className="flex gap-2 mt-2">
                    <button type="button" onClick={() => setAmount(balance.toFixed(2))}
                      className="text-xs bg-green-100 text-green-700 px-3 py-1 rounded-full hover:bg-green-200 font-medium">
                      Full ₹{balance.toFixed(2)}
                    </button>
                    {amount && (
                      <button type="button" onClick={() => setAmount("")}
                        className="text-xs bg-gray-100 text-gray-600 px-3 py-1 rounded-full hover:bg-gray-200">
                        Not collected
                      </button>
                    )}
                  </div>
                  {!amtValid && <p className="text-xs text-red-500 mt-1">Amount must be between ₹0 and ₹{balance.toFixed(2)}.</p>}
                  {amount && amtValid && amt > 0 && (
                    <div className="flex gap-2 mt-3">
                      {(["cash", "upi", "bank", "cheque"] as const).map((m) => (
                        <button key={m} type="button" onClick={() => setMode(m)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium border capitalize ${
                            mode === m ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-500 border-gray-200"
                          }`}>{m}</button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-400 mt-1">
                    Recorded like the Payment tab (ledger + this bill), dated on the delivery date. Money received
                    directly by admin — not counted as delivery agent cash. Leave blank if the customer hasn't paid.
                  </p>
                </div>
              )}
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note <span className="text-xs text-gray-400 font-normal">optional</span></label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Delivered by shop vehicle"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300" />
          </div>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleSave} disabled={!canSave}
            className="flex-1 bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
            {saving ? (progress ? `Saving ${progress}…` : "Saving…") : single ? "Mark Delivered" : `Mark ${orders.length - placedAfter.length} Delivered`}
          </button>
        </div>
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

  const handleAssignConfirm = () => { if (!selectedPerson) return; onAssign(order.id!, selectedPerson, vehicleNumber.trim()); };
  useModalKeyboard({ onClose, onConfirm: handleAssignConfirm, disabled: !selectedPerson });

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
  onMarkDelivered,
  deliveryUsers,
}: {
  order: Order;
  onClose: () => void;
  onMarkPacked: (id: string) => void;
  onAssignAgent: (order: Order) => void;
  onInvoice: (order: Order) => void;
  onCancel: (order: Order) => void;
  onMarkDelivered?: (order: Order) => void;
  deliveryUsers: AppUser[];
}) {
  const { user: panelUser } = useAuthStore();
  const isAdmin = panelUser?.role === "admin";
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

  const isPartial = order.status === "partially_delivered" || order.status === "partially_delivered_closed";
  const isDelivered = order.status === "delivered" || isPartial;

  const timeline: { label: string; time?: string; done: boolean; color: string }[] = [
    { label: "Order Placed",      time: fmt(order.createdAt),                 done: true,                                                                                              color: order.status === "cancelled" ? "bg-red-400" : "bg-yellow-400" },
    { label: "Packed",            time: fmt(order.packedAt),                  done: !!order.packedAt,                                                                                  color: "bg-blue-400"   },
    { label: "Assigned to Agent", time: fmt(order.assignedAt),                done: !!order.assignedAt,                                                                                color: "bg-indigo-400" },
    { label: "Out for Delivery",  time: fmt((order as any).outForDeliveryAt), done: ["out_for_delivery","attempted","returned_to_warehouse","delivered","partially_delivered","partially_delivered_closed"].includes(order.status), color: "bg-purple-400" },
    ...(attempts && attempts.length > 0 ? [{
      label: `Attempted (${attempts.length}x)`,
      time:  fmt(attempts[attempts.length - 1].attemptedAt),
      done:  true,
      color: "bg-orange-400",
    }] : []),
    ...((order as any).returnedToWarehouseAt ? [{
      label: "Returned to Warehouse",
      time:  fmt((order as any).returnedToWarehouseAt),
      done:  true,
      color: "bg-red-400",
    }] : []),
    // Partial delivery — show instead of (or alongside) full delivery
    ...(isPartial ? [{
      label: order.status === "partially_delivered_closed" ? "Partial Delivery — Closed" : "Partial Delivery",
      time:  fmt(order.deliveredAt),
      done:  true,
      color: "bg-amber-400",
    }] : [
      { label: order.deliveredByAdmin ? `Delivered (marked by ${order.deliveredByName || "admin"})` : "Delivered", time: fmt(order.deliveredAt), done: order.status === "delivered", color: "bg-green-400" },
    ]),
    // Handover step — only shown for partial deliveries
    ...(isPartial ? [{
      label: order.handoverStatus === "handed_over" ? "Handover Complete" : "Pending Handover",
      time:  order.handoverAt ? fmt(order.handoverAt) : undefined,
      done:  order.handoverStatus === "handed_over",
      color: order.handoverStatus === "handed_over" ? "bg-teal-400" : "bg-gray-300",
    }] : []),
  ];

  // `amountCollected` is cumulative and already includes any advance paid at
  // order creation (see CreateOrderPage: amountCollected starts at `paid`).
  // Subtracting advancePaid again here was double-counting it — fixed.
  const balance =
    order.amountCollected !== undefined
      ? Math.max(0, Math.round((order.totalAmount - order.amountCollected) * 100) / 100)
      : null;

  const [receiveBack, setReceiveBack]   = useState(false);
  const [reassign,    setReassign]      = useState(false);
  const [showRecordPayment, setShowRecordPayment] = useState(false);
  const [showMarkAsPaid, setShowMarkAsPaid] = useState(false);
  // Dev-only tool visibility — see AppUser.devAccess. Toggled per-user
  // directly on their Firestore users/{uid} doc, never from this app's UI.
  const devAccess = isAdmin && panelUser?.devAccess === true;
  // Unlike `balance` above (which is null for orders that never had a
  // collection attempt, and is otherwise only meaningful post-delivery),
  // the dev tool works on ANY order regardless of status — draft, confirmed,
  // out for delivery, delivered, even cancelled — since reconciliation isn't
  // about the delivery workflow, it's about fixing amountCollected directly.
  // Treats a never-set amountCollected as 0 rather than hiding the button.
  const devBalance = Math.max(0, Math.round((order.totalAmount - (order.amountCollected ?? 0)) * 100) / 100);

  return (
    <>
      {receiveBack && (
        <ReceiveBackModal order={order} onClose={() => setReceiveBack(false)} onDone={() => { setReceiveBack(false); onClose(); }} />
      )}
      {reassign && (
        <ReassignDeliveryModal order={order} deliveryUsers={deliveryUsers} onClose={() => setReassign(false)} onDone={() => { setReassign(false); onClose(); }} />
      )}
      {showRecordPayment && (
        <RecordPaymentModal order={order} onClose={() => setShowRecordPayment(false)} onDone={() => { setShowRecordPayment(false); onClose(); }} />
      )}
      {showMarkAsPaid && (
        <MarkAsPaidDevModal order={order} onClose={() => setShowMarkAsPaid(false)} onDone={() => { setShowMarkAsPaid(false); onClose(); }} />
      )}
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Slide-in panel */}
      <div className="fixed right-0 top-0 h-full w-full md:max-w-xl bg-white shadow-2xl z-50 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between px-4 md:px-6 py-4 border-b border-gray-100 bg-gray-50 flex-shrink-0 gap-2">
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
                      {fmtQ(item.quantity)} {item.unit} × ₹{item.price.toFixed(2)}
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
              {/* Extra advance collected with this order that went to previous dues */}
              {(order.advanceToPreviousDues ?? 0) > 0 && (
                <div className="text-xs bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-blue-700">
                  <p>
                    + ₹{(order.advanceToPreviousDues ?? 0).toFixed(2)} collected with this order went to previous dues
                    (total cash ₹{((order.advancePaid ?? 0) + (order.advanceToPreviousDues ?? 0)).toFixed(2)})
                  </p>
                  {(order.advanceAllocations ?? []).map((a) => (
                    <p key={a.orderId} className="text-blue-500">· Order #{a.orderNo}: ₹{a.amountApplied.toFixed(2)}</p>
                  ))}
                  {(order.advanceToBalance ?? 0) > 0 && (
                    <p className="text-blue-500">· Previous balance (no open bill): ₹{(order.advanceToBalance ?? 0).toFixed(2)}</p>
                  )}
                </div>
              )}
              {/* After the advance: split what the delivery agent collected from
                  what an admin recorded (Payment tab / Mark Delivered). */}
              {order.amountCollected !== undefined &&
                order.status === "delivered" &&
                order.amountCollected !== (order.advancePaid ?? 0) && (() => {
                  const afterAdvance = Math.max(0, order.amountCollected! - (order.advancePaid ?? 0));
                  const byAdmin = Math.min(afterAdvance, order.adminCollected ?? 0);
                  const byAgent = Math.round((afterAdvance - byAdmin) * 100) / 100;
                  return (
                    <>
                      {byAgent > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-green-600 font-medium">🚚 Collected at Delivery</span>
                          <span className="font-medium text-green-600">₹{byAgent.toFixed(2)}</span>
                        </div>
                      )}
                      {byAdmin > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-green-600 font-medium">💰 Recorded by Admin</span>
                          <span className="font-medium text-green-600">₹{byAdmin.toFixed(2)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
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
              {isAdmin && isDelivered && balance !== null && balance > 0 && (
                <button onClick={() => setShowRecordPayment(true)}
                  className="w-full mt-2 bg-green-600 text-white py-2 rounded-xl text-sm font-semibold hover:bg-green-700">
                  💰 Record Payment
                </button>
              )}
              {/* DEV-ONLY: direct payment-status reconciliation tool. Only
                  ever visible when the logged-in user's own Firestore doc has
                  devAccess: true — see AppUser.devAccess. Shown regardless of
                  order status/delivery state — see devBalance above. */}
              {devAccess && devBalance > 0 && (
                <button onClick={() => setShowMarkAsPaid(true)}
                  className="w-full mt-2 bg-amber-100 text-amber-800 border border-dashed border-amber-400 py-2 rounded-xl text-sm font-semibold hover:bg-amber-200">
                  🛠 Mark as Paid (dev reconciliation)
                </button>
              )}
              {devAccess && (order.devReconciliations?.length ?? 0) > 0 && (
                <p className="text-[11px] text-amber-600 mt-1.5">
                  🛠 Reconciled {order.devReconciliations!.length}× — last by {order.lastDevReconciledByName} on{" "}
                  {fmt(order.lastDevReconciledAt)}
                </p>
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
              {(order.cancelAdvanceKept ?? 0) > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 text-xs text-blue-700">
                  <p className="font-semibold text-sm text-blue-800">₹{(order.cancelAdvanceKept ?? 0).toFixed(2)} kept toward previous due</p>
                  {(order.cancelAdvanceAllocations ?? []).map((a) => (
                    <p key={a.orderId}>· Order #{a.orderNo}: ₹{a.amountApplied.toFixed(2)}</p>
                  ))}
                </div>
              )}
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
            {isAdmin && onMarkDelivered && canAdminMarkDelivered(order.status) && (
              <button
                onClick={() => onMarkDelivered(order)}
                className="flex-1 bg-green-600 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-green-700"
              >
                ✅ Mark Delivered
              </button>
            )}
            {isAdmin && canAdminUndoDelivered(order) && (
              <button
                onClick={async () => {
                  if (!window.confirm(
                    `Undo delivery for order #${order.orderNo || order.id!.slice(0, 8)}?\n\n` +
                    `Status goes back to ${order.deliveryPersonId ? "Assigned" : "Packed"}. ` +
                    `Payments already recorded stay as they are. Stock is not changed.`
                  )) return;
                  try {
                    await adminUndoDelivered(order.id!, panelUser!.uid, panelUser!.name);
                    onClose();
                  } catch (e: any) { alert(e.message || "Could not undo delivery."); }
                }}
                className="flex-1 bg-amber-100 text-amber-800 py-2.5 rounded-xl text-sm font-medium hover:bg-amber-200"
              >
                ↩ Undo Delivered
              </button>
            )}
            {(order.status === "pending" || order.status === "packed" || order.status === "returned_to_warehouse") && isAdmin && (
              <button
                onClick={() => onCancel(order)}
                className="flex-1 bg-red-100 text-red-600 py-2.5 rounded-xl text-sm font-medium hover:bg-red-200"
              >
                🚫 Cancel Order
              </button>
            )}
            {(isAdmin || panelUser?.role === "packing_staff") && (
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
            )}
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
  useModalKeyboard({ onClose, onConfirm: handleSubmit, disabled: saving });

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

// ── Record Payment Modal (single order, admin) ──────────────────────────────
// Lets admin mark a delivered order's payment as collected — fully or
// partially — when money was received outside the normal delivery-agent
// flow (e.g. customer paid in person at the shop, by bank transfer later,
// etc). Updates order.amountCollected/balanceDue/paymentMode AND writes a
// linked ledger entry, so the order drawer, every report, and the customer
// ledger all stay in sync. See utils/ledger.ts: recordSingleOrderPayment.
function RecordPaymentModal({ order, onClose, onDone }: {
  order: Order; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuthStore();
  const alreadyCollected = order.amountCollected ?? 0;
  const remainingBalance = Math.max(0, Math.round((order.totalAmount - alreadyCollected) * 100) / 100);

  const [amount, setAmount]   = useState(String(remainingBalance));
  const [mode, setMode]       = useState<"cash" | "upi" | "bank" | "cheque" | "credit">("cash");
  const [note, setNote]       = useState("");
  const [saving, setSaving]   = useState(false);

  const amountNum = parseFloat(amount) || 0;
  const isValid = amountNum > 0 && amountNum <= remainingBalance + 0.01;

  const handleSubmit = async () => {
    if (!isValid || !order.customerId || !order.id) return;
    setSaving(true);
    try {
      await recordSingleOrderPayment(
        order.customerId,
        order.id,
        amountNum,
        mode,
        note.trim(),
        user!.uid,
        user!.name
      );
      onDone();
    } catch (err: any) {
      alert(err.message || "Failed to record payment.");
    } finally {
      setSaving(false);
    }
  };
  useModalKeyboard({ onClose, onConfirm: handleSubmit, disabled: saving || !isValid });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">💰 Record Payment</h3>
            <p className="text-sm text-gray-500">{order.customerName} — #{order.orderNo ?? order.id?.slice(0, 8).toUpperCase()}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-3 text-sm text-green-700 flex justify-between">
            <span>Balance Due</span>
            <span className="font-bold">₹{remainingBalance.toFixed(2)}</span>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount Collected <span className="text-red-500">*</span></label>
            <input
              type="number" min="0.01" max={remainingBalance} step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300"
            />
            {amountNum > 0 && amountNum < remainingBalance && (
              <p className="text-xs text-amber-600 mt-1">
                Partial payment — ₹{(remainingBalance - amountNum).toFixed(2)} will still remain due.
              </p>
            )}
            {amountNum > remainingBalance + 0.01 && (
              <p className="text-xs text-red-500 mt-1">Cannot exceed the balance due (₹{remainingBalance.toFixed(2)}).</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Payment Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as any)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300">
              <option value="cash">Cash</option>
              <option value="upi">UPI</option>
              <option value="bank">Bank Transfer</option>
              <option value="cheque">Cheque</option>
              <option value="credit">Credit</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <input
              type="text" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Collected by Ranjith via UPI"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-300"
            />
          </div>
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !isValid}
            className="flex-1 bg-green-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50">
            {saving ? "Saving..." : "✅ Record Payment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── DEV-ONLY: Mark as Paid (payment-status reconciliation) ──────────────────
// Not a normal payment action. Use ONLY to fix an order whose cash was
// already collected and recorded (e.g. a customer-level "Record Payment"
// where the specific order wasn't checked, so the ledger/outstandingDue are
// already correct but this order's own amountCollected never got updated).
// It deliberately does NOT write a ledger entry and does NOT touch
// customer.outstandingDue — see utils/ledger.ts: devReconcileOrderPayment.
// Only rendered when the logged-in user has AppUser.devAccess === true.
function MarkAsPaidDevModal({ order, onClose, onDone }: {
  order: Order; onClose: () => void; onDone: () => void;
}) {
  const { user } = useAuthStore();
  const alreadyCollected = order.amountCollected ?? 0;
  const remainingBalance = Math.max(0, Math.round((order.totalAmount - alreadyCollected) * 100) / 100);

  const [amount, setAmount]     = useState(String(remainingBalance));
  const [note, setNote]         = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState("");

  const amountNum = parseFloat(amount) || 0;
  const isValid = amountNum > 0 && amountNum <= remainingBalance + 0.01 && note.trim().length > 0 && confirmed;

  const handleSubmit = async () => {
    if (!isValid || !order.id) return;
    setSaving(true);
    setError("");
    try {
      await devReconcileOrderPayment(order.id, amountNum, note.trim(), user!.uid, user!.name);
      onDone();
    } catch (err: any) {
      setError(err.message || "Failed to reconcile order.");
    } finally {
      setSaving(false);
    }
  };
  useModalKeyboard({ onClose, onConfirm: handleSubmit, disabled: saving || !isValid });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-amber-800">🛠 Mark as Paid — Dev Reconciliation</h3>
            <p className="text-sm text-gray-500">{order.customerName} — #{order.orderNo ?? order.id?.slice(0, 8).toUpperCase()}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 leading-relaxed">
            This does <strong>not</strong> create a cash-ledger entry and does <strong>not</strong> touch the
            customer's outstanding due. It only updates this order's own payment status. Use it only when the
            cash was already recorded elsewhere (e.g. a customer-level payment that wasn't linked to this order) —
            never to record a genuinely new payment. For a real payment, close this and use "Record Payment" instead.
          </div>
          <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-600 flex justify-between">
            <span>Order Balance Due</span>
            <span className="font-bold text-gray-800">₹{remainingBalance.toFixed(2)}</span>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Amount to Mark as Paid <span className="text-red-500">*</span></label>
            <input
              type="number" min="0.01" max={remainingBalance} step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
            />
            {amountNum > remainingBalance + 0.01 && (
              <p className="text-xs text-red-500 mt-1">Cannot exceed this order's own balance due (₹{remainingBalance.toFixed(2)}).</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reason / Reference <span className="text-red-500">*</span>
            </label>
            <input
              type="text" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Cash already recorded via customer ledger on 2 Sep, order wasn't linked"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
            />
            <p className="text-xs text-gray-400 mt-1">Required — saved to this order's audit trail (devReconciliations).</p>
          </div>
          <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 rounded border-gray-300" />
            <span>I confirm this cash was already collected and recorded (e.g. in the customer ledger), and
              I'm only correcting this order's payment status — not recording a new payment.</span>
          </label>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2 text-xs text-red-600">{error}</div>
          )}
        </div>
        <div className="flex gap-3 px-6 pb-6">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleSubmit} disabled={saving || !isValid}
            className="flex-1 bg-amber-600 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-amber-700 disabled:opacity-50">
            {saving ? "Saving..." : "🛠 Mark as Paid"}
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
  useModalKeyboard({ onClose, onConfirm: handleReassign, disabled: !selectedId || saving });

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
      // Money already received on this order (advance and/or payments recorded
      // against it). On cancel it is KEPT as payment toward the customer's
      // previous due — applied to their other unpaid orders oldest-first —
      // and only what no due can absorb is flagged for refund.
      const moneyOnOrder = Math.min(
        order.amountCollected ?? order.advancePaid ?? 0,
        order.totalAmount
      );
      const otherUnpaidIds = moneyOnOrder > 0
        ? await getUnpaidOrderIdsOldestFirst(order.customerId, order.id)
        : [];

      await runTransaction(db, async (t) => {
        // ── READS FIRST ──────────────────────────────────────────
        const productRefs = order.items.map((item) =>
          doc(db, "products", item.productId)
        );
        const customerRef  = doc(db, "customers", order.customerId);
        const [productSnaps, customerSnap, otherSnaps] = await Promise.all([
          Promise.all(productRefs.map((ref) => t.get(ref))),
          t.get(customerRef),
          Promise.all(otherUnpaidIds.map((id) => t.get(doc(db, "orders", id)))),
        ]);

        // ── WRITES AFTER ALL READS ────────────────────────────────
        // FIX: Stock restore logic gated on order status.
        // • pending  → only reservedStock was held (stock never deducted by packing) → clear reservation only
        // • packed   → packing already deducted stock → restore stock AND clear reservation
        // packed = packing deducted stock; returned_to_warehouse = items came back but stock
        // was not auto-restocked (only order status changed) → restore stock in both cases
        const isPacked = order.status === "packed" || order.status === "returned_to_warehouse";
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
        // The whole bill is reversed (it was debited in full at creation).
        // Money already received on it stays as a payment toward the
        // customer's other dues:
        //   newDue  = currentDue - totalAmount            (clamped ≥ 0)
        //   refund  = the part of that money no due could absorb
        //   kept    = moneyOnOrder - refund  → applied to other unpaid orders
        //             oldest-first; any remainder is just a ledger credit
        // Ledger credit = exactly what outstandingDue went down by, so the
        // ledger and outstandingDue stay equal.
        if (customerSnap.exists()) {
          const nowIso     = new Date().toISOString();
          const currentDue = customerSnap.data().outstandingDue ?? 0;
          const rawNewDue  = Math.round((currentDue - order.totalAmount) * 100) / 100;
          const newDue     = Math.max(0, rawNewDue);
          const refundAmount = rawNewDue < 0
            ? Math.min(moneyOnOrder, Math.round(Math.abs(rawNewDue) * 100) / 100)
            : 0;
          const kept = Math.max(0, Math.round((moneyOnOrder - refundAmount) * 100) / 100);
          const reversed = Math.round((currentDue - newDue) * 100) / 100;

          const spill = planSpill(
            otherSnaps.map((s) => ({ id: s.id, data: s.exists() ? (s.data() as Order) : undefined })),
            kept
          );
          writeSpill(t, spill.allocations, nowIso);

          t.update(customerRef, { outstandingDue: newDue, updatedAt: nowIso });

          const orderRef2 = order.orderNo || (order.id ?? "").slice(0, 8).toUpperCase();
          const noteParts = [`Order #${orderRef2} cancelled — ${reason.trim()}`];
          if (kept > 0)         noteParts.push(`₹${kept.toFixed(2)} already paid kept toward previous due`);
          if (refundAmount > 0) noteParts.push(`₹${refundAmount.toFixed(2)} to be refunded`);

          const ledgerEntry: Record<string, unknown> = {
            type:          "order_cancelled",
            direction:     "credit",
            amount:        reversed,      // exactly what was reversed on outstandingDue
            orderId:       order.id,
            orderNo:       order.orderNo ?? "",
            note:          noteParts.join(" · "),
            createdBy:     user!.uid,
            createdByName: user!.name,
            createdAt:     nowIso,
          };
          if (spill.allocations.length > 0 || spill.leftover > 0) {
            const allocs = spill.allocations.map((a) => ({ orderId: a.orderId, orderNo: a.orderNo, amountApplied: a.amountApplied }));
            if (spill.leftover > 0) allocs.push({ orderId: "", orderNo: "", amountApplied: spill.leftover });
            ledgerEntry.allocations = allocs;
          }
          const ledgerEntryRef = doc(collection(db, "customers", order.customerId, "payments"));
          t.set(ledgerEntryRef, ledgerEntry);

          // Record what happened to the money on the cancelled order itself
          const orderUpd: Record<string, unknown> = {};
          if (kept > 0) {
            orderUpd.cancelAdvanceKept = kept;
            orderUpd.cancelAdvanceAllocations = spill.allocations.map((a) => ({
              orderId: a.orderId, orderNo: a.orderNo, amountApplied: a.amountApplied,
            }));
          }
          if (refundAmount > 0) {
            orderUpd.refundDue  = refundAmount;
            orderUpd.refundNote = `₹${moneyOnOrder.toFixed(2)} was collected on this order — ₹${refundAmount.toFixed(2)} must be returned to customer (no remaining due to adjust against)`;
          }
          if (Object.keys(orderUpd).length > 0) t.update(doc(db, "orders", order.id!), orderUpd);
        }
      });

      onCancelled();
    } catch (err: any) {
      alert(err.message || "Failed to cancel order. Try again.");
    } finally {
      setSaving(false);
    }
  };

  useModalKeyboard({ onClose, onConfirm: () => { if (reason.trim() && !saving) handleCancel(); }, disabled: saving });

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

        {/* Money already received on this order — kept toward previous due */}
        {(() => {
          const money = Math.min(order.amountCollected ?? order.advancePaid ?? 0, order.totalAmount);
          if (money <= 0) return null;
          return (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5">
              <p className="text-sm text-amber-800 font-semibold mb-1">
                💰 ₹{money.toFixed(2)} was already received on this order
              </p>
              <p className="text-xs text-amber-700">
                The full bill of ₹{order.totalAmount.toFixed(2)} will be reversed. The ₹{money.toFixed(2)} already
                paid is kept as payment toward the customer's previous due (oldest unpaid bills first).
                Only if the customer has no remaining due will the leftover be marked for refund.
              </p>
            </div>
          );
        })()}

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

  useModalKeyboard({ onClose, onConfirm: () => { if (selectedPerson && !saving) handleAssign(); }, disabled: !selectedPerson || saving });

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

    useModalKeyboard({ onClose, onConfirm: () => { if (hasReturns && reason.trim() && !saving) handleSubmit(); }, disabled: !hasReturns || saving });
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
                    Delivered: {fmtQ(item.quantity)} {item.unit}
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