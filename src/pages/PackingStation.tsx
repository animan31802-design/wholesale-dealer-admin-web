import { useEffect, useState, useMemo } from "react";
import {
  collection, onSnapshot, doc, runTransaction, query, where
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order } from "../types";
import { useAuthStore } from "../store/authStore";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";

type DateFilter = "today" | "yesterday" | "week" | "all" | "custom";

function getDateBounds(filter: DateFilter, customDate: string): [Date | null, Date | null] {
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (filter === "all")    return [null, null];
  if (filter === "today")  return [today, null];
  if (filter === "yesterday") {
    const y = new Date(today); y.setDate(y.getDate() - 1);
    const ye = new Date(today); ye.setMilliseconds(-1);
    return [y, ye];
  }
  if (filter === "week") {
    const w = new Date(today); w.setDate(w.getDate() - 6);
    return [w, null];
  }
  if (filter === "custom" && customDate) {
    const from = new Date(customDate);
    const to   = new Date(customDate); to.setHours(23, 59, 59, 999);
    return [from, to];
  }
  return [today, null];
}

export default function PackingStation() {
  const { user } = useAuthStore();
  const [orders, setOrders]         = useState<Order[]>([]);
  const [loading, setLoading]       = useState(true);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // ── Filter state ────────────────────────────────────────────────
  const [dateFilter, setDateFilter] = useState<DateFilter>("today");
  const [customDate, setCustomDate] = useState("");
  const [regionFilter, setRegionFilter] = useState("");

  // ── Tamil-aware search ────────────────────────────────────────────────────
  const { query: search, setQuery: setSearch, results: searchResults } =
    useTamilSearch(orders as unknown as Record<string, unknown>[], ["customerName", "agentName"]);

  useEffect(() => {
    const q = query(collection(db, "orders"), where("status", "==", "pending"));
    const unsub = onSnapshot(q, (snap) => {
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order));
      docs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      setOrders(docs);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const markPacked = async (order: Order) => {
    setConfirmingId(order.id!);
    try {
      await runTransaction(db, async (t) => {
        // ── READ PHASE (all reads before any write) ───────────────
        const orderRef     = doc(db, "orders", order.id!);
        const orderSnap    = await t.get(orderRef);
        if (!orderSnap.exists())                  throw new Error("Order not found.");
        if (orderSnap.data().status !== "pending") throw new Error("Order is no longer pending.");

        // Read every tracked product involved in this order
        const productRefs  = order.items.map((item) => doc(db, "products", item.productId));
        const productSnaps = await Promise.all(productRefs.map((ref) => t.get(ref)));

        // ── WRITE PHASE ───────────────────────────────────────────
        // FIX: deduct actual stock and clear reservation for each tracked product
        productSnaps.forEach((snap, i) => {
          if (!snap.exists()) return;
          const data = snap.data();
          if (!data.trackInventory) return;          // skip untracked products
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
      alert(err.message || "Failed to mark as packed. Please refresh and try again.");
    } finally {
      setConfirmingId(null);
    }
  };

  // ── Derived values ───────────────────────────────────────────────
  const regions = useMemo(() =>
    [...new Set(orders.map((o) => (o as any).regionName).filter(Boolean))].sort(),
    [orders]
  );

  const filtered = useMemo(() => {
    const [from, to] = getDateBounds(dateFilter, customDate);
    return (searchResults as unknown as Order[]).filter((o) => {
      const d = new Date(o.createdAt);
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      if (regionFilter && (o as any).regionName !== regionFilter) return false;
      return true;
    });
  }, [searchResults, dateFilter, customDate, regionFilter]);

  const totalItems = filtered.reduce((s, o) => s + o.items.reduce((si, i) => si + i.quantity, 0), 0);
  const totalValue = filtered.reduce((s, o) => s + o.totalAmount, 0);
  const hasFilters = dateFilter !== "today" || search || regionFilter;

  // ── Print packing list ───────────────────────────────────────────
  const handlePrint = () => {
    const w = window.open("", "_blank");
    if (!w) return;
    const rows = filtered.map((order, idx) => `
      <div class="order" style="margin-bottom:24px;page-break-inside:avoid">
        <div class="order-header" style="display:flex;justify-content:space-between;background:#f97316;color:white;padding:8px 14px;border-radius:6px 6px 0 0">
          <span><strong>#${idx + 1} — ${order.customerName}</strong> &nbsp;·&nbsp; ${order.agentName}</span>
          <span>₹${order.totalAmount.toFixed(2)}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#fff7ed">
              <th style="padding:6px 10px;text-align:left;border-bottom:1px solid #e5e7eb">Product</th>
              <th style="padding:6px 10px;text-align:center;border-bottom:1px solid #e5e7eb">Qty</th>
              <th style="padding:6px 10px;text-align:right;border-bottom:1px solid #e5e7eb">Amount</th>
              <th style="padding:6px 10px;text-align:center;border-bottom:1px solid #e5e7eb">✓</th>
            </tr>
          </thead>
          <tbody>
            ${order.items.map((item) => `
              <tr>
                <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${item.productName}</td>
                <td style="padding:6px 10px;text-align:center;border-bottom:1px solid #f3f4f6"><strong>${item.quantity} ${item.unit}</strong></td>
                <td style="padding:6px 10px;text-align:right;border-bottom:1px solid #f3f4f6">₹${item.total.toFixed(2)}</td>
                <td style="padding:6px 10px;text-align:center;border-bottom:1px solid #f3f4f6">☐</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        ${order.notes ? `<div style="background:#fefce8;border:1px solid #fde68a;padding:6px 10px;font-size:12px;margin-top:4px;border-radius:0 0 6px 6px">📝 ${order.notes}</div>` : ""}
      </div>
    `).join("");

    w.document.write(`
      <html><head><title>Packing List</title>
      <style>
        body{font-family:Arial,sans-serif;padding:20px;color:#222}
        h2{margin-bottom:4px;font-size:18px}
        p.sub{color:#666;font-size:12px;margin-bottom:20px}
        @media print{body{padding:0}}
      </style></head><body>
      <h2>📦 Packing List</h2>
      <p class="sub">${filtered.length} orders · ${totalItems} total units · ₹${totalValue.toFixed(2)} · ${new Date().toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" })}</p>
      ${rows}
      </body></html>
    `);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 400);
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
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Packing Queue</h2>
          <p className="text-gray-500 text-sm mt-0.5">Sorted oldest first — pack in order.</p>
        </div>
        <div className="flex items-center gap-3">
          {filtered.length > 0 && (
            <button onClick={handlePrint}
              className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
              🖨️ Print Packing List
            </button>
          )}
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
            Live
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-sm p-4 mb-5 space-y-3">
        {/* Date filter */}
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs text-gray-500 font-medium w-12">Date</span>
          {(["today","yesterday","week","all","custom"] as DateFilter[]).map((f) => (
            <button key={f} onClick={() => setDateFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                dateFilter === f
                  ? "bg-orange-500 text-white"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200"
              }`}>
              {f === "today" ? "Today" : f === "yesterday" ? "Yesterday" : f === "week" ? "This Week" : f === "all" ? "All" : "Custom Date"}
            </button>
          ))}
          {dateFilter === "custom" && (
            <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-300" />
          )}
        </div>

        {/* Search + Region */}
        <div className="flex gap-2 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <TamilSearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search customer or agent... (supports Tamil)"
            />
          </div>

          {regions.length > 0 && (
            <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
              <option value="">All Regions</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}

          {hasFilters && (
            <button onClick={() => { setDateFilter("today"); setSearch(""); setRegionFilter(""); setCustomDate(""); }}
              className="text-xs text-red-500 hover:text-red-700 px-3 py-2 underline">
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="bg-yellow-100 border border-yellow-200 rounded-xl px-5 py-3 flex items-center gap-3">
          <span className="text-2xl font-bold text-yellow-700">{filtered.length}</span>
          <span className="text-sm text-yellow-600 font-medium">
            {filtered.length === orders.length ? "orders pending" : `of ${orders.length} pending (filtered)`}
          </span>
        </div>
        {filtered.length > 0 && (
          <>
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm">
              <span className="text-blue-600 font-medium">{totalItems}</span>
              <span className="text-blue-500 ml-1">total units</span>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm">
              <span className="text-green-600 font-medium">₹{totalValue.toFixed(2)}</span>
              <span className="text-green-500 ml-1">total value</span>
            </div>
          </>
        )}
      </div>

      {/* Orders list */}
      {filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-400">
          <div className="text-5xl mb-4">{orders.length === 0 ? "✅" : "🔍"}</div>
          <p className="text-lg font-medium text-gray-500">
            {orders.length === 0 ? "All packed!" : "No orders match your filters"}
          </p>
          <p className="text-sm mt-1">
            {orders.length === 0
              ? "No pending orders right now."
              : `${orders.length} pending orders exist — try changing the filters.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((order, idx) => (
            <div key={order.id}
              className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              {/* Order header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 rounded-full bg-orange-100 text-orange-600 text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <div>
                    <p className="font-semibold text-gray-800">{order.customerName}</p>
                    <p className="text-xs text-gray-400">{order.customerAddress}</p>
                    <div className="flex gap-2 mt-1">
                      {(order as any).regionName && (
                        <span className="text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full font-medium">
                          {(order as any).regionName}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-bold text-gray-800">₹{order.totalAmount.toFixed(2)}</p>
                  <p className="text-xs text-gray-400">
                    By {order.agentName}
                  </p>
                  <p className="text-xs text-gray-400">
                    {new Date(order.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                    {" · "}
                    {new Date(order.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
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
                      <tr key={i}>
                        <td className="py-2 text-gray-700 font-medium">{item.productName}</td>
                        <td className="py-2 text-center text-gray-500">{item.quantity} {item.unit}</td>
                        <td className="py-2 text-right text-gray-700">₹{item.total.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {order.notes && (
                  <div className="mt-3 bg-yellow-50 border border-yellow-100 rounded-lg px-3 py-2 text-xs text-yellow-700">
                    📝 {order.notes}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                <div className="text-xs text-gray-400">
                  {order.items.length} product{order.items.length !== 1 ? "s" : ""} ·{" "}
                  {order.items.reduce((s, i) => s + i.quantity, 0)} units
                </div>
                <button
                  onClick={() => markPacked(order)}
                  disabled={confirmingId === order.id}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition-all flex items-center gap-2"
                >
                  {confirmingId === order.id ? (
                    <>
                      <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                      Confirming...
                    </>
                  ) : "✅ Mark as Packed"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}