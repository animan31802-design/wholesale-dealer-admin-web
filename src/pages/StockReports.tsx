import { useEffect, useState, useMemo } from "react";
import {
  collection, getDocs, orderBy, query, collectionGroup
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Product, Order } from "../types";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────
interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  type: string;
  direction: "in" | "out";
  qty: number;
  stockBefore: number;
  stockAfter: number;
  reason?: string;
  createdByName?: string;
  createdAt: string;
}

type ReportTab = "status" | "lowstock" | "movement" | "valuation" | "moving";

// ── Helpers ───────────────────────────────────────────────────────
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
      body { font-family: Arial, sans-serif; font-size: 12px; color: #111; margin: 20px; }
      h2 { font-size: 18px; margin-bottom: 4px; color: #1f2937; }
      p.sub { font-size: 11px; color: #6b7280; margin-bottom: 16px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #f3f4f6; text-align: left; padding: 8px 10px; font-size: 10px;
           text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 2px solid #e5e7eb; }
      td { padding: 7px 10px; border-bottom: 1px solid #f0f0f0; }
      tr:last-child td { border-bottom: none; }
      @media print { @page { margin: 15mm; } }
    </style></head>
    <body>
      <h2>${title}</h2>
      <p class="sub">${subtitle ?? ""} · Printed on ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</p>
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
  setTimeout(() => { w.print(); }, 400);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

const TYPE_LABEL: Record<string, string> = {
  manual_in: "Stock In",
  manual_out: "Stock Out",
  order_placed: "Order Placed",
  order_cancelled: "Order Cancelled",
};

// ── Main Component ────────────────────────────────────────────────
export default function StockReports() {
  const [activeTab, setActiveTab] = useState<ReportTab>("status");
  const [products, setProducts]   = useState<Product[]>([]);
  const [orders, setOrders]       = useState<Order[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loading, setLoading]     = useState(true);
  const [movLoading, setMovLoading] = useState(false);

  // Date range for movement history
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [fromDate, setFromDate] = useState(monthAgo);
  const [toDate, setToDate]     = useState(today);
  const [movLoaded, setMovLoaded] = useState(false);

  // Load products + orders on mount
  useEffect(() => {
    Promise.all([
      getDocs(query(collection(db, "products"), orderBy("name"))),
      getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"))),
    ]).then(([pSnap, oSnap]) => {
      setProducts(pSnap.docs.map(d => ({ id: d.id, ...d.data() } as Product)));
      setOrders(oSnap.docs.map(d => ({ id: d.id, ...d.data() } as Order)));
      setLoading(false);
    });
  }, []);

  // Load all stock movements (lazy, on demand)
  const loadMovements = async () => {
    setMovLoading(true);
    const snap = await getDocs(collectionGroup(db, "stockMovements"));
    const all: StockMovement[] = [];
    snap.forEach(d => {
      const data = d.data();
      // parent path: products/{productId}/stockMovements/{id}
      const productId = d.ref.parent.parent?.id || "";
      all.push({ id: d.id, productId, productName: "", ...data } as StockMovement);
    });
    // Map productId → name
    const prodMap: Record<string, string> = {};
    products.forEach(p => { prodMap[p.id!] = p.name; });
    all.forEach(m => { m.productName = prodMap[m.productId] || m.productId; });
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setMovements(all);
    setMovLoading(false);
    setMovLoaded(true);
  };

  const tabs: { key: ReportTab; label: string; icon: string }[] = [
    { key: "status",    label: "Current Stock",       icon: "📦" },
    { key: "lowstock",  label: "Low / Out of Stock",  icon: "⚠️" },
    { key: "movement",  label: "Movement History",    icon: "🔄" },
    { key: "valuation", label: "Stock Valuation",     icon: "💰" },
    { key: "moving",    label: "Fast / Slow Moving",  icon: "📊" },
  ];

  if (loading) return (
    <div className="p-4 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading stock data...
    </div>
  );

  return (
    <div className="p-3 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">📦 Stock Reports</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          {products.filter(p => p.trackInventory).length} tracked products ·{" "}
          {products.filter(p => p.trackInventory && p.stock <= 0).length} out of stock ·{" "}
          {products.filter(p => p.trackInventory && p.stock > 0 && p.stock <= p.minStockAlert).length} low stock
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-6 bg-gray-100 rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => {
              setActiveTab(t.key);
              if (t.key === "movement" && !movLoaded) loadMovements();
            }}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${
              activeTab === t.key
                ? "bg-white text-orange-600 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      {/* Panels */}
      {activeTab === "status"    && <CurrentStockReport products={products} />}
      {activeTab === "lowstock"  && <LowStockReport products={products} />}
      {activeTab === "movement"  && (
        <MovementReport
          movements={movements}
          loading={movLoading}
          fromDate={fromDate} toDate={toDate}
          setFromDate={setFromDate} setToDate={setToDate}
          onReload={loadMovements}
        />
      )}
      {activeTab === "valuation" && <ValuationReport products={products} />}
      {activeTab === "moving"    && <FastSlowReport products={products} orders={orders} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 1. Current Stock Status
// ═══════════════════════════════════════════════════════════════════
function CurrentStockReport({ products }: { products: Product[] }) {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "low" | "out">("all");

  const tracked = products.filter(p => p.trackInventory);
  const cats = ["All", ...Array.from(new Set(tracked.map(p => p.category).filter(Boolean)))];

  const filtered = useMemo(() => {
    let list = tracked;
    if (search) list = list.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));
    if (catFilter !== "All") list = list.filter(p => p.category === catFilter);
    if (statusFilter === "ok")  list = list.filter(p => p.stock > p.minStockAlert);
    if (statusFilter === "low") list = list.filter(p => p.stock > 0 && p.stock <= p.minStockAlert);
    if (statusFilter === "out") list = list.filter(p => p.stock <= 0);
    return list;
  }, [tracked, search, catFilter, statusFilter]);

  const HEADERS = ["Product", "Category", "Unit", "Stock", "Reserved", "Available", "Min Alert", "Status"];
  const getRows = () => filtered.map(p => [
    p.name, p.category || "—", p.unit,
    p.stock, p.reservedStock || 0,
    Math.max(0, p.stock - (p.reservedStock || 0)),
    p.minStockAlert,
    p.stock <= 0 ? "Out of Stock" : p.stock <= p.minStockAlert ? "Low Stock" : "OK",
  ]);
  const handleExport = () => exportXlsx(getRows(), "current_stock_status", HEADERS);
  const handlePrint  = () => printReport("Current Stock Status", HEADERS, getRows(), `${filtered.length} products`);

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search products..."
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-orange-300"
        />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {cats.map(c => <option key={c}>{c}</option>)}
        </select>
        <div className="flex gap-1">
          {(["all","ok","low","out"] as const).map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                statusFilter === s
                  ? s === "out" ? "bg-red-100 text-red-700 border-red-300"
                  : s === "low" ? "bg-yellow-100 text-yellow-700 border-yellow-300"
                  : s === "ok"  ? "bg-green-100 text-green-700 border-green-300"
                  : "bg-orange-100 text-orange-700 border-orange-300"
                  : "bg-white text-gray-500 border-gray-200"
              }`}>
              {s === "all" ? "All" : s === "ok" ? "✅ OK" : s === "low" ? "⚠️ Low" : "🔴 Out"}
            </button>
          ))}
        </div>
        <div className="flex gap-2 ml-auto">
          <button onClick={handlePrint}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            🖨️ Print
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            📥 Export Excel
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-5 py-3 text-left">Product</th>
              <th className="px-5 py-3 text-left">Category</th>
              <th className="px-5 py-3 text-center">Unit</th>
              <th className="px-5 py-3 text-right">Stock</th>
              <th className="px-5 py-3 text-right">Reserved</th>
              <th className="px-5 py-3 text-right">Available</th>
              <th className="px-5 py-3 text-right">Min Alert</th>
              <th className="px-5 py-3 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(p => {
              const isOut = p.stock <= 0;
              const isLow = !isOut && p.stock <= p.minStockAlert;
              const reserved = p.reservedStock || 0;
              const available = Math.max(0, p.stock - reserved);
              return (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-5 py-3 text-gray-500">
                    <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{p.category || "—"}</span>
                  </td>
                  <td className="px-5 py-3 text-center text-gray-500 text-xs">{p.unit}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-800">{p.stock}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{reserved || "—"}</td>
                  <td className="px-5 py-3 text-right font-medium text-gray-700">{available}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{p.minStockAlert}</td>
                  <td className="px-5 py-3 text-center">
                    {isOut
                      ? <span className="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-medium">Out of Stock</span>
                      : isLow
                      ? <span className="bg-yellow-100 text-yellow-700 text-xs px-2 py-0.5 rounded-full font-medium">Low Stock</span>
                      : <span className="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full font-medium">OK</span>
                    }
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No products match the filter.</div>}
        <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-400 text-right">
          {filtered.length} products shown
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 2. Low Stock & Out of Stock
// ═══════════════════════════════════════════════════════════════════
function LowStockReport({ products }: { products: Product[] }) {
  const tracked = products.filter(p => p.trackInventory);
  const outOfStock = tracked.filter(p => p.stock <= 0);
  const lowStock   = tracked.filter(p => p.stock > 0 && p.stock <= p.minStockAlert);
  const reorderList = [...outOfStock, ...lowStock];

  const LS_HEADERS = ["Product", "Category", "Unit", "Current Stock", "Min Alert", "Status"];
  const getLsRows = () => reorderList.map(p => [
    p.name, p.category || "—", p.unit, p.stock, p.minStockAlert,
    p.stock <= 0 ? "Out of Stock" : "Low Stock",
  ]);
  const handleExport = () => exportXlsx(getLsRows(), "low_stock_reorder_list", LS_HEADERS);
  const handlePrint  = () => printReport("Low Stock & Reorder List", LS_HEADERS, getLsRows(), `${outOfStock.length} out · ${lowStock.length} low`);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5">
          <p className="text-xs text-red-400 font-semibold uppercase tracking-wide mb-1">Out of Stock</p>
          <p className="text-4xl font-bold text-red-600">{outOfStock.length}</p>
          <p className="text-xs text-red-400 mt-1">Products with zero stock</p>
        </div>
        <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-5">
          <p className="text-xs text-yellow-600 font-semibold uppercase tracking-wide mb-1">Low Stock</p>
          <p className="text-4xl font-bold text-yellow-600">{lowStock.length}</p>
          <p className="text-xs text-yellow-500 mt-1">At or below minimum alert</p>
        </div>
      </div>

      {reorderList.length === 0 ? (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-8 text-center">
          <p className="text-3xl mb-2">✅</p>
          <p className="text-green-700 font-medium">All stocked well!</p>
          <p className="text-green-500 text-sm mt-1">No products are low or out of stock.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <div className="flex items-start justify-between px-4 md:px-5 py-4 border-b border-gray-100 gap-2 flex-wrap">
            <p className="font-semibold text-gray-800">Reorder List <span className="text-gray-400 font-normal text-sm">({reorderList.length} products)</span></p>
            <div className="flex gap-2">
              <button onClick={handlePrint}
                className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
                🖨️ Print
              </button>
              <button onClick={handleExport}
                className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
                📥 Export Excel
              </button>
            </div>
          </div>
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">Product</th>
                <th className="px-5 py-3 text-left">Category</th>
                <th className="px-5 py-3 text-right">Current Stock</th>
                <th className="px-5 py-3 text-right">Min Alert</th>
                <th className="px-5 py-3 text-right">Shortfall</th>
                <th className="px-5 py-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {reorderList.map(p => {
                const isOut = p.stock <= 0;
                const shortfall = Math.max(0, p.minStockAlert - p.stock);
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-800">{p.name}</td>
                    <td className="px-5 py-3 text-gray-500 text-xs">{p.category || "—"}</td>
                    <td className={`px-5 py-3 text-right font-bold ${isOut ? "text-red-600" : "text-yellow-600"}`}>
                      {p.stock} {p.unit}
                    </td>
                    <td className="px-5 py-3 text-right text-gray-400">{p.minStockAlert} {p.unit}</td>
                    <td className="px-5 py-3 text-right text-orange-600 font-medium">
                      {shortfall > 0 ? `+${shortfall} needed` : "—"}
                    </td>
                    <td className="px-5 py-3 text-center">
                      {isOut
                        ? <span className="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full font-medium">🔴 Out</span>
                        : <span className="bg-yellow-100 text-yellow-700 text-xs px-2 py-0.5 rounded-full font-medium">⚠️ Low</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 3. Stock Movement History
// ═══════════════════════════════════════════════════════════════════
function MovementReport({
  movements, loading, fromDate, toDate, setFromDate, setToDate, onReload
}: {
  movements: StockMovement[];
  loading: boolean;
  fromDate: string; toDate: string;
  setFromDate: (v: string) => void;
  setToDate: (v: string) => void;
  onReload: () => void;
}) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const filtered = useMemo(() => {
    const from = new Date(fromDate); from.setHours(0,0,0,0);
    const to   = new Date(toDate);   to.setHours(23,59,59,999);
    return movements.filter(m => {
      const d = new Date(m.createdAt);
      if (d < from || d > to) return false;
      if (search && !m.productName.toLowerCase().includes(search.toLowerCase())) return false;
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      return true;
    });
  }, [movements, fromDate, toDate, search, typeFilter]);

  const inQty  = filtered.filter(m => m.direction === "in").reduce((s, m) => s + m.qty, 0);
  const outQty = filtered.filter(m => m.direction === "out").reduce((s, m) => s + m.qty, 0);

  const MV_HEADERS = ["Date", "Product", "Type", "In Qty", "Out Qty", "Stock Before", "Stock After", "Reason", "By"];
  const getMvRows = () => filtered.map(m => [
    fmtDate(m.createdAt), m.productName, TYPE_LABEL[m.type] || m.type,
    m.direction === "in" ? m.qty : "",
    m.direction === "out" ? m.qty : "",
    m.stockBefore, m.stockAfter, m.reason || "—", m.createdByName || "—",
  ]);
  const handleExport = () => exportXlsx(getMvRows(), "stock_movement_history", MV_HEADERS);
  const handlePrint  = () => printReport("Stock Movement History", MV_HEADERS, getMvRows(), `${fromDate} to ${toDate}`);

  const uniqueTypes = Array.from(new Set(movements.map(m => m.type)));

  if (loading) return (
    <div className="flex items-center justify-center h-48 text-gray-400">
      <span className="animate-spin mr-2">⏳</span> Loading movements...
    </div>
  );

  return (
    <div>
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        <div className="bg-white rounded-xl shadow-sm p-4 border-l-4 border-blue-400">
          <p className="text-xs text-gray-400 font-medium">Total Movements</p>
          <p className="text-2xl font-bold text-gray-800">{filtered.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4 border-l-4 border-green-400">
          <p className="text-xs text-gray-400 font-medium">Total Stock In</p>
          <p className="text-2xl font-bold text-green-600">+{inQty.toLocaleString("en-IN")}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4 border-l-4 border-red-400">
          <p className="text-xs text-gray-400 font-medium">Total Stock Out</p>
          <p className="text-2xl font-bold text-red-600">-{outQty.toLocaleString("en-IN")}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        <span className="self-center text-gray-400 text-sm">to</span>
        <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search product..."
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-orange-300" />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="all">All Types</option>
          {uniqueTypes.map(t => <option key={t} value={t}>{TYPE_LABEL[t] || t}</option>)}
        </select>
        <button onClick={onReload}
          className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">
          🔄 Refresh
        </button>
        <div className="flex gap-2 ml-auto">
          <button onClick={handlePrint}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            🖨️ Print
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            📥 Export Excel
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-5 py-3 text-left">Date</th>
              <th className="px-5 py-3 text-left">Product</th>
              <th className="px-5 py-3 text-left">Type</th>
              <th className="px-5 py-3 text-right">Qty</th>
              <th className="px-5 py-3 text-right">Before</th>
              <th className="px-5 py-3 text-right">After</th>
              <th className="px-5 py-3 text-left">Reason</th>
              <th className="px-5 py-3 text-left">By</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.slice(0, 200).map(m => (
              <tr key={`${m.productId}-${m.id}`} className="hover:bg-gray-50">
                <td className="px-5 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(m.createdAt)}</td>
                <td className="px-5 py-3 font-medium text-gray-800">{m.productName}</td>
                <td className="px-5 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    m.direction === "in" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    {TYPE_LABEL[m.type] || m.type}
                  </span>
                </td>
                <td className={`px-5 py-3 text-right font-semibold ${m.direction === "in" ? "text-green-600" : "text-red-600"}`}>
                  {m.direction === "in" ? "+" : "-"}{m.qty}
                </td>
                <td className="px-5 py-3 text-right text-gray-400">{m.stockBefore}</td>
                <td className="px-5 py-3 text-right font-medium text-gray-700">{m.stockAfter}</td>
                <td className="px-5 py-3 text-gray-500 text-xs">{m.reason || "—"}</td>
                <td className="px-5 py-3 text-gray-400 text-xs">{m.createdByName || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No movements found for this date range.</div>}
        {filtered.length > 200 && (
          <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-400 text-center">
            Showing first 200 of {filtered.length} — export Excel for full list
          </div>
        )}
        {filtered.length > 0 && filtered.length <= 200 && (
          <div className="px-5 py-3 border-t border-gray-100 text-xs text-gray-400 text-right">
            {filtered.length} movements
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 4. Stock Valuation
// ═══════════════════════════════════════════════════════════════════
function ValuationReport({ products }: { products: Product[] }) {
  const [catFilter, setCatFilter] = useState("All");
  const [sortBy, setSortBy] = useState<"value" | "name" | "stock">("value");

  const tracked = products.filter(p => p.trackInventory && p.stock > 0);
  const cats = ["All", ...Array.from(new Set(tracked.map(p => p.category).filter(Boolean)))];

  const filtered = useMemo(() => {
    let list = catFilter === "All" ? tracked : tracked.filter(p => p.category === catFilter);
    if (sortBy === "value") list = [...list].sort((a, b) => (b.sellingPrice * b.stock) - (a.sellingPrice * a.stock));
    if (sortBy === "name")  list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sortBy === "stock") list = [...list].sort((a, b) => b.stock - a.stock);
    return list;
  }, [tracked, catFilter, sortBy]);

  const totalSellValue = filtered.reduce((s, p) => s + p.sellingPrice * p.stock, 0);
  const totalCostValue = filtered.reduce((s, p) => s + p.costPrice  * p.stock, 0);
  const totalMargin    = totalSellValue - totalCostValue;

  const VAL_HEADERS = ["Product", "Category", "Unit", "Stock", "Cost Price", "Sell Price", "Cost Value", "Sell Value", "Margin Value"];
  const getValRows = () => filtered.map(p => [
    p.name, p.category || "—", p.unit, p.stock, p.costPrice, p.sellingPrice,
    +(p.costPrice * p.stock).toFixed(2),
    +(p.sellingPrice * p.stock).toFixed(2),
    +((p.sellingPrice - p.costPrice) * p.stock).toFixed(2),
  ]);
  const handleExport = () => exportXlsx(getValRows(), "stock_valuation", VAL_HEADERS);
  const handlePrint  = () => printReport("Stock Valuation Report", VAL_HEADERS, getValRows(),
    `Sell ₹${totalSellValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })} · Cost ₹${totalCostValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <div className="bg-white rounded-xl shadow-sm p-5 border-l-4 border-blue-400">
          <p className="text-xs text-gray-400 font-medium mb-1">Total Sell Value</p>
          <p className="text-2xl font-bold text-gray-800">₹{totalSellValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
          <p className="text-xs text-gray-400 mt-0.5">If all stock sold at sell price</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-5 border-l-4 border-gray-400">
          <p className="text-xs text-gray-400 font-medium mb-1">Total Cost Value</p>
          <p className="text-2xl font-bold text-gray-800">₹{totalCostValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
          <p className="text-xs text-gray-400 mt-0.5">Capital invested in stock</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-5 border-l-4 border-green-400">
          <p className="text-xs text-gray-400 font-medium mb-1">Gross Margin Value</p>
          <p className="text-2xl font-bold text-green-600">₹{totalMargin.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
          <p className="text-xs text-gray-400 mt-0.5">Sell − Cost on current stock</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {cats.map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="value">Sort: Highest Value</option>
          <option value="stock">Sort: Highest Stock</option>
          <option value="name">Sort: A → Z</option>
        </select>
        <div className="flex gap-2 ml-auto">
          <button onClick={handlePrint}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            🖨️ Print
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            📥 Export Excel
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-5 py-3 text-left">Product</th>
              <th className="px-5 py-3 text-left">Category</th>
              <th className="px-5 py-3 text-right">Stock</th>
              <th className="px-5 py-3 text-right">Cost / Unit</th>
              <th className="px-5 py-3 text-right">Sell / Unit</th>
              <th className="px-5 py-3 text-right">Cost Value</th>
              <th className="px-5 py-3 text-right">Sell Value</th>
              <th className="px-5 py-3 text-right">Margin</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(p => {
              const costVal = p.costPrice  * p.stock;
              const sellVal = p.sellingPrice * p.stock;
              const margin  = sellVal - costVal;
              const pct     = costVal > 0 ? ((margin / costVal) * 100).toFixed(0) : "—";
              return (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-5 py-3 text-gray-500 text-xs">
                    <span className="bg-gray-100 px-2 py-0.5 rounded-full">{p.category || "—"}</span>
                  </td>
                  <td className="px-5 py-3 text-right text-gray-700">{p.stock} {p.unit}</td>
                  <td className="px-5 py-3 text-right text-gray-500">₹{p.costPrice}</td>
                  <td className="px-5 py-3 text-right text-gray-500">₹{p.sellingPrice}</td>
                  <td className="px-5 py-3 text-right text-gray-700">₹{costVal.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-800">₹{sellVal.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
                  <td className="px-5 py-3 text-right">
                    <span className="text-green-600 font-medium">₹{margin.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
                    {pct !== "—" && <span className="text-green-400 text-xs ml-1">({pct}%)</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200">
            <tr>
              <td colSpan={5} className="px-5 py-3 font-semibold text-gray-700">Total ({filtered.length} products)</td>
              <td className="px-5 py-3 text-right font-bold text-gray-800">₹{totalCostValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
              <td className="px-5 py-3 text-right font-bold text-gray-800">₹{totalSellValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
              <td className="px-5 py-3 text-right font-bold text-green-600">₹{totalMargin.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</td>
            </tr>
          </tfoot>
        </table>
        {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No stocked products found.</div>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// 5. Fast / Slow Moving
// ═══════════════════════════════════════════════════════════════════
function FastSlowReport({ products, orders }: { products: Product[]; orders: Order[] }) {
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [view, setView] = useState<"chart" | "table">("chart");
  const [catFilter, setCatFilter] = useState("All");

  const cats = ["All", ...Array.from(new Set(products.map(p => p.category).filter(Boolean)))];

  const ranked = useMemo(() => {
    const cutoff = new Date(Date.now() - days * 864e5);
    const activeOrders = orders.filter(o =>
      o.status !== "cancelled" && new Date(o.createdAt) >= cutoff
    );

    const map: Record<string, { name: string; category: string; qty: number; revenue: number }> = {};
    activeOrders.forEach(o => {
      o.items.forEach(item => {
        if (!map[item.productId]) {
          const prod = products.find(p => p.id === item.productId);
          map[item.productId] = {
            name: item.productName,
            category: prod?.category || "—",
            qty: 0, revenue: 0
          };
        }
        map[item.productId].qty     += item.quantity;
        map[item.productId].revenue += item.total;
      });
    });

    // Add products with 0 sales too
    products.forEach(p => {
      if (!map[p.id!]) map[p.id!] = { name: p.name, category: p.category || "—", qty: 0, revenue: 0 };
    });

    return Object.entries(map)
      .map(([id, v]) => ({ id, ...v }))
      .filter(p => catFilter === "All" || p.category === catFilter)
      .sort((a, b) => b.qty - a.qty);
  }, [orders, products, days, catFilter]);

  const fast = ranked.slice(0, 10);
  const slow = ranked.filter(p => p.qty === 0);
  const chartData = fast.map(p => ({ name: p.name.length > 15 ? p.name.slice(0, 15) + "…" : p.name, qty: p.qty, revenue: p.revenue }));

  const COLORS = ["#f97316","#fb923c","#fdba74","#fed7aa","#ffedd5","#fef3c7","#fde68a","#fcd34d","#fbbf24","#f59e0b"];
  const FS_HEADERS = ["Rank", "Product", "Category", "Qty Sold", "Revenue", "Tag"];
  const getFsRows = () => ranked.map((p, i) => [
    i + 1, p.name, p.category, p.qty,
    `₹${p.revenue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`,
    p.qty === 0 ? "Dead Stock" : i < ranked.length * 0.2 ? "Fast Moving" : "Slow Moving",
  ]);
  const handleExport = () => exportXlsx(getFsRows(), `fast_slow_moving_${days}days`, FS_HEADERS);
  const handlePrint  = () => printReport(`Fast / Slow Moving Products — Last ${days} Days`, FS_HEADERS, getFsRows());

  return (
    <div>
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <div className="bg-green-50 border border-green-200 rounded-xl p-4">
          <p className="text-xs text-green-600 font-semibold uppercase">Fast Moving</p>
          <p className="text-3xl font-bold text-green-700">{ranked.filter(p => p.qty > 0).length}</p>
          <p className="text-xs text-green-500 mt-0.5">Products with sales</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-xs text-red-500 font-semibold uppercase">Dead Stock</p>
          <p className="text-3xl font-bold text-red-600">{slow.length}</p>
          <p className="text-xs text-red-400 mt-0.5">Zero sales in period</p>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
          <p className="text-xs text-blue-500 font-semibold uppercase">Total Products</p>
          <p className="text-3xl font-bold text-blue-600">{ranked.length}</p>
          <p className="text-xs text-blue-400 mt-0.5">In selected category</p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex gap-1">
          {([30, 60, 90] as const).map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                days === d ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-500 border-gray-200"
              }`}>
              {d} Days
            </button>
          ))}
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          {cats.map(c => <option key={c}>{c}</option>)}
        </select>
        <div className="flex gap-1">
          {(["chart", "table"] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                view === v ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-500 border-gray-200"
              }`}>
              {v === "chart" ? "📊 Chart" : "📋 Table"}
            </button>
          ))}
        </div>
        <div className="flex gap-2 ml-auto">
          <button onClick={handlePrint}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            🖨️ Print
          </button>
          <button onClick={handleExport}
            className="flex items-center gap-2 border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
            📥 Export Excel
          </button>
        </div>
      </div>

      {view === "chart" && (
        <div className="bg-white rounded-xl shadow-sm p-5 mb-4">
          <p className="text-sm font-semibold text-gray-700 mb-4">Top 10 Products by Qty Sold (last {days} days)</p>
          {fast.length === 0 ? (
            <div className="text-center py-12 text-gray-400">No sales data in this period.</div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 60 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6b7280" }} angle={-35} textAnchor="end" interval={0} />
                <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
                <Tooltip
                  formatter={(v: any, name: string) => [
                    name === "qty" ? `${v} units` : `₹${Number(v).toLocaleString("en-IN")}`,
                    name === "qty" ? "Qty Sold" : "Revenue"
                  ]}
                  contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }}
                />
                <Bar dataKey="qty" radius={[4, 4, 0, 0]}>
                  {chartData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {view === "table" && (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-center">Rank</th>
                <th className="px-5 py-3 text-left">Product</th>
                <th className="px-5 py-3 text-left">Category</th>
                <th className="px-5 py-3 text-right">Qty Sold</th>
                <th className="px-5 py-3 text-right">Revenue</th>
                <th className="px-5 py-3 text-center">Tag</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ranked.map((p, i) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 text-center">
                    <span className={`text-sm font-bold ${
                      i === 0 ? "text-yellow-500" : i === 1 ? "text-gray-400" : i === 2 ? "text-orange-400" : "text-gray-300"
                    }`}>#{i + 1}</span>
                  </td>
                  <td className="px-5 py-3 font-medium text-gray-800">{p.name}</td>
                  <td className="px-5 py-3 text-gray-500 text-xs">
                    <span className="bg-gray-100 px-2 py-0.5 rounded-full">{p.category}</span>
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-800">{p.qty}</td>
                  <td className="px-5 py-3 text-right text-gray-700">
                    {p.revenue > 0 ? `₹${p.revenue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—"}
                  </td>
                  <td className="px-5 py-3 text-center">
                    {p.qty === 0
                      ? <span className="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full">Dead Stock</span>
                      : i < Math.ceil(ranked.length * 0.2)
                      ? <span className="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">🚀 Fast</span>
                      : <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">Slow</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ranked.length === 0 && <div className="text-center py-12 text-gray-400">No products found.</div>}
        </div>
      )}

      {/* Dead stock callout */}
      {slow.length > 0 && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm font-semibold text-red-700 mb-2">🪦 Dead Stock — {slow.length} products with zero sales in {days} days</p>
          <div className="flex flex-wrap gap-2">
            {slow.slice(0, 20).map(p => (
              <span key={p.id} className="text-xs bg-white border border-red-200 text-red-600 px-2 py-1 rounded-lg">{p.name}</span>
            ))}
            {slow.length > 20 && <span className="text-xs text-red-400">+{slow.length - 20} more</span>}
          </div>
        </div>
      )}
    </div>
  );
}