import { useEffect, useState, useMemo } from "react";
import Pagination from "../components/Pagination";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order } from "../types";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, Legend,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────
type FinanceTab = "gst" | "collections" | "pending" | "profit" | "paymentmode";

interface GSTLine {
  orderId: string;
  invoiceNumber: string;
  date: string;
  customerName: string;
  gstin: string;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  grandTotal: number;
  gstRate: string;
  hsn: string;
  paymentMode: string;
}

// ── Shared Helpers ─────────────────────────────────────────────────
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
  const tableRows = rows.map(r =>
    `<tr>${r.map(c => `<td>${c ?? "—"}</td>`).join("")}</tr>`
  ).join("");
  const html = `
    <html><head><title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 11px; color: #111; margin: 20px; }
      h2 { font-size: 16px; margin-bottom: 4px; color: #1f2937; }
      p.sub { font-size: 10px; color: #6b7280; margin-bottom: 14px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f3f4f6; text-align: left; padding: 7px 8px; font-size: 9px;
           text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #e5e7eb; }
      td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; }
      tr:last-child td { border-bottom: none; }
      tfoot td { font-weight: bold; background: #fef3c7; border-top: 2px solid #f59e0b; }
      @media print { @page { margin: 12mm; size: A4 landscape; } }
    </style></head>
    <body>
      <h2>${title}</h2>
      <p class="sub">${subtitle ?? ""} &nbsp;·&nbsp; Printed ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" } as any)}</p>
      <table>
        <thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 400);
}

// GST rate from string "5"|"12"|"18"|"28"|"none"
function parseGstRate(g: string | undefined): number {
  if (!g || g === "none") return 0;
  return parseFloat(g) || 0;
}

// Compute taxable + tax breakdown for an order item
// taxInclusive: price already includes GST
function itemTaxBreakdown(price: number, qty: number, gstRate: number, taxInclusive: boolean) {
  const gross = price * qty;
  if (gstRate === 0) return { taxable: gross, tax: 0, cgst: 0, sgst: 0, igst: 0 };
  const r = gstRate / 100;
  const taxable = taxInclusive ? gross / (1 + r) : gross;
  const tax     = taxable * r;
  // Intra-state: split equally as CGST + SGST (standard for B2C in same state)
  return { taxable, tax, cgst: tax / 2, sgst: tax / 2, igst: 0 };
}

// ── Period Helpers ─────────────────────────────────────────────────
function thisMonthRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const to   = now.toISOString().slice(0, 10);
  return { from, to };
}

// ── Action Bar ─────────────────────────────────────────────────────
function ActionBar({ onPrint, onExport }: { onPrint: () => void; onExport: () => void }) {
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

// ── Summary Card ───────────────────────────────────────────────────
function SCard({ label, value, sub, color = "blue" }: { label: string; value: string; sub?: string; color?: string }) {
  const border: Record<string, string> = {
    blue: "border-blue-400", green: "border-green-400",
    orange: "border-orange-400", red: "border-red-400",
    purple: "border-purple-400", yellow: "border-yellow-400",
  };
  return (
    <div className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${border[color] ?? border.blue}`}>
      <p className="text-xs text-gray-400 font-medium mb-1 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Date Range Bar ─────────────────────────────────────────────────
function DateRange({ from, to, setFrom, setTo }: {
  from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void;
}) {
  const presets = [
    { label: "This Month",  fn: () => { const r = thisMonthRange(); setFrom(r.from); setTo(r.to); } },
    { label: "Last Month",  fn: () => {
      const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
      const f = new Date(y, m - 1, 1); const t = new Date(y, m, 0);
      setFrom(f.toISOString().slice(0, 10)); setTo(t.toISOString().slice(0, 10));
    }},
    { label: "This Quarter", fn: () => {
      const now = new Date(); const q = Math.floor(now.getMonth() / 3);
      const f = new Date(now.getFullYear(), q * 3, 1);
      setFrom(f.toISOString().slice(0, 10)); setTo(now.toISOString().slice(0, 10));
    }},
    { label: "This Year", fn: () => {
      const y = new Date().getFullYear();
      setFrom(`${y}-01-01`); setTo(new Date().toISOString().slice(0, 10));
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

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
export default function FinanceReports() {
  const [activeTab, setActiveTab] = useState<FinanceTab>("gst");
  const [orders, setOrders]       = useState<Order[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc")))
      .then(snap => {
        setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() } as Order)));
        setLoading(false);
      });
  }, []);

  const tabs: { key: FinanceTab; label: string; icon: string }[] = [
    { key: "gst",         label: "GST Summary",          icon: "🧾" },
    { key: "collections", label: "Collections",          icon: "💵" },
    { key: "pending",     label: "Pending Collections",  icon: "⏳" },
    { key: "profit",      label: "Profit Estimate",      icon: "📈" },
    { key: "paymentmode", label: "Payment Mode",         icon: "💳" },
  ];

  if (loading) return (
    <div className="p-4 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading financial data...
    </div>
  );

  const deliveredOrders = orders.filter(o => o.status === "delivered");
  const totalRevenue    = deliveredOrders.reduce((s, o) => s + o.totalAmount, 0);
  const totalCollected  = deliveredOrders.reduce((s, o) => s + (o.amountCollected ?? 0), 0);
  const totalPending    = orders
    .filter(o => !["cancelled"].includes(o.status))
    .reduce((s, o) => s + Math.max(0, o.totalAmount - (o.amountCollected ?? 0)), 0);

  return (
    <div className="p-3 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">💰 Finance Reports</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          {deliveredOrders.length} delivered orders · Revenue {fmtINR0(totalRevenue)} ·
          Collected {fmtINR0(totalCollected)} · Pending {fmtINR0(totalPending)}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-6 bg-gray-100 rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              activeTab === t.key
                ? "bg-white text-orange-600 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}>
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {activeTab === "gst"         && <GSTReport orders={orders} />}
      {activeTab === "collections" && <CollectionsReport orders={orders} />}
      {activeTab === "pending"     && <PendingReport orders={orders} />}
      {activeTab === "profit"      && <ProfitReport orders={orders} />}
      {activeTab === "paymentmode" && <PaymentModeReport orders={orders} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 1. GST Summary — GSTR-1 style (B2C, HSN-wise, rate-wise)
// ══════════════════════════════════════════════════════════════════
function GSTReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);
  const [view, setView] = useState<"b2c" | "rate" | "hsn" | "tax_invoice" | "estimate">("b2c");
  const [b2cPage, setB2cPage] = useState(1);
  const B2C_PER_PAGE = 25;

  const { filteredGST, filteredEstimate } = useMemo(() => {
    const f = new Date(from); f.setHours(0,0,0,0);
    const t = new Date(to);   t.setHours(23,59,59,999);

    const inRange = (o: Order) =>
      o.status !== "cancelled" &&
      !!o.invoiceNumber &&
      new Date(o.createdAt) >= f &&
      new Date(o.createdAt) <= t;

    // Split purely on the invoiceType the user chose at generation time.
    // Tax Invoice (gst)     → used for IT/GST filing, shows CGST+SGST breakdown.
    // Estimate (estimate) → not submitted for IT filing, no tax breakdown shown.
    const gst = orders.filter(o => inRange(o) && o.invoiceType === "gst");
    const est = orders.filter(o => inRange(o) && o.invoiceType === "estimate");

    return { filteredGST: gst, filteredEstimate: est };
  }, [orders, from, to]);

  // "filtered" used by gstLines / rateWise / hsnWise — always GST orders only
  const filtered = filteredGST;

  // Build per-order GST lines
  const gstLines: GSTLine[] = useMemo(() => filtered.map(o => {
    let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
    const ratesSet = new Set<string>();
    const hsnSet   = new Set<string>();

    o.items.forEach(item => {
      const rate = parseGstRate(item.gst);
      if (rate > 0) ratesSet.add(`${rate}%`);
      if (item.hsn) hsnSet.add(item.hsn);
      const { taxable, cgst, sgst, igst } = itemTaxBreakdown(
        item.price, item.quantity, rate, item.taxInclusive ?? false
      );
      taxableTotal += taxable;
      cgstTotal    += cgst;
      sgstTotal    += sgst;
      igstTotal    += igst;
    });

    return {
      orderId:      o.id!,
      invoiceNumber: o.invoiceNumber || o.id!,
      date:         o.createdAt,
      customerName: o.customerName,
      gstin:        "—", // stored on customer, orders don't carry it directly
      taxableAmount: taxableTotal,
      cgst:         cgstTotal,
      sgst:         sgstTotal,
      igst:         igstTotal,
      totalTax:     cgstTotal + sgstTotal + igstTotal,
      grandTotal:   o.totalAmount,
      gstRate:      Array.from(ratesSet).join(", ") || "0%",
      hsn:          Array.from(hsnSet).join(", ") || "—",
      paymentMode:  o.paymentMode || "—",
    };
  }), [filtered]);

  // Totals
  const totals = useMemo(() => gstLines.reduce((acc, l) => ({
    taxable: acc.taxable + l.taxableAmount,
    cgst:    acc.cgst    + l.cgst,
    sgst:    acc.sgst    + l.sgst,
    igst:    acc.igst    + l.igst,
    tax:     acc.tax     + l.totalTax,
    grand:   acc.grand   + l.grandTotal,
  }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, grand: 0 }), [gstLines]);

  // Rate-wise summary
  const rateWise = useMemo(() => {
    const map: Record<string, { taxable: number; cgst: number; sgst: number; igst: number; tax: number }> = {};
    filtered.forEach(o => {
      o.items.forEach(item => {
        const rate  = parseGstRate(item.gst);
        const key   = rate === 0 ? "Exempt" : `${rate}%`;
        const { taxable, cgst, sgst, igst, tax } = itemTaxBreakdown(
          item.price, item.quantity, rate, item.taxInclusive ?? false
        );
        if (!map[key]) map[key] = { taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0 };
        map[key].taxable += taxable;
        map[key].cgst    += cgst;
        map[key].sgst    += sgst;
        map[key].igst    += igst;
        map[key].tax     += tax;
      });
    });
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  // HSN-wise summary
  const hsnWise = useMemo(() => {
    const map: Record<string, { desc: string; qty: number; taxable: number; cgst: number; sgst: number; igst: number }> = {};
    filtered.forEach(o => {
      o.items.forEach(item => {
        const hsn  = item.hsn || "—";
        const rate = parseGstRate(item.gst);
        const { taxable, cgst, sgst, igst } = itemTaxBreakdown(
          item.price, item.quantity, rate, item.taxInclusive ?? false
        );
        if (!map[hsn]) map[hsn] = { desc: item.productName, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        map[hsn].qty     += item.quantity;
        map[hsn].taxable += taxable;
        map[hsn].cgst    += cgst;
        map[hsn].sgst    += sgst;
        map[hsn].igst    += igst;
      });
    });
    return Object.entries(map).sort((a, b) => b[1].taxable - a[1].taxable);
  }, [filtered]);

  // Export / Print helpers
  const B2C_HEADERS = ["Invoice No.", "Date", "Customer", "Taxable Amt", "CGST", "SGST", "IGST", "Total Tax", "Grand Total", "GST Rate", "Payment Mode"];
  const getB2cRows = () => gstLines.map(l => [
    l.invoiceNumber, fmtDate(l.date), l.customerName,
    l.taxableAmount.toFixed(2), l.cgst.toFixed(2), l.sgst.toFixed(2),
    l.igst.toFixed(2), l.totalTax.toFixed(2), l.grandTotal.toFixed(2),
    l.gstRate, l.paymentMode,
  ]);
  const RATE_HEADERS = ["GST Rate", "Taxable Amount", "CGST", "SGST", "IGST", "Total Tax"];
  const getRateRows = () => rateWise.map(([rate, v]) => [
    rate, v.taxable.toFixed(2), v.cgst.toFixed(2), v.sgst.toFixed(2), v.igst.toFixed(2), v.tax.toFixed(2),
  ]);
  const HSN_HEADERS = ["HSN", "Description", "Qty", "Taxable Amt", "CGST", "SGST", "IGST"];
  const getHsnRows = () => hsnWise.map(([hsn, v]) => [
    hsn, v.desc, v.qty, v.taxable.toFixed(2), v.cgst.toFixed(2), v.sgst.toFixed(2), v.igst.toFixed(2),
  ]);

  const handleExport = () => {
    if (view === "b2c")  exportXlsx(getB2cRows(),  "gst_b2c_invoices",   B2C_HEADERS);
    if (view === "rate") exportXlsx(getRateRows(), "gst_rate_wise",      RATE_HEADERS);
    if (view === "hsn")  exportXlsx(getHsnRows(),  "gst_hsn_wise",       HSN_HEADERS);
  };
  const handlePrint = () => {
    const subtitle = `Period: ${from} to ${to} · Total Tax ₹${totals.tax.toFixed(2)} · Grand Total ₹${totals.grand.toFixed(2)}`;
    if (view === "b2c")  printReport("GST Summary — B2C Invoices",   B2C_HEADERS,  getB2cRows(),  subtitle);
    if (view === "rate") printReport("GST Summary — Rate-wise",      RATE_HEADERS, getRateRows(), subtitle);
    if (view === "hsn")  printReport("GST Summary — HSN-wise",       HSN_HEADERS,  getHsnRows(),  subtitle);
  };

  return (
    <div className="space-y-4">
      {/* GST Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="Taxable Amount"  value={fmtINR(totals.taxable)} color="blue"   />
        <SCard label="CGST Collected"  value={fmtINR(totals.cgst)}    color="orange" sub="9% / 6% / 2.5% share" />
        <SCard label="SGST Collected"  value={fmtINR(totals.sgst)}    color="orange" sub="9% / 6% / 2.5% share" />
        <SCard label="Total Tax"       value={fmtINR(totals.tax)}      color="purple" sub={`On ${gstLines.length} GST invoices`} />
      </div>

      {/* Filing Note */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
        <p className="font-semibold mb-1">📋 GSTR-1 Filing Note</p>
        <p className="text-xs text-blue-600 leading-relaxed">
          This report covers only invoices with <strong>Invoice Type = GST</strong>.
          Use <strong>B2C view</strong> for individual invoice details (GSTR-1 Table 7/10),
          <strong> Rate-wise</strong> for rate-wise summary (Table 7), and
          <strong> HSN-wise</strong> for HSN summary (Table 12).
          IGST is ₹0 assuming all sales are intra-state (CGST + SGST split).
          Verify GSTIN on customers for B2B supplies.
        </p>
      </div>

      {/* View Switcher + Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
      </div>
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex gap-1 flex-wrap">
          {([
            ["b2c",           "📄 Invoice-wise"],
            ["rate",          "📊 Rate-wise"],
            ["hsn",           "🔢 HSN-wise"],
            ["tax_invoice",   "🧾 Tax Invoice"],
            ["estimate","📋 Estimate"],
          ] as const).map(([v, label]) => (
            <button key={v} onClick={() => { setView(v as any); setB2cPage(1); }}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                view === v ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-500 border-gray-200"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <ActionBar onPrint={handlePrint} onExport={handleExport} />
      </div>

      {/* B2C / Invoice-wise View */}
      {view === "b2c" && (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-3 text-left">Invoice No.</th>
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-right">Taxable</th>
                <th className="px-4 py-3 text-right">CGST</th>
                <th className="px-4 py-3 text-right">SGST</th>
                <th className="px-4 py-3 text-right">Total Tax</th>
                <th className="px-4 py-3 text-right">Grand Total</th>
                <th className="px-4 py-3 text-center">Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {gstLines.slice((b2cPage - 1) * B2C_PER_PAGE, b2cPage * B2C_PER_PAGE).map(l => (
                <tr key={l.orderId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-blue-700">{l.invoiceNumber}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(l.date)}</td>
                  <td className="px-4 py-3 text-gray-800">{l.customerName}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtINR(l.taxableAmount)}</td>
                  <td className="px-4 py-3 text-right text-orange-600">{fmtINR(l.cgst)}</td>
                  <td className="px-4 py-3 text-right text-orange-600">{fmtINR(l.sgst)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmtINR(l.totalTax)}</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900">{fmtINR(l.grandTotal)}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{l.gstRate}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
              <tr>
                <td colSpan={3} className="px-4 py-3 text-gray-700">Total ({gstLines.length} invoices)</td>
                <td className="px-4 py-3 text-right">{fmtINR(totals.taxable)}</td>
                <td className="px-4 py-3 text-right text-orange-600">{fmtINR(totals.cgst)}</td>
                <td className="px-4 py-3 text-right text-orange-600">{fmtINR(totals.sgst)}</td>
                <td className="px-4 py-3 text-right">{fmtINR(totals.tax)}</td>
                <td className="px-4 py-3 text-right text-orange-700">{fmtINR(totals.grand)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {gstLines.length === 0 && <div className="text-center py-12 text-gray-400">No GST invoices in this period.</div>}
          {gstLines.length > B2C_PER_PAGE && (
            <div className="px-4 py-3 border-t border-gray-100">
              <Pagination total={gstLines.length} page={b2cPage} perPage={B2C_PER_PAGE} onPage={setB2cPage} />
            </div>
          )}
        </div>
      )}

      {/* Tax Invoice View — GST registered customers only */}
      {view === "tax_invoice" && (() => {
        const lines = filteredGST.map(o => {
          let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
          const ratesSet = new Set<string>();
          const hsnSet   = new Set<string>();
          o.items.forEach(item => {
            const rate = parseGstRate(item.gst);
            if (rate > 0) ratesSet.add(`${rate}%`);
            if (item.hsn) hsnSet.add(item.hsn);
            const { taxable, cgst, sgst, igst } = itemTaxBreakdown(item.price, item.quantity, rate, item.taxInclusive ?? false);
            taxableTotal += taxable; cgstTotal += cgst; sgstTotal += sgst; igstTotal += igst;
          });
          return { o, taxableTotal, cgstTotal, sgstTotal, igstTotal, ratesSet, hsnSet };
        });
        const totTax  = lines.reduce((s, l) => s + l.cgstTotal + l.sgstTotal + l.igstTotal, 0);
        const totGrand = lines.reduce((s, l) => s + l.o.totalAmount, 0);
        const totTaxable = lines.reduce((s, l) => s + l.taxableTotal, 0);
        return (
          <div className="space-y-3">
            <div className="flex gap-4 text-sm">
              <div className="bg-blue-50 border border-blue-100 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">Tax Invoices</p>
                <p className="text-xl font-bold text-blue-700">{lines.length}</p>
              </div>
              <div className="bg-orange-50 border border-orange-100 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">Total Taxable</p>
                <p className="text-xl font-bold text-orange-700">{fmtINR(totTaxable)}</p>
              </div>
              <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">Total GST</p>
                <p className="text-xl font-bold text-green-700">{fmtINR(totTax)}</p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">Grand Total</p>
                <p className="text-xl font-bold text-gray-800">{fmtINR(totGrand)}</p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="bg-blue-50 text-blue-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left">Invoice No.</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-left">HSN</th>
                    <th className="px-4 py-3 text-center">Rate</th>
                    <th className="px-4 py-3 text-right">Taxable</th>
                    <th className="px-4 py-3 text-right">CGST</th>
                    <th className="px-4 py-3 text-right">SGST</th>
                    <th className="px-4 py-3 text-right">Grand Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map(({ o, taxableTotal, cgstTotal, sgstTotal, ratesSet, hsnSet }) => (
                    <tr key={o.id} className="hover:bg-blue-50/30">
                      <td className="px-4 py-3 font-mono text-xs text-blue-700 font-semibold">{o.invoiceNumber}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                      <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs">{Array.from(hsnSet).join(", ") || "—"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">
                          {Array.from(ratesSet).join(", ") || "0%"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-gray-700">{fmtINR(taxableTotal)}</td>
                      <td className="px-4 py-3 text-right text-orange-600">{fmtINR(cgstTotal)}</td>
                      <td className="px-4 py-3 text-right text-orange-600">{fmtINR(sgstTotal)}</td>
                      <td className="px-4 py-3 text-right font-bold text-gray-900">{fmtINR(o.totalAmount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-blue-50 border-t-2 border-blue-200 font-semibold">
                  <tr>
                    <td colSpan={5} className="px-4 py-3 text-gray-700">Total ({lines.length})</td>
                    <td className="px-4 py-3 text-right">{fmtINR(totTaxable)}</td>
                    <td className="px-4 py-3 text-right text-orange-600">{fmtINR(lines.reduce((s,l) => s+l.cgstTotal, 0))}</td>
                    <td className="px-4 py-3 text-right text-orange-600">{fmtINR(lines.reduce((s,l) => s+l.sgstTotal, 0))}</td>
                    <td className="px-4 py-3 text-right text-blue-700">{fmtINR(totGrand)}</td>
                  </tr>
                </tfoot>
              </table>
              {lines.length === 0 && <div className="text-center py-12 text-gray-400">No Tax Invoices in this period.</div>}
            </div>
          </div>
        );
      })()}

      {/* Estimate View — unregistered / exempt customers */}
      {view === "estimate" && (() => {
        const lines = filteredEstimate;
        const totGrand = lines.reduce((s, o) => s + o.totalAmount, 0);
        return (
          <div className="space-y-3">
            <div className="flex gap-4 text-sm">
              <div className="bg-green-50 border border-green-100 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">Estimate Count</p>
                <p className="text-xl font-bold text-green-700">{lines.length}</p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                <p className="text-xs text-gray-400">Total Value</p>
                <p className="text-xl font-bold text-gray-800">{fmtINR(totGrand)}</p>
              </div>
            </div>
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="bg-green-50 text-green-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left">Bill No.</th>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-left">Items</th>
                    <th className="px-4 py-3 text-right">Total Amount</th>
                    <th className="px-4 py-3 text-center">Payment</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {lines.map(o => (
                    <tr key={o.id} className="hover:bg-green-50/20">
                      <td className="px-4 py-3 font-mono text-xs text-green-700 font-semibold">{o.invoiceNumber}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                      <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{o.items.length} item{o.items.length !== 1 ? "s" : ""}</td>
                      <td className="px-4 py-3 text-right font-bold text-gray-900">{fmtINR(o.totalAmount)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full capitalize">
                          {o.paymentMode || "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-green-50 border-t-2 border-green-200 font-semibold">
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-gray-700">Total ({lines.length})</td>
                    <td className="px-4 py-3 text-right text-green-700">{fmtINR(totGrand)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              {lines.length === 0 && <div className="text-center py-12 text-gray-400">No Bills of Supply in this period.</div>}
            </div>
          </div>
        );
      })()}

      {/* Rate-wise View */}
      {view === "rate" && (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">GST Rate</th>
                <th className="px-5 py-3 text-right">Taxable Amount</th>
                <th className="px-5 py-3 text-right">CGST</th>
                <th className="px-5 py-3 text-right">SGST</th>
                <th className="px-5 py-3 text-right">IGST</th>
                <th className="px-5 py-3 text-right">Total Tax</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rateWise.map(([rate, v]) => (
                <tr key={rate} className="hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <span className="bg-purple-100 text-purple-700 text-xs font-semibold px-3 py-1 rounded-full">{rate}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700">{fmtINR(v.taxable)}</td>
                  <td className="px-5 py-3 text-right text-orange-600">{fmtINR(v.cgst)}</td>
                  <td className="px-5 py-3 text-right text-orange-600">{fmtINR(v.sgst)}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{fmtINR(v.igst)}</td>
                  <td className="px-5 py-3 text-right font-bold text-gray-900">{fmtINR(v.tax)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
              <tr>
                <td className="px-5 py-3 text-gray-700">Total</td>
                <td className="px-5 py-3 text-right">{fmtINR(totals.taxable)}</td>
                <td className="px-5 py-3 text-right text-orange-600">{fmtINR(totals.cgst)}</td>
                <td className="px-5 py-3 text-right text-orange-600">{fmtINR(totals.sgst)}</td>
                <td className="px-5 py-3 text-right text-gray-400">₹0.00</td>
                <td className="px-5 py-3 text-right text-orange-700">{fmtINR(totals.tax)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* HSN-wise View */}
      {view === "hsn" && (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">HSN Code</th>
                <th className="px-5 py-3 text-left">Description</th>
                <th className="px-5 py-3 text-right">Total Qty</th>
                <th className="px-5 py-3 text-right">Taxable Amt</th>
                <th className="px-5 py-3 text-right">CGST</th>
                <th className="px-5 py-3 text-right">SGST</th>
                <th className="px-5 py-3 text-right">IGST</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {hsnWise.map(([hsn, v]) => (
                <tr key={hsn} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-mono text-blue-700 font-semibold">{hsn}</td>
                  <td className="px-5 py-3 text-gray-600 text-xs">{v.desc}</td>
                  <td className="px-5 py-3 text-right text-gray-700">{v.qty}</td>
                  <td className="px-5 py-3 text-right text-gray-700">{fmtINR(v.taxable)}</td>
                  <td className="px-5 py-3 text-right text-orange-600">{fmtINR(v.cgst)}</td>
                  <td className="px-5 py-3 text-right text-orange-600">{fmtINR(v.sgst)}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{fmtINR(v.igst)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hsnWise.length === 0 && <div className="text-center py-12 text-gray-400">No HSN data found.</div>}
        </div>
      )}

      {/* Voided / Cancelled Invoices — always shown in B2C view for GST compliance */}
      {view === "b2c" && (() => {
        // Collect all voided invoice entries from orders in the period
        const f = new Date(from); f.setHours(0,0,0,0);
        const t = new Date(to);   t.setHours(23,59,59,999);
        const voidedRows: Array<{
          invoiceNumber: string; voidedAt: string; orderId: string;
          customerName: string; grandTotal: number; reason?: string;
        }> = [];
        orders
          .filter(o => new Date(o.createdAt) >= f && new Date(o.createdAt) <= t)
          .forEach(o => {
            ((o as any).voidedInvoices ?? []).forEach((v: any) => {
              voidedRows.push({
                invoiceNumber: v.invoiceNumber,
                voidedAt:      v.voidedAt,
                orderId:       o.id!,
                customerName:  o.customerName,
                grandTotal:    o.totalAmount,
                reason:        v.reason,
              });
            });
          });

        if (voidedRows.length === 0) return null;

        return (
          <div>
            <h4 className="text-sm font-semibold text-red-600 mb-2 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
              Cancelled / Voided Invoices — must be reported in GSTR-1
            </h4>
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto border border-red-100">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="bg-red-50 text-red-400 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left">Voided Invoice No.</th>
                    <th className="px-4 py-3 text-left">Voided On</th>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-right">Original Amount</th>
                    <th className="px-4 py-3 text-left">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-50">
                  {voidedRows.map((v, i) => (
                    <tr key={i} className="bg-red-50/30">
                      <td className="px-4 py-3 font-mono text-xs text-red-700 line-through">{v.invoiceNumber}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{fmtDate(v.voidedAt)}</td>
                      <td className="px-4 py-3 text-gray-700">{v.customerName}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{fmtINR(v.grandTotal)}</td>
                      <td className="px-4 py-3 text-gray-400 text-xs">{v.reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 2. Collections Report
// ══════════════════════════════════════════════════════════════════
function CollectionsReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);
  const [agentFilter, setAgentFilter] = useState("All");

  const collected = useMemo(() => {
    const f = new Date(from); f.setHours(0,0,0,0);
    const t = new Date(to);   t.setHours(23,59,59,999);
    return orders.filter(o => {
      // Use the actual payment date, not order-creation date, to decide
      // which period a collection belongs to — see Order.lastPaymentAt.
      // Falls back to deliveredAt, then createdAt, for orders that predate
      // that field (best available approximation, not exact).
      const paymentDate = new Date(o.lastPaymentAt ?? o.deliveredAt ?? o.createdAt);
      return (
        o.status === "delivered" &&
        (o.amountCollected ?? 0) > 0 &&
        paymentDate >= f &&
        paymentDate <= t &&
        (agentFilter === "All" || o.agentName === agentFilter)
      );
    });
  }, [orders, from, to, agentFilter]);

  const agents = ["All", ...Array.from(new Set(orders.map(o => o.agentName).filter(Boolean)))];

  const totalBilled    = collected.reduce((s, o) => s + o.totalAmount, 0);
  const totalCollected = collected.reduce((s, o) => s + (o.amountCollected ?? 0), 0);
  const totalBalance   = totalBilled - totalCollected;

  // Daily trend
  const dailyMap: Record<string, number> = {};
  collected.forEach(o => {
    const d = (o.lastPaymentAt ?? o.deliveredAt ?? o.createdAt).slice(0, 10);
    dailyMap[d] = (dailyMap[d] || 0) + (o.amountCollected ?? 0);
  });
  const chartData = Object.entries(dailyMap).sort().map(([date, amt]) => ({
    date: new Date(date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
    amount: +amt.toFixed(0),
  }));

  const HEADERS = ["Collected On", "Order Date", "Invoice No.", "Customer", "Agent", "Billed", "Collected", "Balance", "Payment Mode"];
  const getRows = () => collected.map(o => [
    fmtDate(o.lastPaymentAt ?? o.deliveredAt ?? o.createdAt), fmtDate(o.createdAt),
    o.invoiceNumber || o.id!, o.customerName, o.agentName,
    o.totalAmount.toFixed(2), (o.amountCollected ?? 0).toFixed(2),
    Math.max(0, o.totalAmount - (o.amountCollected ?? 0)).toFixed(2),
    o.paymentMode || "—",
  ]);
  const subtitle = `Period: ${from} to ${to} · Collected ${fmtINR0(totalCollected)}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SCard label="Total Billed"     value={fmtINR0(totalBilled)}     color="blue" />
        <SCard label="Amount Collected" value={fmtINR0(totalCollected)}  color="green" sub={`${collected.length} orders`} />
        <SCard label="Balance Due"      value={fmtINR0(totalBalance)}    color={totalBalance > 0 ? "red" : "green"} />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {agents.map(a => <option key={a}>{a}</option>)}
        </select>
        <ActionBar onPrint={() => printReport("Collections Report", HEADERS, getRows(), subtitle)}
                   onExport={() => exportXlsx(getRows(), "collections_report", HEADERS)} />
      </div>

      {chartData.length > 1 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Daily Collections</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
                tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: any) => [fmtINR0(v), "Collected"]}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Bar dataKey="amount" fill="#f97316" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Collected On</th>
              <th className="px-4 py-3 text-left">Order Date</th>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-right">Billed</th>
              <th className="px-4 py-3 text-right">Collected</th>
              <th className="px-4 py-3 text-right">Balance</th>
              <th className="px-4 py-3 text-center">Mode</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {collected.map(o => {
              const balance = Math.max(0, o.totalAmount - (o.amountCollected ?? 0));
              return (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700 text-xs whitespace-nowrap font-medium">{fmtDate(o.lastPaymentAt ?? o.deliveredAt ?? o.createdAt)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                  <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{o.agentName}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtINR(o.totalAmount)}</td>
                  <td className="px-4 py-3 text-right font-semibold text-green-600">{fmtINR(o.amountCollected ?? 0)}</td>
                  <td className="px-4 py-3 text-right">
                    {balance > 0
                      ? <span className="text-red-600 font-medium">{fmtINR(balance)}</span>
                      : <span className="text-green-600 text-xs">Paid</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full capitalize">
                      {o.paymentMode || "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td colSpan={5} className="px-4 py-3 text-gray-700">Total ({collected.length} orders)</td>
              <td className="px-4 py-3 text-right">{fmtINR(totalBilled)}</td>
              <td className="px-4 py-3 text-right text-green-700">{fmtINR(totalCollected)}</td>
              <td className="px-4 py-3 text-right text-red-600">{fmtINR(totalBalance)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        {collected.length === 0 && <div className="text-center py-12 text-gray-400">No collections in this period.</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 3. Pending Collections
// ══════════════════════════════════════════════════════════════════
function PendingReport({ orders }: { orders: Order[] }) {
  const [agentFilter, setAgentFilter] = useState("All");
  const [sortBy, setSortBy] = useState<"due" | "date" | "customer">("due");

  const pending = useMemo(() => {
    return orders
      .filter(o => {
        if (o.status === "cancelled") return false;
        const due = o.totalAmount - (o.amountCollected ?? 0);
        return due > 0;
      })
      .filter(o => agentFilter === "All" || o.agentName === agentFilter);
  }, [orders, agentFilter]);

  const sorted = useMemo(() => {
    const list = [...pending];
    if (sortBy === "due")      list.sort((a, b) => (b.totalAmount - (b.amountCollected ?? 0)) - (a.totalAmount - (a.amountCollected ?? 0)));
    if (sortBy === "date")     list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (sortBy === "customer") list.sort((a, b) => a.customerName.localeCompare(b.customerName));
    return list;
  }, [pending, sortBy]);

  const agents = ["All", ...Array.from(new Set(orders.map(o => o.agentName).filter(Boolean)))];
  const totalPending = sorted.reduce((s, o) => s + (o.totalAmount - (o.amountCollected ?? 0)), 0);
  const totalBilled  = sorted.reduce((s, o) => s + o.totalAmount, 0);

  // Ageing buckets
  const now = Date.now();
  const ageing = { current: 0, days30: 0, days60: 0, over60: 0 };
  sorted.forEach(o => {
    const days = Math.floor((now - new Date(o.createdAt).getTime()) / 864e5);
    const due  = o.totalAmount - (o.amountCollected ?? 0);
    if (days <= 7)       ageing.current += due;
    else if (days <= 30) ageing.days30  += due;
    else if (days <= 60) ageing.days60  += due;
    else                 ageing.over60  += due;
  });

  const HEADERS = ["Date", "Invoice", "Customer", "Agent", "Status", "Billed", "Collected", "Due", "Age (days)"];
  const getRows = () => sorted.map(o => {
    const due  = o.totalAmount - (o.amountCollected ?? 0);
    const days = Math.floor((now - new Date(o.createdAt).getTime()) / 864e5);
    return [
      fmtDate(o.createdAt), o.invoiceNumber || o.id!, o.customerName, o.agentName,
      o.status, o.totalAmount.toFixed(2), (o.amountCollected ?? 0).toFixed(2), due.toFixed(2), days,
    ];
  });

  return (
    <div className="space-y-4">
      {/* Ageing Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="0–7 Days"   value={fmtINR0(ageing.current)} color="green"  sub="Current" />
        <SCard label="8–30 Days"  value={fmtINR0(ageing.days30)}  color="yellow" sub="Moderate" />
        <SCard label="31–60 Days" value={fmtINR0(ageing.days60)}  color="orange" sub="Follow up" />
        <SCard label="Over 60 Days" value={fmtINR0(ageing.over60)} color="red"  sub="Overdue" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <select value={agentFilter} onChange={e => setAgentFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {agents.map(a => <option key={a}>{a}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="due">Sort: Highest Due</option>
          <option value="date">Sort: Oldest First</option>
          <option value="customer">Sort: Customer A–Z</option>
        </select>
        <ActionBar
          onPrint={() => printReport("Pending Collections", HEADERS, getRows(), `Total Pending: ${fmtINR(totalPending)} · ${sorted.length} orders`)}
          onExport={() => exportXlsx(getRows(), "pending_collections", HEADERS)} />
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <p className="font-semibold text-gray-800">
            Pending Collection <span className="text-gray-400 font-normal text-sm">({sorted.length} orders)</span>
          </p>
          <p className="text-orange-600 font-bold text-lg">{fmtINR(totalPending)}</p>
        </div>
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Date</th>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-right">Billed</th>
              <th className="px-4 py-3 text-right">Collected</th>
              <th className="px-4 py-3 text-right">Due</th>
              <th className="px-4 py-3 text-center">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map(o => {
              const due  = o.totalAmount - (o.amountCollected ?? 0);
              const days = Math.floor((now - new Date(o.createdAt).getTime()) / 864e5);
              const ageColor = days > 60 ? "text-red-600 font-bold" : days > 30 ? "text-orange-500" : "text-gray-500";
              return (
                <tr key={o.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{o.customerName}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{o.agentName}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full capitalize">{o.status.replace(/_/g, " ")}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtINR(o.totalAmount)}</td>
                  <td className="px-4 py-3 text-right text-green-600">{fmtINR(o.amountCollected ?? 0)}</td>
                  <td className="px-4 py-3 text-right font-bold text-red-600">{fmtINR(due)}</td>
                  <td className={`px-4 py-3 text-center text-xs ${ageColor}`}>{days}d</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td colSpan={5} className="px-4 py-3 text-gray-700">Total</td>
              <td className="px-4 py-3 text-right">{fmtINR(totalBilled)}</td>
              <td className="px-4 py-3 text-right text-green-700">{fmtINR(totalBilled - totalPending)}</td>
              <td className="px-4 py-3 text-right text-red-600">{fmtINR(totalPending)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
        {sorted.length === 0 && <div className="text-center py-12 text-gray-400">🎉 No pending collections!</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 4. Profit Estimate
// ══════════════════════════════════════════════════════════════════
function ProfitReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom]       = useState(df);
  const [to,   setTo]         = useState(dt);


  // No product lookup needed — costPrice is snapshotted on each order item at creation time.
  // For old orders without costPrice on items, cost will show as 0 (honest, not misleading).

  // NOTE: intentionally accrual-based (bucketed by order.createdAt, i.e. when
  // the sale was booked) — this is a revenue/margin-per-sale view, not a
  // cash-in-the-door view. Unlike CollectionsReport / PaymentModeReport
  // (which now use lastPaymentAt), this one should stay on createdAt.
  const filtered = useMemo(() => {
    const f = new Date(from); f.setHours(0,0,0,0);
    const t = new Date(to);   t.setHours(23,59,59,999);
    return orders.filter(o =>
      o.status === "delivered" &&
      new Date(o.createdAt) >= f &&
      new Date(o.createdAt) <= t
    );
  }, [orders, from, to]);

  // Per-order profit calculation
  const rows = useMemo(() => filtered.map(o => {
    let costTotal = 0;
    let taxTotal  = 0;
    o.items.forEach(item => {
      const rate = parseGstRate(item.gst);
      const { tax } = itemTaxBreakdown(item.price, item.quantity, rate, item.taxInclusive ?? false);
      taxTotal  += tax;
      // Use cost price snapshotted at order creation time.
      // Old orders without costPrice on items will show 0 cost (no fallback — keeps history clean).
      const unitCost = (item as any).costPrice ?? 0;
      costTotal += unitCost * item.quantity;
    });
    const revenue      = o.totalAmount;
    const taxComponent = taxTotal;
    const netRevenue   = revenue - taxComponent;
    const grossProfit  = revenue - costTotal;  // GST is pass-through; compare full revenue vs cost
    const marginPct    = netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0;
    return { order: o, revenue, taxComponent, netRevenue, costTotal, grossProfit, marginPct };
  }), [filtered]);

  const totalRevenue    = rows.reduce((s, r) => s + r.revenue, 0);
  const totalTax        = rows.reduce((s, r) => s + r.taxComponent, 0);
  const totalNetRevenue = rows.reduce((s, r) => s + r.netRevenue, 0);
  const totalCost       = rows.reduce((s, r) => s + r.costTotal, 0);
  const totalProfit     = rows.reduce((s, r) => s + r.grossProfit, 0);
  const collected       = rows.reduce((s, r) => s + (r.order.amountCollected ?? 0), 0);
  const overallMargin   = totalNetRevenue > 0 ? (totalProfit / totalNetRevenue) * 100 : 0;

  // Monthly trend
  const trendMap: Record<string, { revenue: number; profit: number }> = {};
  rows.forEach(r => {
    const month = r.order.createdAt.slice(0, 7);
    if (!trendMap[month]) trendMap[month] = { revenue: 0, profit: 0 };
    trendMap[month].revenue += r.revenue;
    trendMap[month].profit  += r.grossProfit;
  });
  const trendData = Object.entries(trendMap).sort().map(([m, v]) => ({
    month: new Date(m + "-01").toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
    revenue: +v.revenue.toFixed(0),
    profit:  +v.profit.toFixed(0),
  }));

  const HEADERS = ["Date", "Invoice", "Customer", "Gross Revenue", "GST", "Net Revenue", "Cost of Goods", "Gross Profit", "Margin %", "Collected"];
  const getRows = () => rows.map(r => [
    fmtDate(r.order.createdAt), r.order.invoiceNumber || r.order.id!,
    r.order.customerName,
    r.revenue.toFixed(2), r.taxComponent.toFixed(2), r.netRevenue.toFixed(2),
    r.costTotal.toFixed(2), r.grossProfit.toFixed(2),
    r.marginPct.toFixed(1) + "%",
    (r.order.amountCollected ?? 0).toFixed(2),
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SCard label="Gross Revenue"    value={fmtINR0(totalRevenue)}    color="blue"   sub={`${filtered.length} orders`} />
        <SCard label="GST Component"    value={fmtINR0(totalTax)}        color="orange" sub="Collected on behalf of govt" />
        <SCard label="Net Revenue"      value={fmtINR0(totalNetRevenue)} color="green"  sub="Revenue after GST" />
        <SCard label="Cost of Goods"    value={fmtINR0(totalCost)}       color="red"    sub="Based on product cost price" />
        <SCard label="Gross Profit"     value={fmtINR0(totalProfit)}     color={totalProfit >= 0 ? "green" : "red"} sub={`${overallMargin.toFixed(1)}% margin`} />
        <SCard label="Amount Collected" value={fmtINR0(collected)}       color="purple" />
      </div>



      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Profit Estimate Report", HEADERS, getRows(), `Gross Profit: ${fmtINR(totalProfit)} | Margin: ${overallMargin.toFixed(1)}%`)}
          onExport={() => exportXlsx(getRows(), "profit_estimate", HEADERS)} />
      </div>

      {trendData.length > 1 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Monthly Revenue Trend</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={trendData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#9ca3af" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false}
                tickFormatter={v => `₹${(v/1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: any) => [fmtINR0(v), "Revenue"]}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Bar dataKey="revenue" fill="#10b981" name="Revenue" radius={[4, 4, 0, 0]} />
              <Bar dataKey="profit"  fill="#6366f1" name="Profit"  radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Date</th>
              <th className="px-4 py-3 text-left">Invoice</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-right">Gross Revenue</th>
              <th className="px-4 py-3 text-right">GST</th>
              <th className="px-4 py-3 text-right">Net Revenue</th>
              <th className="px-4 py-3 text-right">Cost of Goods</th>
              <th className="px-4 py-3 text-right">Gross Profit</th>
              <th className="px-4 py-3 text-right">Margin</th>
              <th className="px-4 py-3 text-right">Collected</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.order.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(r.order.createdAt)}</td>
                <td className="px-4 py-3 font-mono text-xs text-blue-700">{r.order.invoiceNumber || r.order.id}</td>
                <td className="px-4 py-3 text-gray-800">{r.order.customerName}</td>
                <td className="px-4 py-3 text-right text-gray-700">{fmtINR(r.revenue)}</td>
                <td className="px-4 py-3 text-right text-orange-500">{fmtINR(r.taxComponent)}</td>
                <td className="px-4 py-3 text-right text-green-700">{fmtINR(r.netRevenue)}</td>
                <td className="px-4 py-3 text-right text-gray-500">{fmtINR(r.costTotal)}</td>
                <td className={`px-4 py-3 text-right font-semibold ${r.grossProfit >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtINR(r.grossProfit)}</td>
                <td className={`px-4 py-3 text-right text-xs ${r.marginPct >= 0 ? "text-green-500" : "text-red-500"}`}>{r.marginPct.toFixed(1)}%</td>
                <td className="px-4 py-3 text-right text-gray-600">{fmtINR(r.order.amountCollected ?? 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td colSpan={3} className="px-4 py-3 text-gray-700">Total ({rows.length} orders)</td>
              <td className="px-4 py-3 text-right">{fmtINR(totalRevenue)}</td>
              <td className="px-4 py-3 text-right text-orange-600">{fmtINR(totalTax)}</td>
              <td className="px-4 py-3 text-right text-green-700">{fmtINR(totalNetRevenue)}</td>
              <td className="px-4 py-3 text-right text-gray-500">{fmtINR(totalCost)}</td>
              <td className={`px-4 py-3 text-right ${totalProfit >= 0 ? "text-green-700" : "text-red-600"}`}>{fmtINR(totalProfit)}</td>
              <td className={`px-4 py-3 text-right text-xs ${overallMargin >= 0 ? "text-green-600" : "text-red-500"}`}>{overallMargin.toFixed(1)}%</td>
              <td className="px-4 py-3 text-right">{fmtINR(collected)}</td>
            </tr>
          </tfoot>
        </table>
        {rows.length === 0 && <div className="text-center py-12 text-gray-400">No delivered orders in this period.</div>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 5. Payment Mode Breakdown
// ══════════════════════════════════════════════════════════════════
function PaymentModeReport({ orders }: { orders: Order[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to,   setTo]   = useState(dt);

  const filtered = useMemo(() => {
    const f = new Date(from); f.setHours(0,0,0,0);
    const t = new Date(to);   t.setHours(23,59,59,999);
    return orders.filter(o => {
      // Same fix as CollectionsReport: bucket by actual payment date, not
      // order-creation date — see Order.lastPaymentAt.
      const paymentDate = new Date(o.lastPaymentAt ?? o.deliveredAt ?? o.createdAt);
      return o.status === "delivered" && paymentDate >= f && paymentDate <= t;
    });
  }, [orders, from, to]);

  const modeMap: Record<string, { count: number; amount: number }> = {};
  filtered.forEach(o => {
    const mode = o.paymentMode || "unspecified";
    if (!modeMap[mode]) modeMap[mode] = { count: 0, amount: 0 };
    modeMap[mode].count  += 1;
    modeMap[mode].amount += o.amountCollected ?? 0;
  });

  const modeData = Object.entries(modeMap).sort((a, b) => b[1].amount - a[1].amount);
  const totalAmount = modeData.reduce((s, [, v]) => s + v.amount, 0);
  const totalOrders = modeData.reduce((s, [, v]) => s + v.count,  0);

  const PIE_COLORS = ["#f97316", "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#ef4444"];

  const pieData = modeData.map(([mode, v]) => ({
    name: mode.charAt(0).toUpperCase() + mode.slice(1),
    value: +v.amount.toFixed(0),
  }));

  const HEADERS = ["Payment Mode", "No. of Orders", "Amount Collected", "% of Total"];
  const getRows = () => modeData.map(([mode, v]) => [
    mode, v.count, v.amount.toFixed(2),
    `${totalAmount > 0 ? ((v.amount / totalAmount) * 100).toFixed(1) : 0}%`,
  ]);

  const MODE_ICONS: Record<string, string> = {
    cash: "💵", upi: "📱", bank: "🏦", credit: "📒", unspecified: "❓",
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SCard label="Total Collected" value={fmtINR0(totalAmount)} color="green" sub={`${totalOrders} orders`} />
        <SCard label="Payment Modes"   value={`${modeData.length}`} color="blue"  sub="Active modes" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Payment Mode Breakdown", HEADERS, getRows(), `Period: ${from} to ${to} · Total ${fmtINR(totalAmount)}`)}
          onExport={() => exportXlsx(getRows(), "payment_mode_breakdown", HEADERS)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pie Chart */}
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Collection by Payment Mode</p>
          {pieData.length === 0
            ? <div className="text-center py-12 text-gray-400">No data.</div>
            : (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%"
                    outerRadius={90} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}>
                    {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => [fmtINR0(v), "Collected"]}
                    contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )
          }
        </div>

        {/* Mode Cards */}
        <div className="space-y-3">
          {modeData.map(([mode, v], i) => {
            const pct = totalAmount > 0 ? (v.amount / totalAmount) * 100 : 0;
            return (
              <div key={mode} className="bg-white rounded-xl shadow-sm p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{MODE_ICONS[mode] || "💰"}</span>
                    <span className="font-semibold text-gray-800 capitalize">{mode}</span>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-gray-900">{fmtINR0(v.amount)}</p>
                    <p className="text-xs text-gray-400">{v.count} orders</p>
                  </div>
                </div>
                <div className="w-full bg-gray-100 rounded-full h-2">
                  <div
                    className="h-2 rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }}
                  />
                </div>
                <p className="text-xs text-gray-400 mt-1">{pct.toFixed(1)}% of total</p>
              </div>
            );
          })}
          {modeData.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm p-8 text-center text-gray-400">
              No payment data in this period.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}