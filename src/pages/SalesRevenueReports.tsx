import { useEffect, useState, useMemo, useRef } from "react";
import { collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, Product } from "../types";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────
type ReportTab =
  | "daily_revenue"
  | "trend"
  | "by_region"
  | "by_agent"
  | "top_products"
  | "by_category";

type DateRange = "7d" | "30d" | "90d" | "custom";

const COLORS = ["#f97316","#3b82f6","#10b981","#8b5cf6","#ec4899","#f59e0b","#06b6d4","#84cc16"];

// ── Helpers ───────────────────────────────────────────────────────
function formatCurrency(v: number) {
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function getDateRange(range: DateRange, customFrom: string, customTo: string): [Date, Date] {
  const to   = new Date(); to.setHours(23, 59, 59, 999);
  const from = new Date();
  if (range === "7d")     from.setDate(from.getDate() - 6);
  else if (range === "30d") from.setDate(from.getDate() - 29);
  else if (range === "90d") from.setDate(from.getDate() - 89);
  else {
    return [
      customFrom ? new Date(customFrom) : new Date(new Date().setDate(new Date().getDate() - 29)),
      customTo   ? new Date(customTo + "T23:59:59") : to,
    ];
  }
  from.setHours(0, 0, 0, 0);
  return [from, to];
}

// ── Print helper ──────────────────────────────────────────────────
function printDiv(id: string, title: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`
    <html><head><title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; color: #222; }
      h1 { font-size: 18px; margin-bottom: 4px; }
      p.sub { font-size: 12px; color: #666; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; font-size: 13px; }
      th { background: #f97316; color: white; padding: 8px 12px; text-align: left; }
      td { padding: 7px 12px; border-bottom: 1px solid #f0f0f0; }
      tr:nth-child(even) td { background: #fafafa; }
      .total-row td { font-weight: bold; background: #fff3e0 !important; }
      @media print { body { padding: 0; } }
    </style></head><body>
    ${el.innerHTML}
    </body></html>
  `);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 400);
}

// ── Main component ────────────────────────────────────────────────
export default function SalesRevenueReports() {
  const [orders, setOrders]     = useState<Order[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading]   = useState(true);
  const [activeTab, setActiveTab] = useState<ReportTab>("daily_revenue");
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]     = useState("");
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u1 = onSnapshot(query(collection(db, "orders"), orderBy("createdAt", "desc")), (snap) => {
      setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
      setLoading(false);
    });
    const u2 = onSnapshot(query(collection(db, "products"), orderBy("name")), (snap) => {
      setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product)));
    });
    return () => { u1(); u2(); };
  }, []);

  const [fromDate, toDate] = getDateRange(dateRange, customFrom, customTo);

  // Only delivered + active orders in date range for revenue reports
  const filteredOrders = useMemo(() =>
    orders.filter((o) => {
      const d = new Date(o.createdAt);
      return d >= fromDate && d <= toDate && o.status !== "cancelled";
    }), [orders, fromDate, toDate]
  );

  const deliveredOrders = filteredOrders.filter((o) => o.status === "delivered");

  // ── Report data computations ─────────────────────────────────────

  // 1. Daily revenue
  const dailyData = useMemo(() => {
    const map: Record<string, { date: string; label: string; revenue: number; orders: number; collected: number }> = {};
    const cur = new Date(fromDate);
    while (cur <= toDate) {
      const key = cur.toDateString();
      map[key] = {
        date: cur.toISOString(),
        label: cur.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
        revenue: 0, orders: 0, collected: 0,
      };
      cur.setDate(cur.getDate() + 1);
    }
    filteredOrders.forEach((o) => {
      const key = new Date(o.createdAt).toDateString();
      if (map[key]) {
        map[key].revenue   += o.totalAmount;
        map[key].orders    += 1;
        map[key].collected += o.amountCollected ?? 0;
      }
    });
    return Object.values(map);
  }, [filteredOrders, fromDate, toDate]);

  // 2. Weekly/monthly trend
  const trendData = useMemo(() => {
    const map: Record<string, { label: string; revenue: number; orders: number }> = {};
    filteredOrders.forEach((o) => {
      const d = new Date(o.createdAt);
      const key = `${d.getFullYear()}-W${String(Math.ceil(d.getDate()/7)).padStart(2,"0")}-${d.getMonth()}`;
      const label = `${d.toLocaleDateString("en-IN",{day:"2-digit",month:"short"})}`;
      if (!map[key]) map[key] = { label, revenue: 0, orders: 0 };
      map[key].revenue += o.totalAmount;
      map[key].orders  += 1;
    });
    return Object.values(map).slice(-12);
  }, [filteredOrders]);

  // 3. Revenue by region
  const regionData = useMemo(() => {
    const map: Record<string, { region: string; revenue: number; orders: number }> = {};
    filteredOrders.forEach((o) => {
      const r = (o as any).regionName || "Unknown";
      if (!map[r]) map[r] = { region: r, revenue: 0, orders: 0 };
      map[r].revenue += o.totalAmount;
      map[r].orders  += 1;
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders]);

  // 4. Revenue by field agent
  const agentData = useMemo(() => {
    const map: Record<string, { agent: string; revenue: number; orders: number; collected: number }> = {};
    filteredOrders.forEach((o) => {
      const a = o.agentName;
      if (!map[a]) map[a] = { agent: a, revenue: 0, orders: 0, collected: 0 };
      map[a].revenue   += o.totalAmount;
      map[a].orders    += 1;
      map[a].collected += o.amountCollected ?? 0;
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders]);

  // 5. Top products
  const productData = useMemo(() => {
    const map: Record<string, { name: string; revenue: number; qty: number; orders: number }> = {};
    filteredOrders.forEach((o) => {
      o.items.forEach((item) => {
        if (!map[item.productId]) map[item.productId] = { name: item.productName, revenue: 0, qty: 0, orders: 0 };
        map[item.productId].revenue += item.total;
        map[item.productId].qty     += item.quantity;
        map[item.productId].orders  += 1;
      });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders]);

  // 6. Revenue by category
  const categoryData = useMemo(() => {
    const map: Record<string, { category: string; revenue: number; qty: number }> = {};
    filteredOrders.forEach((o) => {
      o.items.forEach((item) => {
        const p = products.find((p) => p.id === item.productId);
        const cat = p?.category || "Uncategorized";
        if (!map[cat]) map[cat] = { category: cat, revenue: 0, qty: 0 };
        map[cat].revenue += item.total;
        map[cat].qty     += item.quantity;
      });
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [filteredOrders, products]);

  // ── Summary totals ───────────────────────────────────────────────
  const totalRevenue   = filteredOrders.reduce((s, o) => s + o.totalAmount, 0);
  const totalCollected = filteredOrders.reduce((s, o) => s + (o.amountCollected ?? 0), 0);
  const totalOrders    = filteredOrders.length;

  // ── Excel export ─────────────────────────────────────────────────
  const handleExport = () => {
    let rows: any[] = [];
    let sheetName = "Report";

    if (activeTab === "daily_revenue") {
      sheetName = "Daily Revenue";
      rows = dailyData.map((d) => ({
        "Date": d.label,
        "Orders": d.orders,
        "Revenue (₹)": d.revenue.toFixed(2),
        "Collected (₹)": d.collected.toFixed(2),
      }));
      rows.push({ "Date": "TOTAL", "Orders": totalOrders, "Revenue (₹)": totalRevenue.toFixed(2), "Collected (₹)": totalCollected.toFixed(2) });
    } else if (activeTab === "trend") {
      sheetName = "Revenue Trend";
      rows = trendData.map((d) => ({ "Period": d.label, "Orders": d.orders, "Revenue (₹)": d.revenue.toFixed(2) }));
    } else if (activeTab === "by_region") {
      sheetName = "By Region";
      rows = regionData.map((d) => ({ "Region": d.region, "Orders": d.orders, "Revenue (₹)": d.revenue.toFixed(2) }));
      rows.push({ "Region": "TOTAL", "Orders": totalOrders, "Revenue (₹)": totalRevenue.toFixed(2) });
    } else if (activeTab === "by_agent") {
      sheetName = "By Field Agent";
      rows = agentData.map((d) => ({ "Agent": d.agent, "Orders": d.orders, "Revenue (₹)": d.revenue.toFixed(2), "Collected (₹)": d.collected.toFixed(2) }));
      rows.push({ "Agent": "TOTAL", "Orders": totalOrders, "Revenue (₹)": totalRevenue.toFixed(2), "Collected (₹)": totalCollected.toFixed(2) });
    } else if (activeTab === "top_products") {
      sheetName = "Top Products";
      rows = productData.map((d, i) => ({ "Rank": i+1, "Product": d.name, "Qty Sold": d.qty, "Orders": d.orders, "Revenue (₹)": d.revenue.toFixed(2) }));
    } else if (activeTab === "by_category") {
      sheetName = "By Category";
      rows = categoryData.map((d) => ({ "Category": d.category, "Qty Sold": d.qty, "Revenue (₹)": d.revenue.toFixed(2) }));
    }

    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0] || {}).map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const range = dateRange === "custom" ? `${customFrom}_${customTo}` : dateRange;
    XLSX.writeFile(wb, `${sheetName.toLowerCase().replace(/ /g,"-")}-${range}.xlsx`);
  };

  const TABS: { key: ReportTab; label: string; icon: string }[] = [
    { key: "daily_revenue", label: "Daily Revenue",      icon: "📅" },
    { key: "trend",         label: "Trend",              icon: "📈" },
    { key: "by_region",     label: "By Region",          icon: "🗺️" },
    { key: "by_agent",      label: "By Agent",           icon: "👤" },
    { key: "top_products",  label: "Top Products",       icon: "🏆" },
    { key: "by_category",   label: "By Category",        icon: "🏷️" },
  ];

  const rangeLabel = dateRange === "7d" ? "Last 7 days" : dateRange === "30d" ? "Last 30 days" : dateRange === "90d" ? "Last 90 days" : `${customFrom} to ${customTo}`;

  if (loading) return (
    <div className="p-8 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading Sales & Revenue data...
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Sales & Revenue Reports</h2>
          <p className="text-sm text-gray-400 mt-0.5">{rangeLabel} · {totalOrders} orders · {formatCurrency(totalRevenue)} revenue</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExport}
            className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            ⬇️ Export Excel
          </button>
          <button onClick={() => printDiv("report-print-area", TABS.find(t=>t.key===activeTab)?.label || "Report")}
            className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            🖨️ Print
          </button>
        </div>
      </div>

      {/* Date range picker */}
      <div className="flex gap-2 mb-5 flex-wrap items-center">
        {(["7d","30d","90d","custom"] as DateRange[]).map((r) => (
          <button key={r} onClick={() => setDateRange(r)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${dateRange === r ? "bg-orange-500 text-white" : "bg-white text-gray-500 border border-gray-200 hover:border-gray-300"}`}>
            {r === "7d" ? "Last 7 Days" : r === "30d" ? "Last 30 Days" : r === "90d" ? "Last 90 Days" : "Custom Range"}
          </button>
        ))}
        {dateRange === "custom" && (
          <>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            <span className="text-gray-400 text-sm">to</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
          </>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        {[
          { label: "Total Orders",     value: totalOrders,              icon: "📦", bg: "bg-orange-100" },
          { label: "Total Revenue",    value: formatCurrency(totalRevenue),   icon: "💰", bg: "bg-green-100" },
          { label: "Collected",        value: formatCurrency(totalCollected), icon: "✅", bg: "bg-blue-100" },
          { label: "Pending Collection", value: formatCurrency(totalRevenue - totalCollected), icon: "⏳", bg: "bg-red-100" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-2xl shadow-sm p-4 flex items-start gap-3">
            <div className={`${s.bg} rounded-xl w-10 h-10 flex items-center justify-center text-lg flex-shrink-0`}>{s.icon}</div>
            <div>
              <p className="text-xs text-gray-400">{s.label}</p>
              <p className="text-lg font-bold text-gray-800 leading-tight">{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-5 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${activeTab === t.key ? "bg-gray-800 text-white" : "bg-white text-gray-500 border border-gray-200 hover:bg-gray-50"}`}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* Print area */}
      <div id="report-print-area" ref={printRef}>

        {/* Print header (hidden on screen) */}
        <div style={{ display: "none" }} className="print-header">
          <h1>{TABS.find(t=>t.key===activeTab)?.label}</h1>
          <p className="sub">{rangeLabel} · {totalOrders} orders · {formatCurrency(totalRevenue)}</p>
        </div>

        {/* ── 1. Daily Revenue ─────────────────────────────────── */}
        {activeTab === "daily_revenue" && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue per Day</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={dailyData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} interval={Math.ceil(dailyData.length/15)} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v>=1000?(v/1000).toFixed(0)+"k":v}`} />
                  <Tooltip formatter={(v: any, name: string) => [formatCurrency(Number(v)), name === "revenue" ? "Revenue" : "Collected"]} labelStyle={{ fontSize: 11 }} contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid #e5e7eb" }} />
                  <Legend formatter={(v) => v === "revenue" ? "Revenue" : "Collected"} />
                  <Bar dataKey="revenue" fill="#f97316" radius={[4,4,0,0]} name="revenue" />
                  <Bar dataKey="collected" fill="#10b981" radius={[4,4,0,0]} name="collected" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ReportTable
              title="Daily Revenue Breakdown"
              headers={["Date", "Orders", "Revenue", "Collected", "Pending"]}
              rows={dailyData.map((d) => [
                d.label, d.orders,
                formatCurrency(d.revenue),
                formatCurrency(d.collected),
                formatCurrency(d.revenue - d.collected),
              ])}
              totals={["Total", totalOrders, formatCurrency(totalRevenue), formatCurrency(totalCollected), formatCurrency(totalRevenue - totalCollected)]}
            />
          </div>
        )}

        {/* ── 2. Trend ─────────────────────────────────────────── */}
        {activeTab === "trend" && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue Trend</h3>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v>=1000?(v/1000).toFixed(0)+"k":v}`} />
                  <Tooltip formatter={(v: any) => [formatCurrency(Number(v)), "Revenue"]} contentStyle={{ borderRadius: 8, fontSize: 12, border: "1px solid #e5e7eb" }} />
                  <Line type="monotone" dataKey="revenue" stroke="#f97316" strokeWidth={2.5} dot={{ r: 4, fill: "#f97316" }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <ReportTable
              title="Period Breakdown"
              headers={["Period", "Orders", "Revenue"]}
              rows={trendData.map((d) => [d.label, d.orders, formatCurrency(d.revenue)])}
              totals={["Total", totalOrders, formatCurrency(totalRevenue)]}
            />
          </div>
        )}

        {/* ── 3. By Region ─────────────────────────────────────── */}
        {activeTab === "by_region" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue by Region</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={regionData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v>=1000?(v/1000).toFixed(0)+"k":v}`} />
                    <YAxis type="category" dataKey="region" tick={{ fontSize: 11, fill: "#374151" }} tickLine={false} axisLine={false} width={80} />
                    <Tooltip formatter={(v: any) => [formatCurrency(Number(v)), "Revenue"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="revenue" radius={[0,4,4,0]}>
                      {regionData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Share by Region</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={regionData} dataKey="revenue" nameKey="region" cx="50%" cy="50%" outerRadius={90} label={({ region, percent }) => `${region} ${(percent*100).toFixed(0)}%`} labelLine={false} fontSize={11}>
                      {regionData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => formatCurrency(Number(v))} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
            <ReportTable
              title="Region-wise Revenue"
              headers={["Region", "Orders", "Revenue", "% Share"]}
              rows={regionData.map((d) => [
                d.region, d.orders,
                formatCurrency(d.revenue),
                totalRevenue > 0 ? `${((d.revenue/totalRevenue)*100).toFixed(1)}%` : "—",
              ])}
              totals={["Total", totalOrders, formatCurrency(totalRevenue), "100%"]}
            />
          </div>
        )}

        {/* ── 4. By Agent ──────────────────────────────────────── */}
        {activeTab === "by_agent" && (
          <div className="space-y-5">
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue by Field Agent</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={agentData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="agent" tick={{ fontSize: 11, fill: "#374151" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v>=1000?(v/1000).toFixed(0)+"k":v}`} />
                  <Tooltip formatter={(v: any, name: string) => [formatCurrency(Number(v)), name === "revenue" ? "Revenue" : "Collected"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  <Legend formatter={(v) => v === "revenue" ? "Revenue" : "Collected"} />
                  <Bar dataKey="revenue" fill="#f97316" radius={[4,4,0,0]} name="revenue" />
                  <Bar dataKey="collected" fill="#10b981" radius={[4,4,0,0]} name="collected" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ReportTable
              title="Agent-wise Revenue"
              headers={["Agent", "Orders", "Revenue", "Collected", "Pending"]}
              rows={agentData.map((d) => [
                d.agent, d.orders,
                formatCurrency(d.revenue),
                formatCurrency(d.collected),
                formatCurrency(d.revenue - d.collected),
              ])}
              totals={["Total", totalOrders, formatCurrency(totalRevenue), formatCurrency(totalCollected), formatCurrency(totalRevenue - totalCollected)]}
            />
          </div>
        )}

        {/* ── 5. Top Products ───────────────────────────────────── */}
        {activeTab === "top_products" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Top 10 by Revenue</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={productData.slice(0,10)} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v>=1000?(v/1000).toFixed(0)+"k":v}`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#374151" }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={(v: any) => [formatCurrency(Number(v)), "Revenue"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="revenue" radius={[0,4,4,0]}>
                      {productData.slice(0,10).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Top 10 by Qty Sold</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={[...productData].sort((a,b)=>b.qty-a.qty).slice(0,10)} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#374151" }} tickLine={false} axisLine={false} width={110} />
                    <Tooltip formatter={(v: any) => [v, "Units Sold"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="qty" fill="#8b5cf6" radius={[0,4,4,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <ReportTable
              title="All Products — Revenue Ranking"
              headers={["Rank", "Product", "Qty Sold", "Orders", "Revenue", "% Share"]}
              rows={productData.map((d, i) => [
                i+1, d.name, d.qty, d.orders,
                formatCurrency(d.revenue),
                totalRevenue > 0 ? `${((d.revenue/totalRevenue)*100).toFixed(1)}%` : "—",
              ])}
              totals={["", "Total", productData.reduce((s,p)=>s+p.qty,0), filteredOrders.length, formatCurrency(totalRevenue), "100%"]}
            />
          </div>
        )}

        {/* ── 6. By Category ───────────────────────────────────── */}
        {activeTab === "by_category" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue by Category</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={categoryData} dataKey="revenue" nameKey="category" cx="50%" cy="50%" outerRadius={100}
                      label={({ category, percent }) => percent > 0.04 ? `${category} ${(percent*100).toFixed(0)}%` : ""}
                      labelLine={false} fontSize={11}>
                      {categoryData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => formatCurrency(Number(v))} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Category Bars</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={categoryData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${v>=1000?(v/1000).toFixed(0)+"k":v}`} />
                    <YAxis type="category" dataKey="category" tick={{ fontSize: 11, fill: "#374151" }} tickLine={false} axisLine={false} width={90} />
                    <Tooltip formatter={(v: any) => [formatCurrency(Number(v)), "Revenue"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="revenue" radius={[0,4,4,0]}>
                      {categoryData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <ReportTable
              title="Category-wise Revenue"
              headers={["Category", "Qty Sold", "Revenue", "% Share"]}
              rows={categoryData.map((d) => [
                d.category, d.qty,
                formatCurrency(d.revenue),
                totalRevenue > 0 ? `${((d.revenue/totalRevenue)*100).toFixed(1)}%` : "—",
              ])}
              totals={["Total", categoryData.reduce((s,c)=>s+c.qty,0), formatCurrency(totalRevenue), "100%"]}
            />
          </div>
        )}

      </div>
    </div>
  );
}

// ── Reusable report table with print-friendly markup ─────────────
function ReportTable({ title, headers, rows, totals }: {
  title: string;
  headers: string[];
  rows: (string | number)[][];
  totals?: (string | number)[];
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>{headers.map((h) => <th key={h} className="px-5 py-3 text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                {row.map((cell, j) => <td key={j} className="px-5 py-3 text-gray-700">{cell}</td>)}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="bg-orange-50 border-t-2 border-orange-200">
                {totals.map((cell, j) => <td key={j} className="px-5 py-3 font-bold text-gray-800">{cell}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
        {rows.length === 0 && <div className="text-center py-10 text-gray-400">No data for selected period.</div>}
      </div>
    </div>
  );
}