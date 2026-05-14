import { useEffect, useState, useMemo, useRef } from "react";
import {
  collection, onSnapshot, query, orderBy,
  getDocs
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, Customer } from "../types";
import { LedgerEntry } from "../types/ledger";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  Legend
} from "recharts";

type CustReportTab =
  | "outstanding_dues"
  | "top_customers"
  | "order_frequency"
  | "by_region"
  | "ledger_statement";

type DateRange = "7d" | "30d" | "90d" | "all" | "custom";

const COLORS = ["#f97316","#3b82f6","#10b981","#8b5cf6","#ec4899","#f59e0b","#06b6d4","#84cc16"];

function formatCurrency(v: number) {
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function getDateRange(range: DateRange, customFrom: string, customTo: string): [Date | null, Date] {
  const to   = new Date(); to.setHours(23, 59, 59, 999);
  const from = new Date();
  if (range === "all") return [null, to];
  if (range === "7d")    { from.setDate(from.getDate() - 6); }
  else if (range === "30d") { from.setDate(from.getDate() - 29); }
  else if (range === "90d") { from.setDate(from.getDate() - 89); }
  else {
    return [
      customFrom ? new Date(customFrom) : new Date(new Date().setDate(new Date().getDate() - 29)),
      customTo ? new Date(customTo + "T23:59:59") : to,
    ];
  }
  from.setHours(0, 0, 0, 0);
  return [from, to];
}

function printTable(id: string, title: string, subtitle: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`
    <html><head><title>${title}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:20px;color:#222}
      h1{font-size:18px;margin-bottom:4px}
      p.sub{font-size:12px;color:#666;margin-bottom:16px}
      table{border-collapse:collapse;width:100%;font-size:13px}
      th{background:#f97316;color:white;padding:8px 12px;text-align:left}
      td{padding:7px 12px;border-bottom:1px solid #f0f0f0}
      tr:nth-child(even) td{background:#fafafa}
      .total-row td{font-weight:bold;background:#fff3e0!important}
      @media print{body{padding:0}}
    </style></head><body>
    <h1>${title}</h1><p class="sub">${subtitle}</p>
    ${el.innerHTML}
    </body></html>
  `);
  w.document.close(); w.focus();
  setTimeout(() => { w.print(); }, 400);
}

// ── Main ──────────────────────────────────────────────────────────
export default function CustomerReports() {
  const [customers, setCustomers]         = useState<Customer[]>([]);
  const [orders, setOrders]               = useState<Order[]>([]);
  const [loading, setLoading]             = useState(true);
  const [activeTab, setActiveTab]         = useState<CustReportTab>("outstanding_dues");
  const [dateRange, setDateRange]         = useState<DateRange>("30d");
  const [customFrom, setCustomFrom]       = useState("");
  const [customTo, setCustomTo]           = useState("");
  const [ledgerCustomerId, setLedgerCustomerId] = useState("");
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [topN, setTopN]                   = useState(10);

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, "customers"), orderBy("shopName")),
      (snap) => { setCustomers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer))); setLoading(false); }
    );
    const u2 = onSnapshot(
      query(collection(db, "orders"), orderBy("createdAt", "desc")),
      (snap) => setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)))
    );
    return () => { u1(); u2(); };
  }, []);

  const [fromDate, toDate] = getDateRange(dateRange, customFrom, customTo);

  const filteredOrders = useMemo(() =>
    orders.filter((o) => {
      const d = new Date(o.createdAt);
      const afterFrom = fromDate ? d >= fromDate : true;
      return afterFrom && d <= toDate && o.status !== "cancelled";
    }), [orders, fromDate, toDate]
  );

  // ── 1. Outstanding dues ──────────────────────────────────────────
  const dueData = useMemo(() =>
    customers
      .filter((c) => (c.outstandingDue || 0) > 0)
      .map((c) => ({
        id: c.id, shopName: c.shopName, ownerName: c.ownerName,
        phone: c.phone, region: c.regionName, area: c.area,
        due: c.outstandingDue || 0,
        creditLimit: c.creditLimit || 0,
        overLimit: c.creditLimit ? (c.outstandingDue || 0) > c.creditLimit : false,
      }))
      .sort((a, b) => b.due - a.due),
    [customers]
  );
  const totalDue = dueData.reduce((s, c) => s + c.due, 0);

  // ── 2. Top customers by order value ─────────────────────────────
  const topCustomerData = useMemo(() => {
    const map: Record<string, { id: string; name: string; region: string; orders: number; revenue: number; lastOrder?: string }> = {};
    filteredOrders.forEach((o) => {
      if (!map[o.customerId]) {
        map[o.customerId] = { id: o.customerId, name: o.customerName, region: (o as any).regionName || "", orders: 0, revenue: 0 };
      }
      map[o.customerId].orders  += 1;
      map[o.customerId].revenue += o.totalAmount;
      if (!map[o.customerId].lastOrder || o.createdAt > map[o.customerId].lastOrder!) {
        map[o.customerId].lastOrder = o.createdAt;
      }
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, topN);
  }, [filteredOrders, topN]);

  // ── 3. Order frequency ───────────────────────────────────────────
  const frequencyData = useMemo(() => {
    const map: Record<string, { name: string; region: string; orders: number; revenue: number; avgOrderValue: number; lastOrder?: string }> = {};
    filteredOrders.forEach((o) => {
      if (!map[o.customerId]) {
        map[o.customerId] = { name: o.customerName, region: (o as any).regionName || "", orders: 0, revenue: 0, avgOrderValue: 0 };
      }
      map[o.customerId].orders  += 1;
      map[o.customerId].revenue += o.totalAmount;
      if (!map[o.customerId].lastOrder || o.createdAt > map[o.customerId].lastOrder!) {
        map[o.customerId].lastOrder = o.createdAt;
      }
    });
    return Object.values(map)
      .map((c) => ({ ...c, avgOrderValue: c.revenue / c.orders }))
      .sort((a, b) => b.orders - a.orders);
  }, [filteredOrders]);

  // Bucket into frequency bands
  const frequencyBuckets = useMemo(() => {
    const bands = [
      { label: "1 order",   min: 1, max: 1,   count: 0 },
      { label: "2–5 orders", min: 2, max: 5,   count: 0 },
      { label: "6–10",       min: 6, max: 10,  count: 0 },
      { label: "11–20",      min: 11, max: 20, count: 0 },
      { label: "20+",        min: 21, max: Infinity, count: 0 },
    ];
    frequencyData.forEach((c) => {
      const b = bands.find((b) => c.orders >= b.min && c.orders <= b.max);
      if (b) b.count += 1;
    });
    return bands;
  }, [frequencyData]);

  // Inactive customers — no orders in selected range
  const inactiveCustomers = useMemo(() => {
    const activeIds = new Set(filteredOrders.map((o) => o.customerId));
    return customers.filter((c) => !activeIds.has(c.id!));
  }, [customers, filteredOrders]);

  // ── 4. By region ────────────────────────────────────────────────
  const regionData = useMemo(() => {
    const map: Record<string, { region: string; customers: number; orders: number; revenue: number }> = {};
    customers.forEach((c) => {
      const r = c.regionName || "Unknown";
      if (!map[r]) map[r] = { region: r, customers: 0, orders: 0, revenue: 0 };
      map[r].customers += 1;
    });
    filteredOrders.forEach((o) => {
      const r = (o as any).regionName || "Unknown";
      if (!map[r]) map[r] = { region: r, customers: 0, orders: 0, revenue: 0 };
      map[r].orders  += 1;
      map[r].revenue += o.totalAmount;
    });
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [customers, filteredOrders]);

  // ── 5. Ledger statement ──────────────────────────────────────────
  const fetchLedger = async (customerId: string) => {
    if (!customerId) return;
    setLedgerLoading(true);
    try {
      const snap = await getDocs(
        query(collection(db, "customers", customerId, "payments"), orderBy("createdAt", "asc"))
      );
      setLedgerEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() } as LedgerEntry)));
    } catch { setLedgerEntries([]); }
    finally { setLedgerLoading(false); }
  };

  useEffect(() => { if (ledgerCustomerId) fetchLedger(ledgerCustomerId); }, [ledgerCustomerId]);

  const selectedCustomer = customers.find((c) => c.id === ledgerCustomerId);
  const ledgerBalance = ledgerEntries.reduce((bal, e) =>
    e.direction === "debit" ? bal + e.amount : bal - e.amount, 0
  );
  const ledgerRunning = ledgerEntries.map((e, i) => ({
    ...e,
    running: ledgerEntries.slice(0, i + 1).reduce(
      (bal, en) => en.direction === "debit" ? bal + en.amount : bal - en.amount, 0
    ),
  }));

  // ── Export ───────────────────────────────────────────────────────
  const handleExport = () => {
    let rows: any[] = [];
    let sheetName   = "Customer Report";

    if (activeTab === "outstanding_dues") {
      sheetName = "Outstanding Dues";
      rows = dueData.map((c) => ({
        "Shop Name": c.shopName, "Owner": c.ownerName, "Phone": c.phone,
        "Region": c.region, "Area": c.area,
        "Outstanding Due (₹)": c.due.toFixed(2),
        "Credit Limit (₹)": c.creditLimit || "—",
        "Over Limit?": c.overLimit ? "Yes" : "No",
      }));
      rows.push({ "Shop Name": "TOTAL", "Outstanding Due (₹)": totalDue.toFixed(2) });
    } else if (activeTab === "top_customers") {
      sheetName = "Top Customers";
      rows = topCustomerData.map((c, i) => ({
        "Rank": i + 1, "Customer": c.name, "Region": c.region,
        "Orders": c.orders, "Revenue (₹)": c.revenue.toFixed(2),
        "Last Order": formatDate(c.lastOrder),
      }));
    } else if (activeTab === "order_frequency") {
      sheetName = "Order Frequency";
      rows = frequencyData.map((c) => ({
        "Customer": c.name, "Region": c.region,
        "Orders": c.orders, "Total Revenue (₹)": c.revenue.toFixed(2),
        "Avg Order Value (₹)": c.avgOrderValue.toFixed(2),
        "Last Order": formatDate(c.lastOrder),
      }));
    } else if (activeTab === "by_region") {
      sheetName = "Customers by Region";
      rows = regionData.map((r) => ({
        "Region": r.region, "Customers": r.customers,
        "Orders": r.orders, "Revenue (₹)": r.revenue.toFixed(2),
      }));
    } else if (activeTab === "ledger_statement" && selectedCustomer) {
      sheetName = `Ledger - ${selectedCustomer.shopName}`;
      rows = ledgerRunning.map((e) => ({
        "Date": formatDate(e.createdAt),
        "Type": e.type.replace(/_/g, " "),
        "Note": e.note || "",
        "By": e.createdByName,
        "Debit (₹)": e.direction === "debit" ? e.amount.toFixed(2) : "",
        "Credit (₹)": e.direction === "credit" ? e.amount.toFixed(2) : "",
        "Balance (₹)": e.running.toFixed(2),
      }));
      rows.push({ "Date": "", "Type": "CURRENT BALANCE", "Balance (₹)": ledgerBalance.toFixed(2) });
    }

    if (rows.length === 0) { alert("No data to export."); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0] || {}).map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, `${sheetName.toLowerCase().replace(/ /g, "-")}.xlsx`);
  };

  // ── PDF for ledger statement ─────────────────────────────────────
  const handleLedgerPDF = () => {
    if (!selectedCustomer) return;
    const pdf = new jsPDF();
    pdf.setFontSize(16); pdf.setFont("helvetica", "bold");
    pdf.text("Customer Ledger Statement", 14, 18);
    pdf.setFontSize(11); pdf.setFont("helvetica", "normal");
    pdf.text(`Customer: ${selectedCustomer.shopName}`, 14, 26);
    pdf.text(`Owner: ${selectedCustomer.ownerName} | Phone: ${selectedCustomer.phone}`, 14, 32);
    pdf.text(`Region: ${selectedCustomer.regionName} | As of: ${formatDate(new Date().toISOString())}`, 14, 38);
    pdf.setDrawColor(200); pdf.line(14, 42, 196, 42);

    (autoTable as any)(pdf, {
      startY: 46,
      head: [["Date", "Type", "Note", "By", "Debit", "Credit", "Balance"]],
      body: ledgerRunning.map((e) => [
        formatDate(e.createdAt),
        e.type.replace(/_/g, " "),
        e.note || "—",
        e.createdByName,
        e.direction === "debit"   ? `₹${e.amount.toFixed(2)}` : "",
        e.direction === "credit"  ? `₹${e.amount.toFixed(2)}` : "",
        `₹${e.running.toFixed(2)}`,
      ]),
      foot: [["", "", "", "Current Balance", "", "", `₹${ledgerBalance.toFixed(2)}`]],
      headStyles: { fillColor: [249, 115, 22], fontSize: 9 },
      footStyles: { fillColor: [255, 243, 224], fontStyle: "bold", fontSize: 10 },
      styles: { fontSize: 9 },
      columnStyles: { 4: { halign: "right" }, 5: { halign: "right" }, 6: { halign: "right", fontStyle: "bold" } },
    });

    pdf.save(`ledger-${selectedCustomer.shopName.replace(/ /g, "-")}.pdf`);
  };

  const rangeLabel = dateRange === "all" ? "All time" : dateRange === "7d" ? "Last 7 days" : dateRange === "30d" ? "Last 30 days" : dateRange === "90d" ? "Last 90 days" : `${customFrom} to ${customTo}`;

  const TABS: { key: CustReportTab; label: string; icon: string }[] = [
    { key: "outstanding_dues",  label: "Outstanding Dues",   icon: "⚠️" },
    { key: "top_customers",     label: "Top Customers",      icon: "🏆" },
    { key: "order_frequency",   label: "Order Frequency",    icon: "🔄" },
    { key: "by_region",         label: "By Region",          icon: "🗺️" },
    { key: "ledger_statement",  label: "Ledger Statement",   icon: "📋" },
  ];

  if (loading) return (
    <div className="p-8 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading customer reports...
    </div>
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Customer Reports</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            {customers.length} customers · {dueData.length} with outstanding dues · {rangeLabel}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExport}
            className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            ⬇️ Export Excel
          </button>
          {activeTab === "ledger_statement" && selectedCustomer ? (
            <button onClick={handleLedgerPDF}
              className="flex items-center gap-1.5 bg-orange-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-600">
              📄 Download PDF
            </button>
          ) : (
            <button onClick={() => printTable("cr-print-area", TABS.find(t=>t.key===activeTab)?.label || "", rangeLabel)}
              className="flex items-center gap-1.5 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
              🖨️ Print
            </button>
          )}
        </div>
      </div>

      {/* Date range — not needed for dues or ledger */}
      {activeTab !== "outstanding_dues" && activeTab !== "ledger_statement" && (
        <div className="flex gap-2 mb-5 flex-wrap items-center">
          {(["7d","30d","90d","all","custom"] as DateRange[]).map((r) => (
            <button key={r} onClick={() => setDateRange(r)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${dateRange === r ? "bg-orange-500 text-white" : "bg-white text-gray-500 border border-gray-200 hover:border-gray-300"}`}>
              {r === "7d" ? "Last 7 Days" : r === "30d" ? "Last 30 Days" : r === "90d" ? "Last 90 Days" : r === "all" ? "All Time" : "Custom"}
            </button>
          ))}
          {dateRange === "custom" && (
            <>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              <span className="text-gray-400 text-sm">to</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </>
          )}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        {[
          { label: "Total Customers",  value: customers.length,              icon: "🏪", bg: "bg-orange-100" },
          { label: "With Due Balance", value: dueData.length,                icon: "⚠️", bg: "bg-red-100" },
          { label: "Total Outstanding", value: formatCurrency(totalDue),     icon: "💰", bg: "bg-yellow-100" },
          { label: "Active (in range)", value: new Set(filteredOrders.map(o=>o.customerId)).size, icon: "✅", bg: "bg-green-100" },
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
      <div id="cr-print-area">

        {/* ── 1. Outstanding Dues ─────────────────────────────── */}
        {activeTab === "outstanding_dues" && (
          <div className="space-y-5">
            {/* Dues bar chart */}
            {dueData.length > 0 && (
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Top 15 Outstanding Dues</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={dueData.slice(0, 15)} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
                      tickFormatter={(v) => `₹${v >= 1000 ? (v/1000).toFixed(0)+"k" : v}`} />
                    <YAxis type="category" dataKey="shopName" tick={{ fontSize: 10, fill: "#374151" }} tickLine={false} axisLine={false} width={100} />
                    <Tooltip formatter={(v: any) => [formatCurrency(Number(v)), "Outstanding Due"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="due" radius={[0, 4, 4, 0]}>
                      {dueData.slice(0, 15).map((_, i) => (
                        <Cell key={i} fill={_.overLimit ? "#ef4444" : "#f97316"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <p className="text-xs text-gray-400 mt-2">🔴 Red = over credit limit</p>
              </div>
            )}

            <CRTable
              title={`All Customers with Outstanding Dues (${dueData.length})`}
              headers={["Shop Name", "Owner", "Phone", "Region", "Outstanding Due", "Credit Limit", "Status"]}
              rows={dueData.map((c) => [
                c.shopName, c.ownerName, c.phone, c.region,
                <span className="font-bold text-red-600">{formatCurrency(c.due)}</span>,
                c.creditLimit ? formatCurrency(c.creditLimit) : "—",
                c.overLimit
                  ? <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">Over Limit</span>
                  : <span className="text-xs bg-green-100 text-green-600 px-2 py-0.5 rounded-full font-medium">Within Limit</span>,
              ])}
              totals={["Total", "", "", "", <span className="font-bold text-red-600">{formatCurrency(totalDue)}</span>, "", `${dueData.filter(c=>c.overLimit).length} over limit`]}
              emptyText="No customers with outstanding dues 🎉"
            />
          </div>
        )}

        {/* ── 2. Top Customers ────────────────────────────────── */}
        {activeTab === "top_customers" && (
          <div className="space-y-5">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm text-gray-500">Show top</span>
              {[10, 20, 50].map((n) => (
                <button key={n} onClick={() => setTopN(n)}
                  className={`px-3 py-1 rounded-lg text-sm border transition-all ${topN === n ? "bg-orange-500 text-white border-orange-500" : "text-gray-500 border-gray-200 hover:border-gray-300"}`}>
                  {n}
                </button>
              ))}
            </div>
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">Top {topN} Customers by Revenue</h3>
              <ResponsiveContainer width="100%" height={Math.min(topN * 28, 400)}>
                <BarChart data={topCustomerData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
                    tickFormatter={(v) => `₹${v >= 1000 ? (v/1000).toFixed(0)+"k" : v}`} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: "#374151" }} tickLine={false} axisLine={false} width={110} />
                  <Tooltip formatter={(v: any) => [formatCurrency(Number(v)), "Revenue"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                    {topCustomerData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <CRTable
              title={`Top ${topN} Customers — ${rangeLabel}`}
              headers={["Rank", "Customer", "Region", "Orders", "Revenue", "Last Order"]}
              rows={topCustomerData.map((c, i) => [
                <span className={`font-bold ${i === 0 ? "text-yellow-500" : i === 1 ? "text-gray-400" : i === 2 ? "text-orange-400" : "text-gray-400"}`}>#{i+1}</span>,
                c.name, c.region, c.orders, formatCurrency(c.revenue), formatDate(c.lastOrder),
              ])}
              totals={["", "Total", "", topCustomerData.reduce((s,c)=>s+c.orders,0), formatCurrency(topCustomerData.reduce((s,c)=>s+c.revenue,0)), ""]}
            />
          </div>
        )}

        {/* ── 3. Order Frequency ──────────────────────────────── */}
        {activeTab === "order_frequency" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Order Frequency Distribution</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={frequencyBuckets} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#374151" }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                    <Tooltip formatter={(v: any) => [v, "Customers"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="count" fill="#f97316" radius={[4, 4, 0, 0]} name="Customers" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">
                  Inactive Customers — No orders in {rangeLabel}
                </h3>
                {inactiveCustomers.length === 0 ? (
                  <div className="text-center py-8 text-green-600 font-medium">All customers ordered! 🎉</div>
                ) : (
                  <div className="overflow-y-auto max-h-48 space-y-2">
                    {inactiveCustomers.slice(0, 20).map((c) => (
                      <div key={c.id} className="flex items-center justify-between py-1.5 border-b border-gray-100">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{c.shopName}</p>
                          <p className="text-xs text-gray-400">{c.regionName} · {c.phone}</p>
                        </div>
                        <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Inactive</span>
                      </div>
                    ))}
                    {inactiveCustomers.length > 20 && <p className="text-xs text-gray-400 text-center">+{inactiveCustomers.length - 20} more</p>}
                  </div>
                )}
              </div>
            </div>
            <CRTable
              title={`All Customer Order Frequency — ${rangeLabel}`}
              headers={["Customer", "Region", "Orders", "Total Revenue", "Avg Order Value", "Last Order"]}
              rows={frequencyData.map((c) => [
                c.name, c.region, c.orders,
                formatCurrency(c.revenue),
                formatCurrency(c.avgOrderValue),
                formatDate(c.lastOrder),
              ])}
            />
          </div>
        )}

        {/* ── 4. By Region ────────────────────────────────────── */}
        {activeTab === "by_region" && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Revenue by Region</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={regionData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
                      tickFormatter={(v) => `₹${v >= 1000 ? (v/1000).toFixed(0)+"k" : v}`} />
                    <YAxis type="category" dataKey="region" tick={{ fontSize: 11, fill: "#374151" }} tickLine={false} axisLine={false} width={80} />
                    <Tooltip formatter={(v: any, name: string) => [name === "revenue" ? formatCurrency(Number(v)) : v, name === "revenue" ? "Revenue" : "Orders"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                    <Legend formatter={(v) => v === "revenue" ? "Revenue" : "Customers"} />
                    <Bar dataKey="revenue" fill="#f97316" radius={[0, 4, 4, 0]} name="revenue" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-2xl shadow-sm p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-4">Customer Share by Region</h3>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={regionData} dataKey="customers" nameKey="region" cx="50%" cy="50%" outerRadius={95}
                      label={({ region, percent }) => percent > 0.05 ? `${region} ${(percent*100).toFixed(0)}%` : ""}
                      labelLine={false} fontSize={11}>
                      {regionData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => [v, "Customers"]} contentStyle={{ borderRadius: 8, fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
            <CRTable
              title={`Region Summary — ${rangeLabel}`}
              headers={["Region", "Customers", "Orders", "Revenue", "% Revenue"]}
              rows={regionData.map((r) => {
                const totalRev = regionData.reduce((s,d)=>s+d.revenue,0);
                return [
                  r.region, r.customers, r.orders,
                  formatCurrency(r.revenue),
                  totalRev > 0 ? `${((r.revenue/totalRev)*100).toFixed(1)}%` : "—",
                ];
              })}
              totals={[
                "Total",
                customers.length,
                regionData.reduce((s,r)=>s+r.orders,0),
                formatCurrency(regionData.reduce((s,r)=>s+r.revenue,0)),
                "100%",
              ]}
            />
          </div>
        )}

        {/* ── 5. Ledger Statement ──────────────────────────────── */}
        {activeTab === "ledger_statement" && (
          <div className="space-y-5">
            {/* Customer selector */}
            <div className="bg-white rounded-2xl shadow-sm p-5">
              <label className="block text-sm font-medium text-gray-700 mb-2">Select Customer</label>
              <select
                value={ledgerCustomerId}
                onChange={(e) => setLedgerCustomerId(e.target.value)}
                className="w-full max-w-sm border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
              >
                <option value="">— Choose a customer —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.shopName} — {c.regionName}
                    {(c.outstandingDue || 0) > 0 ? ` (Due: ₹${c.outstandingDue?.toFixed(0)})` : ""}
                  </option>
                ))}
              </select>
            </div>

            {ledgerCustomerId && selectedCustomer && (
              <>
                {/* Customer info card */}
                <div className="bg-white rounded-2xl shadow-sm p-5 flex items-start justify-between flex-wrap gap-4">
                  <div>
                    <h3 className="text-lg font-bold text-gray-800">{selectedCustomer.shopName}</h3>
                    <p className="text-sm text-gray-500">{selectedCustomer.ownerName} · {selectedCustomer.phone}</p>
                    <p className="text-sm text-gray-500">{selectedCustomer.regionName} · {selectedCustomer.area}</p>
                    {selectedCustomer.gstin && <p className="text-sm text-gray-500">GSTIN: {selectedCustomer.gstin}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-gray-400">Current Balance</p>
                    <p className={`text-2xl font-bold ${ledgerBalance > 0 ? "text-red-600" : "text-green-600"}`}>
                      {ledgerBalance > 0 ? formatCurrency(ledgerBalance) + " due" : "✓ Clear"}
                    </p>
                  </div>
                </div>

                {/* Ledger table */}
                {ledgerLoading ? (
                  <div className="text-center py-10 text-gray-400">Loading ledger...</div>
                ) : (
                  <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-100">
                      <h3 className="text-sm font-semibold text-gray-700">Full Transaction History</h3>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                          <tr>
                            <th className="px-5 py-3 text-left">Date</th>
                            <th className="px-5 py-3 text-left">Type</th>
                            <th className="px-5 py-3 text-left">Note</th>
                            <th className="px-5 py-3 text-left">By</th>
                            <th className="px-5 py-3 text-right">Debit</th>
                            <th className="px-5 py-3 text-right">Credit</th>
                            <th className="px-5 py-3 text-right">Balance</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {ledgerRunning.map((e) => (
                            <tr key={e.id} className="hover:bg-gray-50">
                              <td className="px-5 py-3 text-gray-500 whitespace-nowrap text-xs">{formatDate(e.createdAt)}</td>
                              <td className="px-5 py-3">
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${e.direction === "debit" ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                                  {e.type.replace(/_/g, " ")}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-gray-500 text-xs max-w-[160px] truncate">{e.note || "—"}</td>
                              <td className="px-5 py-3 text-gray-400 text-xs">{e.createdByName}</td>
                              <td className="px-5 py-3 text-right text-red-600 font-medium">
                                {e.direction === "debit" ? formatCurrency(e.amount) : "—"}
                              </td>
                              <td className="px-5 py-3 text-right text-green-600 font-medium">
                                {e.direction === "credit" ? formatCurrency(e.amount) : "—"}
                              </td>
                              <td className={`px-5 py-3 text-right font-bold ${e.running > 0 ? "text-red-600" : "text-green-600"}`}>
                                {formatCurrency(e.running)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-orange-50 border-t-2 border-orange-200">
                          <tr>
                            <td colSpan={6} className="px-5 py-3 font-bold text-gray-800">Current Balance</td>
                            <td className={`px-5 py-3 text-right font-bold text-lg ${ledgerBalance > 0 ? "text-red-600" : "text-green-600"}`}>
                              {formatCurrency(ledgerBalance)}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                      {ledgerEntries.length === 0 && (
                        <div className="text-center py-10 text-gray-400">No transactions found.</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {!ledgerCustomerId && (
              <div className="text-center py-16 text-gray-400">
                <p className="text-4xl mb-3">📋</p>
                <p className="font-medium">Select a customer to view their ledger statement</p>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// ── Reusable table ────────────────────────────────────────────────
function CRTable({ title, headers, rows, totals, emptyText }: {
  title: string;
  headers: string[];
  rows: (string | number | React.ReactNode)[][];
  totals?: (string | number | React.ReactNode)[];
  emptyText?: string;
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
        {rows.length === 0 && (
          <div className="text-center py-10 text-gray-400">{emptyText || "No data for selected period."}</div>
        )}
      </div>
    </div>
  );
}