import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, AppUser } from "../types";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Cell,
} from "recharts";

// ── Types ──────────────────────────────────────────────────────────
type AgentTab = "field" | "delivery" | "daily" | "packing";

// ── Shared Helpers ─────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
}
function fmtINR0(n: number) {
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}
function fmtINR(n: number) {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function exportXlsx(rows: any[][], filename: string, headers: string[]) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function printReport(
  title: string,
  headers: string[],
  rows: (string | number)[][],
  subtitle?: string
) {
  const tableRows = rows
    .map(r => `<tr>${r.map(c => `<td>${c ?? "—"}</td>`).join("")}</tr>`)
    .join("");
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
      tfoot td { font-weight: bold; background: #fff7ed; border-top: 2px solid #f97316; }
      @media print { @page { margin: 12mm; size: A4 landscape; } }
    </style></head>
    <body>
      <h2>${title}</h2>
      <p class="sub">${subtitle ?? ""} &nbsp;·&nbsp; Printed ${new Date().toLocaleDateString(
    "en-IN",
    { day: "2-digit", month: "short", year: "numeric" } as any
  )}</p>
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

// ── Period helpers ─────────────────────────────────────────────────
function thisMonthRange() {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
    to:   now.toISOString().slice(0, 10),
  };
}

// ── Shared UI pieces ───────────────────────────────────────────────
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

function SCard({
  label, value, sub, color = "blue",
}: { label: string; value: string; sub?: string; color?: string }) {
  const borders: Record<string, string> = {
    blue: "border-blue-400", green: "border-green-400", orange: "border-orange-400",
    red: "border-red-400", purple: "border-purple-400", yellow: "border-yellow-400",
  };
  return (
    <div className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${borders[color] ?? borders.blue}`}>
      <p className="text-xs text-gray-400 font-medium mb-1 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function DateRange({
  from, to, setFrom, setTo,
}: { from: string; to: string; setFrom(v: string): void; setTo(v: string): void }) {
  const presets = [
    { label: "This Month", fn() { const r = thisMonthRange(); setFrom(r.from); setTo(r.to); } },
    {
      label: "Last Month", fn() {
        const now = new Date(); const m = now.getMonth(); const y = now.getFullYear();
        setFrom(new Date(y, m - 1, 1).toISOString().slice(0, 10));
        setTo(new Date(y, m, 0).toISOString().slice(0, 10));
      },
    },
    {
      label: "This Quarter", fn() {
        const now = new Date(); const q = Math.floor(now.getMonth() / 3);
        setFrom(new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10));
        setTo(now.toISOString().slice(0, 10));
      },
    },
    {
      label: "This Year", fn() {
        setFrom(`${new Date().getFullYear()}-01-01`);
        setTo(new Date().toISOString().slice(0, 10));
      },
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="date" value={from} onChange={e => setFrom(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
      <span className="text-gray-400 text-sm">to</span>
      <input type="date" value={to} onChange={e => setTo(e.target.value)}
        className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
      {presets.map(p => (
        <button key={p.label} onClick={p.fn}
          className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-orange-50 hover:text-orange-600 hover:border-orange-200 transition-all">
          {p.label}
        </button>
      ))}
    </div>
  );
}

const BAR_COLORS = ["#f97316","#3b82f6","#10b981","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#ec4899"];

// ══════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════
export default function AgentReports() {
  const [activeTab, setActiveTab] = useState<AgentTab>("field");
  const [orders, setOrders]       = useState<Order[]>([]);
  const [users, setUsers]         = useState<AppUser[]>([]);
  const [loading, setLoading]     = useState(true);

  useEffect(() => {
    Promise.all([
      getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"))),
      getDocs(query(collection(db, "users"),  orderBy("name"))),
    ]).then(([oSnap, uSnap]) => {
      setOrders(oSnap.docs.map(d => ({ id: d.id, ...d.data() } as Order)));
      setUsers(uSnap.docs.map(d => d.data() as AppUser));
      setLoading(false);
    });
  }, []);

  const tabs: { key: AgentTab; label: string; icon: string }[] = [
    { key: "field",    label: "Field Agents",    icon: "🧑‍💼" },
    { key: "delivery", label: "Delivery Agents", icon: "🚚" },
    { key: "daily",    label: "Daily Activity",  icon: "📅" },
    { key: "packing",  label: "Packing Staff",   icon: "📦" },
  ];

  if (loading) return (
    <div className="p-4 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading agent data...
    </div>
  );

  const fieldAgents    = users.filter(u => u.role === "field_agent");
  const deliveryAgents = users.filter(u => u.role === "delivery");
  const packingStaff   = users.filter(u => u.role === "packing_staff");

  return (
    <div className="p-3 md:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800">🧑‍💼 Agent Reports</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          {fieldAgents.length} field agents · {deliveryAgents.length} delivery agents · {packingStaff.length} packing staff
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

      {activeTab === "field"    && <FieldAgentReport    orders={orders} agents={fieldAgents} />}
      {activeTab === "delivery" && <DeliveryAgentReport orders={orders} agents={deliveryAgents} />}
      {activeTab === "daily"    && <DailyActivityReport orders={orders} users={users} />}
      {activeTab === "packing"  && <PackingStaffReport  orders={orders} staff={packingStaff} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 1. Field Agent Summary
// ══════════════════════════════════════════════════════════════════
function FieldAgentReport({ orders, agents }: { orders: Order[]; agents: AppUser[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom]     = useState(df);
  const [to, setTo]         = useState(dt);
  const [selected, setSelected] = useState<string | null>(null); // drilldown agent uid

  const filtered = useMemo(() => {
    const f = new Date(from); f.setHours(0, 0, 0, 0);
    const t = new Date(to);   t.setHours(23, 59, 59, 999);
    return orders.filter(o =>
      new Date(o.createdAt) >= f &&
      new Date(o.createdAt) <= t &&
      o.status !== "cancelled"
    );
  }, [orders, from, to]);

  // Per-agent stats
  const agentStats = useMemo(() => {
    const map: Record<string, {
      uid: string; name: string; phone: string;
      totalOrders: number; deliveredOrders: number;
      totalValue: number; collectedAmount: number;
      pendingAmount: number; regions: Set<string>;
      customers: Set<string>;
    }> = {};

    // Seed all agents (even with 0 orders)
    agents.forEach(a => {
      map[a.name] = {
        uid: a.uid, name: a.name, phone: a.phone || "—",
        totalOrders: 0, deliveredOrders: 0,
        totalValue: 0, collectedAmount: 0, pendingAmount: 0,
        regions: new Set(), customers: new Set(),
      };
    });

    filtered.forEach(o => {
      if (!map[o.agentName]) {
        map[o.agentName] = {
          uid: o.agentId, name: o.agentName, phone: "—",
          totalOrders: 0, deliveredOrders: 0,
          totalValue: 0, collectedAmount: 0, pendingAmount: 0,
          regions: new Set(), customers: new Set(),
        };
      }
      const s = map[o.agentName];
      s.totalOrders++;
      s.totalValue      += o.totalAmount;
      s.collectedAmount += o.amountCollected ?? 0;
      s.pendingAmount   += Math.max(0, o.totalAmount - (o.amountCollected ?? 0));
      if (o.status === "delivered") s.deliveredOrders++;
      if (o.regionName) s.regions.add(o.regionName);
      s.customers.add(o.customerId);
    });

    return Object.values(map).sort((a, b) => b.totalValue - a.totalValue);
  }, [filtered, agents]);

  // Drilldown orders for selected agent
  const drillOrders = useMemo(() => {
    if (!selected) return [];
    return filtered.filter(o => o.agentId === selected || o.agentName === agentStats.find(a => a.uid === selected)?.name);
  }, [selected, filtered, agentStats]);

  const grandTotal    = agentStats.reduce((s, a) => s + a.totalValue, 0);
  const grandCollected = agentStats.reduce((s, a) => s + a.collectedAmount, 0);
  const grandPending  = agentStats.reduce((s, a) => s + a.pendingAmount, 0);

  const chartData = agentStats.slice(0, 10).map(a => ({
    name: a.name.split(" ")[0],
    orders: a.totalOrders,
    value: +a.totalValue.toFixed(0),
  }));

  const SUMMARY_HEADERS = ["Agent", "Phone", "Total Orders", "Delivered", "Delivery %", "Total Value", "Collected", "Pending", "Unique Customers", "Regions"];
  const getSummaryRows = () => agentStats.map(a => [
    a.name, a.phone, a.totalOrders, a.deliveredOrders,
    a.totalOrders > 0 ? `${((a.deliveredOrders / a.totalOrders) * 100).toFixed(0)}%` : "0%",
    a.totalValue.toFixed(2), a.collectedAmount.toFixed(2), a.pendingAmount.toFixed(2),
    a.customers.size, Array.from(a.regions).join(", ") || "—",
  ]);

  const DRILL_HEADERS = ["Date", "Invoice", "Customer", "Region", "Amount", "Collected", "Status"];
  const getDrillRows = () => drillOrders.map(o => [
    fmtDate(o.createdAt), o.invoiceNumber || o.id!, o.customerName, o.regionName || "—",
    o.totalAmount.toFixed(2), (o.amountCollected ?? 0).toFixed(2), o.status,
  ]);

  const selectedAgent = agentStats.find(a => a.uid === selected);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="Field Agents"    value={`${agents.length}`}          color="blue"   sub="Active in system" />
        <SCard label="Total Orders"    value={`${filtered.length}`}        color="orange" sub="In selected period" />
        <SCard label="Total Value"     value={fmtINR0(grandTotal)}         color="green"  />
        <SCard label="Pending Collection" value={fmtINR0(grandPending)}   color="red"    />
      </div>

      {/* Date range + actions */}
      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Field Agent Summary", SUMMARY_HEADERS, getSummaryRows(),
            `Period: ${from} to ${to} · Total Value ${fmtINR0(grandTotal)}`)}
          onExport={() => exportXlsx(getSummaryRows(), "field_agent_summary", SUMMARY_HEADERS)}
        />
      </div>

      {/* Bar chart */}
      {chartData.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Orders by Agent (top 10)</p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6b7280" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} />
              <Tooltip
                formatter={(v: any, name: string) => [
                  name === "orders" ? `${v} orders` : fmtINR0(v), name === "orders" ? "Orders" : "Value"
                ]}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }}
              />
              <Bar dataKey="orders" radius={[4, 4, 0, 0]}>
                {chartData.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Summary table */}
      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-left">Phone</th>
              <th className="px-4 py-3 text-right">Orders</th>
              <th className="px-4 py-3 text-right">Delivered</th>
              <th className="px-4 py-3 text-right">Delivery %</th>
              <th className="px-4 py-3 text-right">Total Value</th>
              <th className="px-4 py-3 text-right">Collected</th>
              <th className="px-4 py-3 text-right">Pending</th>
              <th className="px-4 py-3 text-center">Customers</th>
              <th className="px-4 py-3 text-left">Regions</th>
              <th className="px-4 py-3 text-center">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {agentStats.map(a => {
              const pct = a.totalOrders > 0 ? (a.deliveredOrders / a.totalOrders) * 100 : 0;
              return (
                <tr key={a.uid} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">{a.name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{a.phone}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-800">{a.totalOrders}</td>
                  <td className="px-4 py-3 text-right text-green-600">{a.deliveredOrders}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 bg-gray-100 rounded-full h-1.5">
                        <div className="h-1.5 rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-600">{pct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-800">{fmtINR0(a.totalValue)}</td>
                  <td className="px-4 py-3 text-right text-green-600">{fmtINR0(a.collectedAmount)}</td>
                  <td className="px-4 py-3 text-right">
                    {a.pendingAmount > 0
                      ? <span className="text-red-500 font-medium">{fmtINR0(a.pendingAmount)}</span>
                      : <span className="text-green-500 text-xs">Clear</span>}
                  </td>
                  <td className="px-4 py-3 text-center text-gray-600">{a.customers.size}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    <div className="flex flex-wrap gap-1 max-w-[180px]">
                      {Array.from(a.regions).slice(0, 3).map(r => (
                        <span key={r} className="bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded text-xs">{r}</span>
                      ))}
                      {a.regions.size > 3 && <span className="text-gray-400 text-xs">+{a.regions.size - 3}</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => setSelected(selected === a.uid ? null : a.uid)}
                      className="text-xs bg-orange-50 text-orange-600 px-3 py-1 rounded-lg hover:bg-orange-100 border border-orange-200">
                      {selected === a.uid ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td colSpan={5} className="px-4 py-3 text-gray-700">Total</td>
              <td className="px-4 py-3 text-right">{fmtINR0(grandTotal)}</td>
              <td className="px-4 py-3 text-right text-green-700">{fmtINR0(grandCollected)}</td>
              <td className="px-4 py-3 text-right text-red-600">{fmtINR0(grandPending)}</td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
        {agentStats.length === 0 && (
          <div className="text-center py-12 text-gray-400">No field agent data found.</div>
        )}
      </div>

      {/* Drilldown panel */}
      {selected && selectedAgent && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="flex items-start justify-between px-4 md:px-5 py-4 border-b border-gray-100 gap-2 flex-wrap">
            <p className="font-semibold text-gray-800">
              📋 {selectedAgent.name}'s Orders
              <span className="text-gray-400 font-normal text-sm ml-2">({drillOrders.length} orders)</span>
            </p>
            <ActionBar
              onPrint={() => printReport(`${selectedAgent.name} — Order Detail`, DRILL_HEADERS, getDrillRows(),
                `Period: ${from} to ${to}`)}
              onExport={() => exportXlsx(getDrillRows(), `${selectedAgent.name.replace(/\s+/g, "_")}_orders`, DRILL_HEADERS)}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Invoice</th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-left">Region</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Collected</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {drillOrders.map(o => (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                    <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{o.regionName || "—"}</td>
                    <td className="px-4 py-3 text-right font-medium">{fmtINR(o.totalAmount)}</td>
                    <td className="px-4 py-3 text-right text-green-600">{fmtINR(o.amountCollected ?? 0)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${
                        o.status === "delivered"         ? "bg-green-100 text-green-700" :
                        o.status === "out_for_delivery"  ? "bg-blue-100 text-blue-700" :
                        o.status === "cancelled"         ? "bg-red-100 text-red-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>
                        {o.status.replace(/_/g, " ")}
                      </span>
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
// 2. Delivery Agent Summary
// ══════════════════════════════════════════════════════════════════
function DeliveryAgentReport({ orders, agents }: { orders: Order[]; agents: AppUser[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to, setTo]     = useState(dt);
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const f = new Date(from); f.setHours(0, 0, 0, 0);
    const t = new Date(to);   t.setHours(23, 59, 59, 999);
    return orders.filter(o =>
      o.deliveryPersonId &&
      new Date(o.createdAt) >= f &&
      new Date(o.createdAt) <= t
    );
  }, [orders, from, to]);

  const agentStats = useMemo(() => {
    const map: Record<string, {
      uid: string; name: string; phone: string;
      assigned: number; delivered: number; failed: number;
      totalValue: number; collectedAmount: number;
      avgDeliveryMin: number[]; vehicles: Set<string>;
    }> = {};

    agents.forEach(a => {
      map[a.uid] = {
        uid: a.uid, name: a.name, phone: a.phone || "—",
        assigned: 0, delivered: 0, failed: 0,
        totalValue: 0, collectedAmount: 0,
        avgDeliveryMin: [], vehicles: new Set(),
      };
    });

    filtered.forEach(o => {
      const uid  = o.deliveryPersonId!;
      const name = o.deliveryPersonName || uid;
      if (!map[uid]) {
        map[uid] = {
          uid, name, phone: "—",
          assigned: 0, delivered: 0, failed: 0,
          totalValue: 0, collectedAmount: 0,
          avgDeliveryMin: [], vehicles: new Set(),
        };
      }
      const s = map[uid];
      s.assigned++;
      s.totalValue      += o.totalAmount;
      s.collectedAmount += o.amountCollected ?? 0;
      if (o.vehicleNumber) s.vehicles.add(o.vehicleNumber);
      if (o.status === "delivered") {
        s.delivered++;
        if (o.assignedAt && o.deliveredAt) {
          const mins = (new Date(o.deliveredAt).getTime() - new Date(o.assignedAt).getTime()) / 60000;
          if (mins > 0 && mins < 1440) s.avgDeliveryMin.push(mins);
        }
      }
      if (o.status === "cancelled") s.failed++;
    });

    return Object.values(map).sort((a, b) => b.delivered - a.delivered);
  }, [filtered, agents]);

  const drillOrders = useMemo(() => {
    if (!selected) return [];
    return filtered.filter(o => o.deliveryPersonId === selected);
  }, [selected, filtered]);

  const grandDelivered  = agentStats.reduce((s, a) => s + a.delivered, 0);
  const grandAssigned   = agentStats.reduce((s, a) => s + a.assigned,  0);
  const grandCollected  = agentStats.reduce((s, a) => s + a.collectedAmount, 0);

  const HEADERS = ["Agent", "Phone", "Assigned", "Delivered", "Success %", "Cancelled", "Total Value", "Collected", "Avg Delivery Time", "Vehicles"];
  const getRows = () => agentStats.map(a => {
    const pct = a.assigned > 0 ? ((a.delivered / a.assigned) * 100).toFixed(0) + "%" : "0%";
    const avg = a.avgDeliveryMin.length > 0
      ? `${(a.avgDeliveryMin.reduce((s, v) => s + v, 0) / a.avgDeliveryMin.length).toFixed(0)} min`
      : "—";
    return [a.name, a.phone, a.assigned, a.delivered, pct, a.failed,
      a.totalValue.toFixed(2), a.collectedAmount.toFixed(2), avg,
      Array.from(a.vehicles).join(", ") || "—"];
  });

  const selectedAgent = agentStats.find(a => a.uid === selected);
  const DRILL_HEADERS = ["Date", "Invoice", "Customer", "Amount", "Collected", "Assigned At", "Delivered At", "Status"];
  const getDrillRows = () => drillOrders.map(o => [
    fmtDate(o.createdAt), o.invoiceNumber || o.id!, o.customerName,
    o.totalAmount.toFixed(2), (o.amountCollected ?? 0).toFixed(2),
    o.assignedAt ? fmtDate(o.assignedAt) : "—",
    o.deliveredAt ? fmtDate(o.deliveredAt) : "—",
    o.status,
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SCard label="Delivery Agents" value={`${agents.length}`}      color="blue"  />
        <SCard label="Total Delivered" value={`${grandDelivered}`}     color="green" sub={`of ${grandAssigned} assigned`} />
        <SCard label="Collected"       value={fmtINR0(grandCollected)} color="orange" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Delivery Agent Summary", HEADERS, getRows(), `Period: ${from} to ${to}`)}
          onExport={() => exportXlsx(getRows(), "delivery_agent_summary", HEADERS)}
        />
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Agent</th>
              <th className="px-4 py-3 text-left">Phone</th>
              <th className="px-4 py-3 text-right">Assigned</th>
              <th className="px-4 py-3 text-right">Delivered</th>
              <th className="px-4 py-3 text-right">Success %</th>
              <th className="px-4 py-3 text-right">Cancelled</th>
              <th className="px-4 py-3 text-right">Total Value</th>
              <th className="px-4 py-3 text-right">Collected</th>
              <th className="px-4 py-3 text-center">Avg Time</th>
              <th className="px-4 py-3 text-left">Vehicle</th>
              <th className="px-4 py-3 text-center">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {agentStats.map(a => {
              const pct = a.assigned > 0 ? (a.delivered / a.assigned) * 100 : 0;
              const avg = a.avgDeliveryMin.length > 0
                ? `${(a.avgDeliveryMin.reduce((s, v) => s + v, 0) / a.avgDeliveryMin.length).toFixed(0)} min`
                : "—";
              return (
                <tr key={a.uid} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">{a.name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{a.phone}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{a.assigned}</td>
                  <td className="px-4 py-3 text-right font-semibold text-green-600">{a.delivered}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 bg-gray-100 rounded-full h-1.5">
                        <div className="h-1.5 rounded-full bg-green-400" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-gray-600">{pct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-red-500">{a.failed || "—"}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-800">{fmtINR0(a.totalValue)}</td>
                  <td className="px-4 py-3 text-right text-green-600">{fmtINR0(a.collectedAmount)}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-500">{avg}</td>
                  <td className="px-4 py-3 text-xs text-gray-400">
                    {Array.from(a.vehicles).slice(0, 2).map(v => (
                      <span key={v} className="bg-gray-100 px-1.5 py-0.5 rounded mr-1">{v}</span>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => setSelected(selected === a.uid ? null : a.uid)}
                      className="text-xs bg-orange-50 text-orange-600 px-3 py-1 rounded-lg hover:bg-orange-100 border border-orange-200">
                      {selected === a.uid ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {agentStats.length === 0 && (
          <div className="text-center py-12 text-gray-400">No delivery data found for this period.</div>
        )}
      </div>

      {/* Drilldown */}
      {selected && selectedAgent && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="flex items-start justify-between px-4 md:px-5 py-4 border-b border-gray-100 gap-2 flex-wrap">
            <p className="font-semibold text-gray-800">
              🚚 {selectedAgent.name}'s Deliveries
              <span className="text-gray-400 font-normal text-sm ml-2">({drillOrders.length})</span>
            </p>
            <ActionBar
              onPrint={() => printReport(`${selectedAgent.name} — Deliveries`, DRILL_HEADERS, getDrillRows())}
              onExport={() => exportXlsx(getDrillRows(), `${selectedAgent.name.replace(/\s+/g, "_")}_deliveries`, DRILL_HEADERS)}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Invoice</th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Collected</th>
                  <th className="px-4 py-3 text-center">Assigned At</th>
                  <th className="px-4 py-3 text-center">Delivered At</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {drillOrders.map(o => (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                    <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                    <td className="px-4 py-3 text-right font-medium">{fmtINR(o.totalAmount)}</td>
                    <td className="px-4 py-3 text-right text-green-600">{fmtINR(o.amountCollected ?? 0)}</td>
                    <td className="px-4 py-3 text-center text-xs text-gray-500">{o.assignedAt ? fmtDate(o.assignedAt) : "—"}</td>
                    <td className="px-4 py-3 text-center text-xs text-gray-500">{o.deliveredAt ? fmtDate(o.deliveredAt) : "—"}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${
                        o.status === "delivered" ? "bg-green-100 text-green-700" :
                        o.status === "cancelled" ? "bg-red-100 text-red-700" :
                        "bg-gray-100 text-gray-600"}`}>
                        {o.status.replace(/_/g, " ")}
                      </span>
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
// 3. Daily Activity Report
// ══════════════════════════════════════════════════════════════════
function DailyActivityReport({ orders, users }: { orders: Order[]; users: AppUser[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate]         = useState(today);
  const [roleFilter, setRoleFilter] = useState<"all" | "field_agent" | "delivery" | "packing_staff">("all");

  // All activity on selected date
  const { fieldActivity, deliveryActivity, packingActivity } = useMemo(() => {
    const f = new Date(date); f.setHours(0, 0, 0, 0);
    const t = new Date(date); t.setHours(23, 59, 59, 999);

    // Field: orders created that day
    const fieldMap: Record<string, { name: string; orders: number; value: number; delivered: number }> = {};
    orders
      .filter(o => new Date(o.createdAt) >= f && new Date(o.createdAt) <= t && o.status !== "cancelled")
      .forEach(o => {
        if (!fieldMap[o.agentName]) fieldMap[o.agentName] = { name: o.agentName, orders: 0, value: 0, delivered: 0 };
        fieldMap[o.agentName].orders++;
        fieldMap[o.agentName].value += o.totalAmount;
        if (o.status === "delivered") fieldMap[o.agentName].delivered++;
      });

    // Delivery: orders delivered that day
    const delivMap: Record<string, { name: string; delivered: number; collected: number }> = {};
    orders
      .filter(o => o.deliveredAt && new Date(o.deliveredAt) >= f && new Date(o.deliveredAt) <= t)
      .forEach(o => {
        const name = o.deliveryPersonName || "Unknown";
        if (!delivMap[name]) delivMap[name] = { name, delivered: 0, collected: 0 };
        delivMap[name].delivered++;
        delivMap[name].collected += o.amountCollected ?? 0;
      });

    // Packing: orders packed that day
    const packMap: Record<string, { name: string; packed: number }> = {};
    orders
      .filter(o => o.packedAt && new Date(o.packedAt) >= f && new Date(o.packedAt) <= t)
      .forEach(o => {
        const name = o.packedByName || "Unknown";
        if (!packMap[name]) packMap[name] = { name, packed: 0 };
        packMap[name].packed++;
      });

    return {
      fieldActivity:    Object.values(fieldMap).sort((a, b) => b.orders - a.orders),
      deliveryActivity: Object.values(delivMap).sort((a, b) => b.delivered - a.delivered),
      packingActivity:  Object.values(packMap).sort((a, b) => b.packed - a.packed),
    };
  }, [orders, date]);

  const totalOrdersCreated = fieldActivity.reduce((s, a) => s + a.orders, 0);
  const totalDelivered     = deliveryActivity.reduce((s, a) => s + a.delivered, 0);
  const totalPacked        = packingActivity.reduce((s, a) => s + a.packed, 0);
  const totalCollected     = deliveryActivity.reduce((s, a) => s + a.collected, 0);

  const HEADERS = ["Role", "Name", "Metric", "Value", "Notes"];
  const getRows = (): (string | number)[][] => [
    ...fieldActivity.map(a => ["Field Agent", a.name, "Orders Created", a.orders, `Value: ${fmtINR0(a.value)}`]),
    ...deliveryActivity.map(a => ["Delivery Agent", a.name, "Orders Delivered", a.delivered, `Collected: ${fmtINR0(a.collected)}`]),
    ...packingActivity.map(a => ["Packing Staff", a.name, "Orders Packed", a.packed, ""]),
  ];

  return (
    <div className="space-y-4">
      {/* Date picker */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium">Date:</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        </div>
        <div className="flex gap-1">
          <button onClick={() => setDate(today)}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-orange-50 hover:text-orange-600 transition-all">
            Today
          </button>
          <button onClick={() => {
            const d = new Date(date); d.setDate(d.getDate() - 1);
            setDate(d.toISOString().slice(0, 10));
          }}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 transition-all">
            ← Prev
          </button>
          <button onClick={() => {
            const d = new Date(date); d.setDate(d.getDate() + 1);
            if (d.toISOString().slice(0, 10) <= today) setDate(d.toISOString().slice(0, 10));
          }}
            className="px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 bg-white text-gray-500 hover:bg-gray-100 transition-all">
            Next →
          </button>
        </div>
        <div className="flex gap-1">
          {(["all", "field_agent", "delivery", "packing_staff"] as const).map(r => (
            <button key={r} onClick={() => setRoleFilter(r)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                roleFilter === r ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-500 border-gray-200"
              }`}>
              {r === "all" ? "All" : r === "field_agent" ? "🧑‍💼 Field" : r === "delivery" ? "🚚 Delivery" : "📦 Packing"}
            </button>
          ))}
        </div>
        <ActionBar
          onPrint={() => printReport(`Daily Activity — ${fmtDate(date)}`, HEADERS, getRows(), `${totalOrdersCreated} created · ${totalDelivered} delivered · ${totalPacked} packed`)}
          onExport={() => exportXlsx(getRows(), `daily_activity_${date}`, HEADERS)}
        />
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SCard label="Orders Created"   value={`${totalOrdersCreated}`}    color="blue"   sub="By field agents" />
        <SCard label="Orders Packed"    value={`${totalPacked}`}           color="purple" sub="By packing staff" />
        <SCard label="Orders Delivered" value={`${totalDelivered}`}        color="green"  sub="By delivery agents" />
        <SCard label="Collected Today"  value={fmtINR0(totalCollected)}    color="orange" />
      </div>

      {/* Field Agents section */}
      {(roleFilter === "all" || roleFilter === "field_agent") && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">🧑‍💼 Field Agents</span>
            <span className="text-xs text-gray-400">— Orders created on {fmtDate(date)}</span>
          </div>
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">Agent</th>
                <th className="px-5 py-3 text-right">Orders Created</th>
                <th className="px-5 py-3 text-right">Value</th>
                <th className="px-5 py-3 text-right">Delivered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {fieldActivity.length === 0
                ? <tr><td colSpan={4} className="text-center py-8 text-gray-400">No orders created on this date.</td></tr>
                : fieldActivity.map(a => (
                  <tr key={a.name} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-800">{a.name}</td>
                    <td className="px-5 py-3 text-right font-semibold text-blue-600">{a.orders}</td>
                    <td className="px-5 py-3 text-right text-gray-700">{fmtINR0(a.value)}</td>
                    <td className="px-5 py-3 text-right text-green-600">{a.delivered}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {/* Delivery Agents section */}
      {(roleFilter === "all" || roleFilter === "delivery") && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">🚚 Delivery Agents</span>
            <span className="text-xs text-gray-400">— Deliveries completed on {fmtDate(date)}</span>
          </div>
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">Agent</th>
                <th className="px-5 py-3 text-right">Deliveries Done</th>
                <th className="px-5 py-3 text-right">Amount Collected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {deliveryActivity.length === 0
                ? <tr><td colSpan={3} className="text-center py-8 text-gray-400">No deliveries on this date.</td></tr>
                : deliveryActivity.map(a => (
                  <tr key={a.name} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-800">{a.name}</td>
                    <td className="px-5 py-3 text-right font-semibold text-green-600">{a.delivered}</td>
                    <td className="px-5 py-3 text-right text-gray-700">{fmtINR0(a.collected)}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {/* Packing Staff section */}
      {(roleFilter === "all" || roleFilter === "packing_staff") && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">📦 Packing Staff</span>
            <span className="text-xs text-gray-400">— Orders packed on {fmtDate(date)}</span>
          </div>
          <table className="w-full text-sm min-w-[480px]">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-3 text-left">Staff</th>
                <th className="px-5 py-3 text-right">Orders Packed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {packingActivity.length === 0
                ? <tr><td colSpan={2} className="text-center py-8 text-gray-400">No packing activity on this date.</td></tr>
                : packingActivity.map(a => (
                  <tr key={a.name} className="hover:bg-gray-50">
                    <td className="px-5 py-3 font-medium text-gray-800">{a.name}</td>
                    <td className="px-5 py-3 text-right font-semibold text-purple-600">{a.packed}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// 4. Packing Staff Report
// ══════════════════════════════════════════════════════════════════
function PackingStaffReport({ orders, staff }: { orders: Order[]; staff: AppUser[] }) {
  const { from: df, to: dt } = thisMonthRange();
  const [from, setFrom] = useState(df);
  const [to, setTo]     = useState(dt);
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const f = new Date(from); f.setHours(0, 0, 0, 0);
    const t = new Date(to);   t.setHours(23, 59, 59, 999);
    return orders.filter(o =>
      o.packedAt &&
      new Date(o.packedAt) >= f &&
      new Date(o.packedAt) <= t
    );
  }, [orders, from, to]);

  const staffStats = useMemo(() => {
    const map: Record<string, {
      uid: string; name: string; phone: string;
      packed: number; totalItems: number;
      avgPackMin: number[]; firstPack: string; lastPack: string;
    }> = {};

    // Seed all known packing staff with 0
    staff.forEach(s => {
      map[s.name] = {
        uid: s.uid, name: s.name, phone: s.phone || "—",
        packed: 0, totalItems: 0, avgPackMin: [], firstPack: "", lastPack: "",
      };
    });

    filtered.forEach(o => {
      const name = o.packedByName || "Unknown";
      if (!map[name]) {
        map[name] = {
          uid: o.packedBy || name, name, phone: "—",
          packed: 0, totalItems: 0, avgPackMin: [], firstPack: "", lastPack: "",
        };
      }
      const s = map[name];
      s.packed++;
      s.totalItems += o.items.reduce((sum, i) => sum + i.quantity, 0);
      if (!s.firstPack || o.packedAt! < s.firstPack) s.firstPack = o.packedAt!;
      if (!s.lastPack  || o.packedAt! > s.lastPack)  s.lastPack  = o.packedAt!;
      if (o.packedAt && o.createdAt) {
        const mins = (new Date(o.packedAt).getTime() - new Date(o.createdAt).getTime()) / 60000;
        if (mins > 0 && mins < 1440) s.avgPackMin.push(mins);
      }
    });

    return Object.values(map).sort((a, b) => b.packed - a.packed);
  }, [filtered, staff]);

  const drillOrders = useMemo(() => {
    if (!selected) return [];
    const name = staffStats.find(s => s.uid === selected)?.name;
    return filtered.filter(o => o.packedByName === name || o.packedBy === selected);
  }, [selected, filtered, staffStats]);

  const grandPacked = staffStats.reduce((s, a) => s + a.packed, 0);
  const grandItems  = staffStats.reduce((s, a) => s + a.totalItems, 0);

  // Daily trend for chart
  const dailyMap: Record<string, number> = {};
  filtered.forEach(o => {
    if (!o.packedAt) return;
    const d = o.packedAt.slice(0, 10);
    dailyMap[d] = (dailyMap[d] || 0) + 1;
  });
  const chartData = Object.entries(dailyMap).sort().map(([d, count]) => ({
    date: new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
    packed: count,
  }));

  const HEADERS = ["Staff", "Phone", "Orders Packed", "Total Items", "Avg Pack Time", "First Pack", "Last Pack"];
  const getRows = () => staffStats.map(a => {
    const avg = a.avgPackMin.length > 0
      ? `${(a.avgPackMin.reduce((s, v) => s + v, 0) / a.avgPackMin.length).toFixed(0)} min`
      : "—";
    return [a.name, a.phone, a.packed, a.totalItems, avg,
      a.firstPack ? fmtDate(a.firstPack) : "—",
      a.lastPack  ? fmtDate(a.lastPack)  : "—"];
  });

  const selectedStaff = staffStats.find(s => s.uid === selected);
  const DRILL_HEADERS = ["Packed At", "Order ID", "Customer", "Items", "Qty", "Order Created"];
  const getDrillRows = () => drillOrders.map(o => [
    o.packedAt ? fmtDate(o.packedAt) : "—",
    o.invoiceNumber || o.id!,
    o.customerName,
    o.items.length,
    o.items.reduce((s, i) => s + i.quantity, 0),
    fmtDate(o.createdAt),
  ]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <SCard label="Packing Staff"   value={`${staff.length}`}   color="blue"   />
        <SCard label="Orders Packed"   value={`${grandPacked}`}    color="purple" sub="In selected period" />
        <SCard label="Total Items"     value={`${grandItems}`}     color="orange" sub="Units packed" />
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <DateRange from={from} to={to} setFrom={setFrom} setTo={setTo} />
        <ActionBar
          onPrint={() => printReport("Packing Staff Report", HEADERS, getRows(), `Period: ${from} to ${to} · ${grandPacked} orders packed`)}
          onExport={() => exportXlsx(getRows(), "packing_staff_report", HEADERS)}
        />
      </div>

      {/* Daily packing trend */}
      {chartData.length > 1 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-700 mb-4">Daily Packing Volume</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip formatter={(v: any) => [`${v} orders`, "Packed"]}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 12 }} />
              <Bar dataKey="packed" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm min-w-[480px]">
          <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="px-4 py-3 text-left">Staff</th>
              <th className="px-4 py-3 text-left">Phone</th>
              <th className="px-4 py-3 text-right">Orders Packed</th>
              <th className="px-4 py-3 text-right">Total Items</th>
              <th className="px-4 py-3 text-right">Items/Order</th>
              <th className="px-4 py-3 text-center">Avg Pack Time</th>
              <th className="px-4 py-3 text-center">First Pack</th>
              <th className="px-4 py-3 text-center">Last Pack</th>
              <th className="px-4 py-3 text-center">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {staffStats.map(a => {
              const avg = a.avgPackMin.length > 0
                ? `${(a.avgPackMin.reduce((s, v) => s + v, 0) / a.avgPackMin.length).toFixed(0)} min`
                : "—";
              const ipo = a.packed > 0 ? (a.totalItems / a.packed).toFixed(1) : "—";
              return (
                <tr key={a.uid} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-semibold text-gray-800">{a.name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{a.phone}</td>
                  <td className="px-4 py-3 text-right font-bold text-purple-600">{a.packed}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{a.totalItems}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{ipo}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-500">{avg}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-400">{a.firstPack ? fmtDate(a.firstPack) : "—"}</td>
                  <td className="px-4 py-3 text-center text-xs text-gray-400">{a.lastPack  ? fmtDate(a.lastPack)  : "—"}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => setSelected(selected === a.uid ? null : a.uid)}
                      className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-lg hover:bg-purple-100 border border-purple-200">
                      {selected === a.uid ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-orange-50 border-t-2 border-orange-200 font-semibold">
            <tr>
              <td colSpan={2} className="px-4 py-3 text-gray-700">Total</td>
              <td className="px-4 py-3 text-right text-purple-700">{grandPacked}</td>
              <td className="px-4 py-3 text-right text-gray-800">{grandItems}</td>
              <td colSpan={5} />
            </tr>
          </tfoot>
        </table>
        {staffStats.length === 0 && (
          <div className="text-center py-12 text-gray-400">No packing activity found for this period.</div>
        )}
      </div>

      {/* Drilldown */}
      {selected && selectedStaff && (
        <div className="bg-white rounded-xl shadow-sm">
          <div className="flex items-start justify-between px-4 md:px-5 py-4 border-b border-gray-100 gap-2 flex-wrap">
            <p className="font-semibold text-gray-800">
              📦 {selectedStaff.name}'s Packed Orders
              <span className="text-gray-400 font-normal text-sm ml-2">({drillOrders.length})</span>
            </p>
            <ActionBar
              onPrint={() => printReport(`${selectedStaff.name} — Packed Orders`, DRILL_HEADERS, getDrillRows())}
              onExport={() => exportXlsx(getDrillRows(), `${selectedStaff.name.replace(/\s+/g, "_")}_packing`, DRILL_HEADERS)}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3 text-left">Packed At</th>
                  <th className="px-4 py-3 text-left">Order</th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-right">Line Items</th>
                  <th className="px-4 py-3 text-right">Total Qty</th>
                  <th className="px-4 py-3 text-center">Order Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {drillOrders.map(o => (
                  <tr key={o.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{o.packedAt ? fmtDate(o.packedAt) : "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-blue-700">{o.invoiceNumber || o.id}</td>
                    <td className="px-4 py-3 text-gray-800">{o.customerName}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{o.items.length}</td>
                    <td className="px-4 py-3 text-right font-medium text-purple-600">
                      {o.items.reduce((s, i) => s + i.quantity, 0)}
                    </td>
                    <td className="px-4 py-3 text-center text-xs text-gray-400">{fmtDate(o.createdAt)}</td>
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