import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order } from "../types";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell, LineChart, Line,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────
type OrderTab = "status" | "region" | "cancelled" | "delivery" | "returns" | "export";

const STATUS_COLORS: Record<string, string> = {
  pending:          "bg-yellow-100 text-yellow-700",
  packed:           "bg-blue-100 text-blue-700",
  assigned:         "bg-indigo-100 text-indigo-700",
  out_for_delivery: "bg-purple-100 text-purple-700",
  delivered:        "bg-green-100 text-green-700",
  cancelled:        "bg-gray-100 text-gray-500",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending", packed: "Packed", assigned: "Assigned",
  out_for_delivery: "Out for Delivery", delivered: "Delivered", cancelled: "Cancelled",
};
const BAR_COLORS = ["#f97316","#3b82f6","#10b981","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#ec4899"];

// ── Helpers ────────────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtINR(n: number) {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtINR0(n: number) {
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function exportXlsx(rows: any[][], filename: string, headers: string[]) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function printReport(title: string, headers: string[], rows: (string | number)[][], subtitle?: string) {
  const tableRows = rows.map(r => `<tr>${r.map(c => `<td>${c ?? "—"}</td>`).join("")}</tr>`).join("");
  const html = `<html><head><title>${title}</title>
    <style>
      body{font-family:Arial,sans-serif;font-size:11px;color:#111;margin:20px}
      h2{font-size:16px;margin-bottom:4px;color:#1f2937}
      p.sub{font-size:10px;color:#6b7280;margin-bottom:14px}
      table{width:100%;border-collapse:collapse}
      th{background:#f3f4f6;text-align:left;padding:7px 8px;font-size:9px;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #e5e7eb}
      td{padding:6px 8px;border-bottom:1px solid #f0f0f0}
      tr:last-child td{border-bottom:none}
      tfoot td{font-weight:bold;background:#fff7ed;border-top:2px solid #f97316}
      @media print{@page{margin:12mm;size:A4 landscape}}
    </style></head>
    <body>
      <h2>${title}</h2>
      <p class="sub">${subtitle ?? ""} · Printed ${new Date().toLocaleDateString("en-IN")}</p>
      <table><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${tableRows}</tbody></table>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html); w.document.close(); w.focus();
  setTimeout(() => w.print(), 400);
}

function thisMonthRange() {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
    to:   now.toISOString().slice(0, 10),
  };
}

// ── Shared UI ──────────────────────────────────────────────────────
function ActionBar({ onPrint, onExport }: { onPrint(): void; onExport(): void }) {
  return (
    <div className="flex gap-2 ml-auto">
      <button onClick={onPrint}
        className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
        🖨️ Print
      </button>
      <button onClick={onExport}
        className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
        📥 Export Excel
      </button>
    </div>
  );
}

function SCard({ label, value, sub, color = "blue" }: { label: string; value: string; sub?: string; color?: string }) {
  const borders: Record<string, string> = {
    blue: "border-blue-400", green: "border-green-400", orange: "border-orange-400",
    red: "border-red-400", purple: "border-purple-400", yellow: "border-yellow-400", gray: "border-gray-400",
  };
  return (
    <div className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${borders[color] ?? borders.blue}`}>
      <p className="text-xs text-gray-400 font-medium mb-1 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function DateRange({ from, to, setFrom, setTo }: {
  from: string; to: string; setFrom(v: string): void; setTo(v: string): void;
}) {
  const presets = [
    { label: "Today", fn() { const t = new Date().toISOString().slice(0,10); setFrom(t); setTo(t); } },
    { label: "This Month", fn() { const r = thisMonthRange(); setFrom(r.from); setTo(r.to); } },
    { label: "Last Month", fn() {
        const now = new Date(); const m = now.getMonth(); const y = now.getFullYear();
        setFrom(new Date(y, m-1, 1).toISOString().slice(0,10));
        setTo(new Date(y, m, 0).toISOString().slice(0,10));
    }},
    { label: "This Year", fn() {
        setFrom(`${new Date().getFullYear()}-01-01`);
        setTo(new Date().toISOString().slice(0,10));
    }},
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="date" value={from} onChange={e => setFrom(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
      <span className="text-gray-400 text-sm">to</span>
      <input type="date" value={to} onChange={e => setTo(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
      <div className="flex gap-1">
        {presets.map(p => (
          <button key={p.label} onClick={p.fn}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 transition-all">
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function inRange(iso: string, from: string, to: string) {
  const f = new Date(from); f.setHours(0,0,0,0);
  const t = new Date(to);   t.setHours(23,59,59,999);
  const d = new Date(iso);
  return d >= f && d <= t;
}

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
export default function OrderReports() {
  const [activeTab, setActiveTab] = useState<OrderTab>("status");
  const [orders, setOrders]       = useState<Order[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")))
      .then(snap => {
        setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() } as Order)));
        setLoading(false);
      });
  }, []);

  const tabs: { key: OrderTab; label: string; icon: string }[] = [
    { key: "status",   label: "By Status",            icon: "📊" },
    { key: "region",   label: "By Region",            icon: "🗺️" },
    { key: "cancelled",label: "Cancelled Orders",     icon: "❌" },
    { key: "delivery", label: "Delivery Performance", icon: "🚚" },
    { key: "returns",  label: "Returns",              icon: "↩️" },
    { key: "export",   label: "Daily Export",         icon: "📥" },
  ];

  if (loading) return (
    <div className="p-8 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading orders...
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">📦 Order Reports</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          {orders.length} total orders ·{" "}
          {orders.filter(o => o.status === "delivered").length} delivered ·{" "}
          {orders.filter(o => o.status === "pending").length} pending
        </p>
      </div>

      <div className="flex gap-0.5 mb-6 bg-gray-100 rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              activeTab === t.key ? "bg-white text-orange-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}>
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {activeTab === "status"    && <ByStatusReport    orders={orders} />}
      {activeTab === "region"    && <ByRegionReport    orders={orders} />}
      {activeTab === "cancelled" && <CancelledReport   orders={orders} />}
      {activeTab === "delivery"  && <DeliveryPerfReport orders={orders} />}
      {activeTab === "returns"   && <ReturnsReport     orders={orders} />}
      {activeTab === "export"    && <DailyExportReport  orders={orders} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 1. Orders by Status
// ══════════════════════════════════════════════════════════════════
function ByStatusReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);

  const filtered = useMemo(() =>
    orders.filter(o => inRange(o.createdAt, from, to)), [orders, from, to]);

  const statuses = ["pending","packed","assigned","out_for_delivery","delivered","cancelled"] as const;

  const stats = useMemo(() => statuses.map(s => {
    const list = filtered.filter(o => o.status === s);
    return {
      status: s,
      count:  list.length,
      value:  list.reduce((sum, o) => sum + o.totalAmount, 0),
      collected: list.reduce((sum, o) => sum + (o.amountCollected ?? 0), 0),
    };
  }), [filtered]);

  // Daily trend
  const dailyMap: Record<string, Record<string, number>> = {};
  filtered.forEach(o => {
    const d = o.createdAt.slice(0, 10);
    if (!dailyMap[d]) dailyMap[d] = {};
    dailyMap[d][o.status] = (dailyMap[d][o.status] || 0) + 1;
  });
  const trendData = Object.entries(dailyMap).sort().map(([date, counts]) => ({
    date: new Date(date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
    delivered:  counts["delivered"]  || 0,
    pending:    counts["pending"]    || 0,
    cancelled:  counts["cancelled"]  || 0,
  }));

  const totalOrders    = filtered.length;
  const totalValue     = filtered.filter(o => o.status !== "cancelled").reduce((s, o) => s + o.totalAmount, 0);
  const totalDelivered = filtered.filter(o => o.status === "delivered").length;
  const totalCancelled = filtered.filter(o => o.status === "cancelled").length;

  const HEADERS = ["Status", "Order Count", "% Share", "Total Value", "Collected"];
  const getRows = () => stats.map(s => [
    STATUS_LABEL[s.status], s.count,
    totalOrders > 0 ? `${((s.count / totalOrders) * 100).toFixed(1)}%` : "0%",
    s.value.toFixed(2), s.collected.toFixed(2),
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="Total Orders"    value={`${totalOrders}`}          color="blue"   sub="In period" />
        <SCard label="Delivered"       value={`${totalDelivered}`}       color="green"  sub={totalOrders > 0 ? `${((totalDelivered/totalOrders)*100).toFixed(0)}% rate` : ""} />
        <SCard label="Total Value"     value={fmtINR0(totalValue)}       color="orange" sub="Non-cancelled" />
        <SCard label="Cancelled"       value={`${totalCancelled}`}       color="red"    sub={totalOrders > 0 ? `${((totalCancelled/totalOrders)*100).toFixed(0)}% rate` : ""} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Orders by Status", HEADERS, getRows(), `Period: ${from} to ${to} · ${totalOrders} orders`)}
          onExport={() => exportXlsx(getRows(), "orders_by_status", HEADERS)}
        />
      </div>

      {/* Status breakdown cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {stats.map(s => (
          <div key={s.status} className="bg-white rounded-xl shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[s.status]}`}>
                {STATUS_LABEL[s.status]}
              </span>
              <span className="text-2xl font-bold text-gray-800">{s.count}</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-2">
              <div className="h-1.5 rounded-full bg-orange-400"
                style={{ width: totalOrders > 0 ? `${(s.count / totalOrders) * 100}%` : "0%" }} />
            </div>
            <div className="flex justify-between text-xs text-gray-400">
              <span>{totalOrders > 0 ? ((s.count / totalOrders) * 100).toFixed(1) : 0}%</span>
              <span>{fmtINR0(s.value)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Daily trend */}
      {trendData.length > 1 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Daily Order Trend</p>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Line type="monotone" dataKey="delivered" stroke="#10b981" strokeWidth={2} dot={false} name="Delivered" />
              <Line type="monotone" dataKey="pending"   stroke="#f59e0b" strokeWidth={2} dot={false} name="Pending" />
              <Line type="monotone" dataKey="cancelled" stroke="#ef4444" strokeWidth={2} dot={false} name="Cancelled" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-right">Orders</th>
              <th className="px-5 py-3 text-right">% Share</th>
              <th className="px-5 py-3 text-right">Total Value</th>
              <th className="px-5 py-3 text-right">Collected</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {stats.map(s => (
              <tr key={s.status} className="hover:bg-gray-50">
                <td className="px-5 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[s.status]}`}>
                    {STATUS_LABEL[s.status]}
                  </span>
                </td>
                <td className="px-5 py-3 text-right font-semibold text-gray-800">{s.count}</td>
                <td className="px-5 py-3 text-right text-gray-500">
                  {totalOrders > 0 ? ((s.count / totalOrders) * 100).toFixed(1) : 0}%
                </td>
                <td className="px-5 py-3 text-right text-gray-700">{fmtINR(s.value)}</td>
                <td className="px-5 py-3 text-right text-green-600">{fmtINR(s.collected)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td className="px-5 py-3 text-gray-700">Total</td>
              <td className="px-5 py-3 text-right">{totalOrders}</td>
              <td className="px-5 py-3 text-right">100%</td>
              <td className="px-5 py-3 text-right">{fmtINR(totalValue)}</td>
              <td className="px-5 py-3 text-right text-green-700">
                {fmtINR(stats.reduce((s, a) => s + a.collected, 0))}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 2. Orders by Region
// ══════════════════════════════════════════════════════════════════
function ByRegionReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() =>
    orders.filter(o => o.status !== "cancelled" && inRange(o.createdAt, from, to)),
    [orders, from, to]);

  const regionStats = useMemo(() => {
    const map: Record<string, { orders: number; value: number; delivered: number; agents: Set<string> }> = {};
    filtered.forEach(o => {
      const r = o.regionName || "Unassigned";
      if (!map[r]) map[r] = { orders: 0, value: 0, delivered: 0, agents: new Set() };
      map[r].orders++;
      map[r].value += o.totalAmount;
      if (o.status === "delivered") map[r].delivered++;
      map[r].agents.add(o.agentName);
    });
    return Object.entries(map).sort((a, b) => b[1].value - a[1].value);
  }, [filtered]);

  const drillOrders = useMemo(() => {
    if (!selected) return [];
    return filtered.filter(o => (o.regionName || "Unassigned") === selected);
  }, [selected, filtered]);

  const chartData = regionStats.slice(0, 10).map(([name, v]) => ({
    name: name.length > 12 ? name.slice(0, 12) + "…" : name,
    orders: v.orders,
    value: +v.value.toFixed(0),
  }));

  const grandValue  = regionStats.reduce((s, [, v]) => s + v.value, 0);
  const grandOrders = regionStats.reduce((s, [, v]) => s + v.orders, 0);

  const HEADERS = ["Region", "Orders", "Delivered", "Delivery %", "Total Value", "Agents"];
  const getRows = () => regionStats.map(([r, v]) => [
    r, v.orders, v.delivered,
    v.orders > 0 ? `${((v.delivered / v.orders) * 100).toFixed(0)}%` : "0%",
    v.value.toFixed(2), Array.from(v.agents).join(", "),
  ]);

  const DRILL_HEADERS = ["Date", "Invoice", "Customer", "Agent", "Amount", "Status"];
  const getDrillRows = () => drillOrders.map(o => [
    fmtDate(o.createdAt), o.invoiceNumber || o.id!, o.customerName,
    o.agentName, o.totalAmount.toFixed(2), STATUS_LABEL[o.status],
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <SCard label="Regions" value={`${regionStats.length}`} color="blue" />
        <SCard label="Total Orders" value={`${grandOrders}`} color="orange" sub="Non-cancelled" />
        <SCard label="Total Value" value={fmtINR0(grandValue)} color="green" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Orders by Region", HEADERS, getRows(), `Period: ${from} to ${to}`)}
          onExport={() => exportXlsx(getRows(), "orders_by_region", HEADERS)}
        />
      </div>

      {chartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Orders by Region (top 10)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#6b7280" }} angle={-30} textAnchor="end" interval={0} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip formatter={(v: any, n: string) => [n === "orders" ? `${v} orders` : fmtINR0(v), n === "orders" ? "Orders" : "Value"]}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Bar dataKey="orders" radius={[4,4,0,0]}>
                {chartData.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-5 py-3 text-left">Region</th>
              <th className="px-5 py-3 text-right">Orders</th>
              <th className="px-5 py-3 text-right">Delivered</th>
              <th className="px-5 py-3 text-right">Delivery %</th>
              <th className="px-5 py-3 text-right">Total Value</th>
              <th className="px-5 py-3 text-left">Agents</th>
              <th className="px-5 py-3 text-center">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {regionStats.map(([region, v]) => {
              const pct = v.orders > 0 ? (v.delivered / v.orders) * 100 : 0;
              return (
                <tr key={region} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-semibold text-gray-800">{region}</td>
                  <td className="px-5 py-3 text-right text-gray-700">{v.orders}</td>
                  <td className="px-5 py-3 text-right text-green-600">{v.delivered}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 bg-gray-100 rounded-full h-1.5">
                        <div className="h-1.5 rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-600">{pct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-800">{fmtINR0(v.value)}</td>
                  <td className="px-5 py-3 text-xs text-gray-400">
                    {Array.from(v.agents).slice(0, 2).join(", ")}
                    {v.agents.size > 2 && ` +${v.agents.size - 2}`}
                  </td>
                  <td className="px-5 py-3 text-center">
                    <button onClick={() => setSelected(selected === region ? null : region)}
                      className="text-xs bg-orange-50 text-orange-600 px-3 py-1 rounded-lg hover:bg-orange-100 border border-orange-200">
                      {selected === region ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td className="px-5 py-3 text-gray-700">Total</td>
              <td className="px-5 py-3 text-right">{grandOrders}</td>
              <td className="px-5 py-3 text-right text-green-700">{regionStats.reduce((s,[,v])=>s+v.delivered,0)}</td>
              <td colSpan={2} className="px-5 py-3 text-right">{fmtINR0(grandValue)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        {regionStats.length === 0 && <div className="text-center py-12 text-gray-400">No orders in this period.</div>}
      </div>

      {selected && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <p className="font-semibold text-gray-800">
              🗺️ {selected} — Orders <span className="text-gray-400 font-normal text-sm ml-1">({drillOrders.length})</span>
            </p>
            <ActionBar
              onPrint={() => printReport(`Region: ${selected}`, DRILL_HEADERS, getDrillRows(), `Period: ${from} to ${to}`)}
              onExport={() => exportXlsx(getDrillRows(), `region_${selected.replace(/\s+/g,"_")}`, DRILL_HEADERS)}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Invoice</th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-left">Agent</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {drillOrders.map(o => (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                    <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{o.agentName}</td>
                    <td className="px-4 py-3 text-right font-medium">{fmtINR(o.totalAmount)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[o.status]}`}>{STATUS_LABEL[o.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 3. Cancelled Orders
// ══════════════════════════════════════════════════════════════════
function CancelledReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);
  const [agentFilter, setAgentFilter] = useState("All");

  const cancelled = useMemo(() => {
    return orders.filter(o =>
      o.status === "cancelled" &&
      inRange(o.cancelledAt || o.createdAt, from, to) &&
      (agentFilter === "All" || o.agentName === agentFilter)
    );
  }, [orders, from, to, agentFilter]);

  const agents = ["All", ...Array.from(new Set(orders.map(o => o.agentName).filter(Boolean)))];
  const totalLostValue = cancelled.reduce((s, o) => s + o.totalAmount, 0);

  // Reason breakdown
  const reasonMap: Record<string, number> = {};
  cancelled.forEach(o => {
    const r = o.cancellationReason || "No reason given";
    reasonMap[r] = (reasonMap[r] || 0) + 1;
  });
  const reasons = Object.entries(reasonMap).sort((a, b) => b[1] - a[1]);

  // Agent breakdown
  const agentMap: Record<string, number> = {};
  cancelled.forEach(o => { agentMap[o.agentName] = (agentMap[o.agentName] || 0) + 1; });
  const agentBreakdown = Object.entries(agentMap).sort((a, b) => b[1] - a[1]);

  const totalInPeriod = orders.filter(o => inRange(o.createdAt, from, to)).length;
  const cancelRate    = totalInPeriod > 0 ? ((cancelled.length / totalInPeriod) * 100).toFixed(1) : "0";

  const HEADERS = ["Cancelled At", "Invoice", "Customer", "Agent", "Order Value", "Reason", "Cancelled By"];
  const getRows = () => cancelled.map(o => [
    fmtDate(o.cancelledAt || o.createdAt), o.invoiceNumber || o.id!,
    o.customerName, o.agentName, o.totalAmount.toFixed(2),
    o.cancellationReason || "—", o.cancelledByName || "—",
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <SCard label="Cancelled Orders" value={`${cancelled.length}`}    color="red"    />
        <SCard label="Lost Value"       value={fmtINR0(totalLostValue)}  color="orange" sub="Revenue not realised" />
        <SCard label="Cancel Rate"      value={`${cancelRate}%`}         color="yellow" sub="Of orders in period" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {agents.map(a => <option key={a}>{a}</option>)}
        </select>
        <ActionBar
          onPrint={() => printReport("Cancelled Orders", HEADERS, getRows(), `Period: ${from} to ${to} · Lost Value ${fmtINR0(totalLostValue)}`)}
          onExport={() => exportXlsx(getRows(), "cancelled_orders", HEADERS)}
        />
      </div>

      {(reasons.length > 0 || agentBreakdown.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl shadow-sm p-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Cancellation Reasons</p>
            <div className="space-y-2">
              {reasons.slice(0, 8).map(([reason, count]) => (
                <div key={reason} className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-gray-600 truncate">{reason}</p>
                    <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1">
                      <div className="h-1.5 rounded-full bg-red-400"
                        style={{ width: `${cancelled.length > 0 ? (count / cancelled.length) * 100 : 0}%` }} />
                    </div>
                  </div>
                  <span className="text-sm font-bold text-red-600 flex-shrink-0">{count}</span>
                </div>
              ))}
              {reasons.length === 0 && <p className="text-gray-400 text-sm">No cancellations.</p>}
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm p-5">
            <p className="text-sm font-semibold text-gray-700 mb-3">Cancellations by Agent</p>
            <div className="space-y-2">
              {agentBreakdown.map(([agent, count]) => (
                <div key={agent} className="flex items-center justify-between py-1">
                  <span className="text-sm text-gray-700">{agent}</span>
                  <span className="bg-red-100 text-red-600 text-xs font-semibold px-2 py-0.5 rounded-full">{count}</span>
                </div>
              ))}
              {agentBreakdown.length === 0 && <p className="text-gray-400 text-sm">No cancellations.</p>}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Cancelled At</th>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-right">Order Value</th>
              <th className="px-4 py-3 text-left">Reason</th>
              <th className="px-4 py-3 text-left">Cancelled By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {cancelled.map(o => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.cancelledAt || o.createdAt)}</td>
                <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{o.agentName}</td>
                <td className="px-4 py-3 text-right font-medium text-red-600">{fmtINR(o.totalAmount)}</td>
                <td className="px-4 py-3 text-xs text-gray-500 max-w-[180px] truncate">{o.cancellationReason || "—"}</td>
                <td className="px-4 py-3 text-xs text-gray-400">{o.cancelledByName || "—"}</td>
              </tr>
            ))}
          </tbody>
          {cancelled.length > 0 && (
            <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
              <tr>
                <td colSpan={4} className="px-4 py-3 text-gray-700">Total ({cancelled.length} orders)</td>
                <td className="px-4 py-3 text-right text-red-600">{fmtINR(totalLostValue)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {cancelled.length === 0 && <div className="text-center py-12 text-gray-400">🎉 No cancellations in this period!</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 4. Delivery Performance
// ══════════════════════════════════════════════════════════════════
function DeliveryPerfReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);

  const filtered = useMemo(() =>
    orders.filter(o => o.status !== "cancelled" && inRange(o.createdAt, from, to)),
    [orders, from, to]);

  const delivered = filtered.filter(o => o.status === "delivered");

  // Delivery time buckets (from assigned to delivered)
  const timings = delivered
    .filter(o => o.assignedAt && o.deliveredAt)
    .map(o => ({
      order: o,
      hours: (new Date(o.deliveredAt!).getTime() - new Date(o.assignedAt!).getTime()) / 3600000,
    }))
    .filter(t => t.hours > 0 && t.hours < 72);

  const avgHours   = timings.length > 0 ? timings.reduce((s, t) => s + t.hours, 0) / timings.length : 0;
  const sameDay    = timings.filter(t => t.hours <= 24).length;
  const nextDay    = timings.filter(t => t.hours > 24 && t.hours <= 48).length;
  const beyond     = timings.filter(t => t.hours > 48).length;

  // Delivery rate by day of week
  const dayMap: Record<number, { assigned: number; delivered: number }> = {};
  for (let i = 0; i < 7; i++) dayMap[i] = { assigned: 0, delivered: 0 };
  filtered.forEach(o => {
    const day = new Date(o.createdAt).getDay();
    dayMap[day].assigned++;
    if (o.status === "delivered") dayMap[day].delivered++;
  });
  const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const dayData = Object.entries(dayMap).map(([d, v]) => ({
    day: DAY_NAMES[+d], orders: v.assigned, delivered: v.delivered,
    rate: v.assigned > 0 ? +((v.delivered / v.assigned) * 100).toFixed(0) : 0,
  }));

  const totalOrders   = filtered.length;
  const deliveryRate  = totalOrders > 0 ? ((delivered.length / totalOrders) * 100).toFixed(1) : "0";

  const HEADERS = ["Invoice", "Customer", "Agent", "Delivery Agent", "Created", "Assigned At", "Delivered At", "Hours Taken"];
  const getRows = () => timings.map(t => [
    t.order.invoiceNumber || t.order.id!, t.order.customerName,
    t.order.agentName, t.order.deliveryPersonName || "—",
    fmtDate(t.order.createdAt), fmtDate(t.order.assignedAt!), fmtDate(t.order.deliveredAt!),
    t.hours.toFixed(1),
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="Total Orders"   value={`${totalOrders}`}         color="blue" />
        <SCard label="Delivered"      value={`${delivered.length}`}    color="green" sub={`${deliveryRate}% rate`} />
        <SCard label="Avg Delivery"   value={timings.length > 0 ? `${avgHours.toFixed(1)}h` : "—"} color="orange" sub="Assigned → Delivered" />
        <SCard label="Same Day (≤24h)" value={`${sameDay}`}           color="purple" sub={`${nextDay} next-day, ${beyond} beyond`} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Delivery Performance", HEADERS, getRows(), `Avg ${avgHours.toFixed(1)}h · ${deliveryRate}% rate`)}
          onExport={() => exportXlsx(getRows(), "delivery_performance", HEADERS)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Day-of-week pattern */}
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Orders by Day of Week</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dayData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Bar dataKey="orders"    fill="#e5e7eb" radius={[4,4,0,0]} name="Assigned" />
              <Bar dataKey="delivered" fill="#10b981" radius={[4,4,0,0]} name="Delivered" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Timing buckets */}
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Delivery Time Breakdown</p>
          {timings.length === 0
            ? <p className="text-gray-400 text-sm text-center py-8">No timing data available.</p>
            : (
              <div className="space-y-4 mt-2">
                {[
                  { label: "Same Day (≤ 24h)", count: sameDay, color: "bg-green-400" },
                  { label: "Next Day (24–48h)", count: nextDay, color: "bg-yellow-400" },
                  { label: "Beyond 48h",        count: beyond,  color: "bg-red-400" },
                ].map(b => (
                  <div key={b.label}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-600">{b.label}</span>
                      <span className="font-semibold text-gray-800">{b.count}</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div className={`h-2 rounded-full ${b.color}`}
                        style={{ width: timings.length > 0 ? `${(b.count / timings.length) * 100}%` : "0%" }} />
                    </div>
                  </div>
                ))}
                <p className="text-xs text-gray-400 pt-2">Based on {timings.length} orders with full timing data</p>
              </div>
            )
          }
        </div>
      </div>

      {/* Detail table */}
      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Delivery Agent</th>
              <th className="px-4 py-3 text-center">Assigned</th>
              <th className="px-4 py-3 text-center">Delivered</th>
              <th className="px-4 py-3 text-center">Time Taken</th>
              <th className="px-4 py-3 text-center">Speed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {timings.slice(0, 100).map(t => (
              <tr key={t.order.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs text-blue-700">{t.order.invoiceNumber || t.order.id}</td>
                <td className="px-4 py-3 text-gray-800">{t.order.customerName}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{t.order.deliveryPersonName || "—"}</td>
                <td className="px-4 py-3 text-center text-xs text-gray-500">{fmtDate(t.order.assignedAt!)}</td>
                <td className="px-4 py-3 text-center text-xs text-gray-500">{fmtDate(t.order.deliveredAt!)}</td>
                <td className="px-4 py-3 text-center font-medium text-gray-800">{t.hours.toFixed(1)}h</td>
                <td className="px-4 py-3 text-center">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    t.hours <= 24 ? "bg-green-100 text-green-700" :
                    t.hours <= 48 ? "bg-yellow-100 text-yellow-700" :
                    "bg-red-100 text-red-700"}`}>
                    {t.hours <= 24 ? "Same Day" : t.hours <= 48 ? "Next Day" : "Delayed"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {timings.length === 0 && <div className="text-center py-12 text-gray-400">No delivery timing data available.</div>}
        {timings.length > 100 && (
          <div className="text-center py-3 text-xs text-gray-400">Showing 100 of {timings.length} — export for full list</div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 5. Returns Report
// ══════════════════════════════════════════════════════════════════
function ReturnsReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);

  const returns = useMemo(() => {
    return (orders as any[]).filter(o =>
      o.returnedAt && inRange(o.returnedAt, from, to)
    ) as (Order & { returnedAt: string; returnedTotal: number; returnReason: string; returnedByName: string; returnedItems: any[] })[];
  }, [orders, from, to]);

  const totalReturnValue = returns.reduce((s, o) => s + (o.returnedTotal || 0), 0);

  // Product-wise returns
  const productMap: Record<string, { name: string; qty: number; value: number }> = {};
  returns.forEach(o => {
    (o.returnedItems || []).forEach((item: any) => {
      if (!item.returnedQty || item.returnedQty <= 0) return;
      if (!productMap[item.productId]) productMap[item.productId] = { name: item.productName, qty: 0, value: 0 };
      productMap[item.productId].qty   += item.returnedQty;
      productMap[item.productId].value += item.returnedQty * item.price;
    });
  });
  const productReturns = Object.values(productMap).sort((a, b) => b.qty - a.qty);

  const HEADERS = ["Returned At", "Invoice", "Customer", "Agent", "Return Value", "Reason", "By"];
  const getRows = () => returns.map(o => [
    fmtDate(o.returnedAt), o.invoiceNumber || o.id!, o.customerName, o.agentName,
    (o.returnedTotal || 0).toFixed(2), o.returnReason || "—", o.returnedByName || "—",
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <SCard label="Return Orders"   value={`${returns.length}`}        color="orange" />
        <SCard label="Total Returned"  value={fmtINR0(totalReturnValue)}  color="red"    sub="Value of returned goods" />
        <SCard label="Products"        value={`${productReturns.length}`} color="purple" sub="Unique products returned" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Returns Report", HEADERS, getRows(), `Period: ${from} to ${to} · Return Value ${fmtINR0(totalReturnValue)}`)}
          onExport={() => exportXlsx(getRows(), "returns_report", HEADERS)}
        />
      </div>

      {productReturns.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-3">Most Returned Products</p>
          <div className="space-y-2">
            {productReturns.slice(0, 10).map(p => (
              <div key={p.name} className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-700">{p.name}</span>
                    <span className="text-gray-500 text-xs">{p.qty} units · {fmtINR0(p.value)}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full bg-red-400"
                      style={{ width: `${productReturns[0].qty > 0 ? (p.qty / productReturns[0].qty) * 100 : 0}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Returned At</th>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-right">Return Value</th>
              <th className="px-4 py-3 text-left">Reason</th>
              <th className="px-4 py-3 text-left">Recorded By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {returns.map(o => (
              <tr key={o.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.returnedAt)}</td>
                <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{o.agentName}</td>
                <td className="px-4 py-3 text-right font-medium text-red-600">{fmtINR(o.returnedTotal || 0)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{o.returnReason || "—"}</td>
                <td className="px-4 py-3 text-xs text-gray-400">{o.returnedByName || "—"}</td>
              </tr>
            ))}
          </tbody>
          {returns.length > 0 && (
            <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
              <tr>
                <td colSpan={4} className="px-4 py-3 text-gray-700">Total ({returns.length} returns)</td>
                <td className="px-4 py-3 text-right text-red-600">{fmtINR(totalReturnValue)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {returns.length === 0 && <div className="text-center py-12 text-gray-400">No returns in this period.</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 6. Daily Export
// ══════════════════════════════════════════════════════════════════
function DailyExportReport({ orders }: { orders: Order[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "packed" | "assigned" | "out_for_delivery" | "delivered" | "cancelled">("all");
  const [agentFilter, setAgentFilter]   = useState("All");

  const agents = ["All", ...Array.from(new Set(orders.map(o => o.agentName).filter(Boolean)))];

  const filtered = useMemo(() => {
    return orders.filter(o => {
      if (!inRange(o.createdAt, date, date)) return false;
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (agentFilter !== "All" && o.agentName !== agentFilter) return false;
      return true;
    });
  }, [orders, date, statusFilter, agentFilter]);

  const totalValue     = filtered.filter(o => o.status !== "cancelled").reduce((s, o) => s + o.totalAmount, 0);
  const totalCollected = filtered.reduce((s, o) => s + (o.amountCollected ?? 0), 0);
  const totalItems     = filtered.reduce((s, o) => s + o.items.reduce((is, i) => is + i.quantity, 0), 0);

  const HEADERS = [
    "Invoice No.", "Date", "Customer", "Customer Phone", "Address", "Region",
    "Field Agent", "Delivery Agent", "Vehicle",
    "Items", "Total Qty", "Total Amount", "Amount Collected", "Balance Due",
    "Payment Mode", "Status", "Packed At", "Delivered At",
    "Invoice Type", "Notes",
  ];

  const getRows = () => filtered.map(o => [
    o.invoiceNumber || o.id!,
    fmtDate(o.createdAt),
    o.customerName,
    o.customerPhone || "—",
    o.customerAddress || "—",
    o.regionName || "—",
    o.agentName,
    o.deliveryPersonName || "—",
    o.vehicleNumber || "—",
    o.items.map(i => `${i.productName} x${i.quantity}`).join("; "),
    o.items.reduce((s, i) => s + i.quantity, 0),
    o.totalAmount.toFixed(2),
    (o.amountCollected ?? 0).toFixed(2),
    Math.max(0, o.totalAmount - (o.amountCollected ?? 0)).toFixed(2),
    o.paymentMode || "—",
    STATUS_LABEL[o.status],
    o.packedAt    ? fmtDate(o.packedAt)    : "—",
    o.deliveredAt ? fmtDate(o.deliveredAt) : "—",
    o.invoiceType || "—",
    o.notes || "—",
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="Orders" value={`${filtered.length}`} color="blue" sub="On selected date" />
        <SCard label="Order Value" value={fmtINR0(totalValue)} color="green" />
        <SCard label="Collected" value={fmtINR0(totalCollected)} color="orange" />
        <SCard label="Total Items" value={`${totalItems}`} color="purple" sub="Units across all orders" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Date:</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        </div>
        <div className="flex gap-1">
          <button onClick={() => { const d = new Date(date); d.setDate(d.getDate()-1); setDate(d.toISOString().slice(0,10)); }}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-gray-100">← Prev</button>
          <button onClick={() => setDate(today)}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-orange-50 hover:text-orange-600">Today</button>
          <button onClick={() => { const d = new Date(date); d.setDate(d.getDate()+1); if(d.toISOString().slice(0,10)<=today) setDate(d.toISOString().slice(0,10)); }}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-gray-100">Next →</button>
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as any)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="all">All Statuses</option>
          {(["pending","packed","assigned","out_for_delivery","delivered","cancelled"] as const).map(s => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {agents.map(a => <option key={a}>{a}</option>)}
        </select>
        <ActionBar
          onPrint={() => printReport(`Daily Order Export — ${fmtDate(date)}`, HEADERS, getRows(),
            `${filtered.length} orders · Value ${fmtINR0(totalValue)} · Collected ${fmtINR0(totalCollected)}`)}
          onExport={() => exportXlsx(getRows(), `orders_export_${date}`, HEADERS)}
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Region</th>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-left">Delivery</th>
              <th className="px-4 py-3 text-left">Items</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 text-right">Collected</th>
              <th className="px-4 py-3 text-center">Mode</th>
              <th className="px-4 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(o => {
              const balance = Math.max(0, o.totalAmount - (o.amountCollected ?? 0));
              return (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-800">{o.customerName}</p>
                    {o.customerPhone && <p className="text-xs text-gray-400">{o.customerPhone}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{o.regionName || "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{o.agentName}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{o.deliveryPersonName || "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-[160px]">
                    <p className="truncate">{o.items.map(i => `${i.productName} ×${i.quantity}`).join(", ")}</p>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmtINR(o.totalAmount)}</td>
                  <td className="px-4 py-3 text-right">
                    <p className="text-green-600 font-medium">{fmtINR(o.amountCollected ?? 0)}</p>
                    {balance > 0 && <p className="text-red-500 text-xs">{fmtINR(balance)} due</p>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full capitalize">
                      {o.paymentMode || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[o.status]}`}>
                      {STATUS_LABEL[o.status]}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
              <tr>
                <td colSpan={6} className="px-4 py-3 text-gray-700">Total ({filtered.length} orders)</td>
                <td className="px-4 py-3 text-right">{fmtINR(totalValue)}</td>
                <td className="px-4 py-3 text-right text-green-700">{fmtINR(totalCollected)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            No orders found for {fmtDate(date)}.
          </div>
        )}
      </div>
    </div>
  );
}