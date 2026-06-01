import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, query, orderBy, where } from "firebase/firestore";
import { db } from "../firebase/config";
import { StaffMember } from "./Staff";
import { AttendanceRecord, AttendanceStatus } from "./StaffAttendance";
import * as XLSX from "xlsx";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";

// ── Types ────────────────────────────────────────────────────────
type ReportTab = "daily_summary" | "by_staff" | "monthly_calendar";

// ── Helpers ──────────────────────────────────────────────────────
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
function thisMonthRange() {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
  };
}

const STATUS_COLORS: Record<AttendanceStatus, string> = {
  present:  "#10b981",
  absent:   "#ef4444",
  half_day: "#f59e0b",
  leave:    "#3b82f6",
};
const STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: "Present", absent: "Absent", half_day: "Half Day", leave: "Leave",
};

function exportXlsx(rows: (string | number)[][], filename: string, headers: string[]) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Attendance");
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

function printReport(title: string, headers: string[], rows: (string | number)[][], subtitle?: string) {
  const tableRows = rows.map(r => `<tr>${r.map(c => `<td>${c ?? "—"}</td>`).join("")}</tr>`).join("");
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
      <p class="sub">${subtitle ?? ""} · Printed ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" } as any)}</p>
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

function SCard({ label, value, sub, color = "blue" }: { label: string; value: string | number; sub?: string; color?: string }) {
  const borders: Record<string, string> = {
    blue: "border-blue-400", green: "border-green-400", orange: "border-orange-400",
    red: "border-red-400", yellow: "border-yellow-400",
  };
  return (
    <div className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${borders[color] ?? borders.blue}`}>
      <p className="text-xs text-gray-400 font-medium mb-1 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-800">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────
export default function StaffAttendanceReports() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ReportTab>("daily_summary");
  const [filterDept, setFilterDept] = useState("All");
  const [filterStaff, setFilterStaff] = useState("All");
  const { from: defFrom, to: defTo } = thisMonthRange();
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);

  const departments = ["All", ...Array.from(new Set(staff.map(s => s.department))).sort()];

  useEffect(() => {
    Promise.all([
      getDocs(query(collection(db, "staff"), orderBy("name"))),
      getDocs(query(collection(db, "attendance"), orderBy("date", "desc"))),
    ]).then(([staffSnap, attSnap]) => {
      setStaff(staffSnap.docs.map(d => ({ id: d.id, ...d.data() } as StaffMember)));
      setRecords(attSnap.docs.map(d => ({ id: d.id, ...d.data() } as AttendanceRecord)));
      setLoading(false);
    });
  }, []);

  // Date-filtered records
  const filtered = useMemo(() => {
    const f = new Date(from); f.setHours(0, 0, 0, 0);
    const t = new Date(to);   t.setHours(23, 59, 59, 999);
    return records.filter(r => {
      const d = new Date(r.date);
      const inRange = d >= f && d <= t;
      const inDept = filterDept === "All" || r.department === filterDept;
      const inStaff = filterStaff === "All" || r.staffId === filterStaff;
      return inRange && inDept && inStaff;
    });
  }, [records, from, to, filterDept, filterStaff]);

  // Summary stats
  const totalPresent  = filtered.filter(r => r.status === "present").length;
  const totalAbsent   = filtered.filter(r => r.status === "absent").length;
  const totalHalfDay  = filtered.filter(r => r.status === "half_day").length;
  const totalLeave    = filtered.filter(r => r.status === "leave").length;
  const attendancePct = filtered.length > 0
    ? Math.round(((totalPresent + totalHalfDay * 0.5) / filtered.length) * 100)
    : 0;

  // ── Tab: Daily Summary ───────────────────────────────────────
  const dailySummary = useMemo(() => {
    const map: Record<string, { present: number; absent: number; half_day: number; leave: number; total: number }> = {};
    filtered.forEach(r => {
      if (!map[r.date]) map[r.date] = { present: 0, absent: 0, half_day: 0, leave: 0, total: 0 };
      map[r.date][r.status]++;
      map[r.date].total++;
    });
    return Object.entries(map)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, v]) => ({ date, ...v }));
  }, [filtered]);

  // ── Tab: By Staff ────────────────────────────────────────────
  const byStaff = useMemo(() => {
    const map: Record<string, { name: string; dept: string; present: number; absent: number; half_day: number; leave: number; total: number }> = {};
    filtered.forEach(r => {
      if (!map[r.staffId]) map[r.staffId] = { name: r.staffName, dept: r.department, present: 0, absent: 0, half_day: 0, leave: 0, total: 0 };
      map[r.staffId][r.status]++;
      map[r.staffId].total++;
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  // ── Tab: Monthly Calendar (single staff) ────────────────────
  const calendarData = useMemo(() => {
    if (filterStaff === "All") return {};
    const map: Record<string, AttendanceStatus> = {};
    filtered.forEach(r => { map[r.date] = r.status; });
    return map;
  }, [filtered, filterStaff]);

  const calendarDays = useMemo(() => {
    const days: string[] = [];
    const f = new Date(from);
    const t = new Date(to);
    for (let d = new Date(f); d <= t; d.setDate(d.getDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    return days;
  }, [from, to]);

  const tabs: { key: ReportTab; label: string; icon: string }[] = [
    { key: "daily_summary",    label: "Daily Summary",      icon: "📅" },
    { key: "by_staff",         label: "By Staff",           icon: "👤" },
    { key: "monthly_calendar", label: "Monthly Calendar",   icon: "🗓️" },
  ];

  if (loading) return <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Staff Attendance Reports</h1>
        <p className="text-sm text-gray-500 mt-0.5">Track and analyse staff attendance records</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Department</label>
          <select value={filterDept} onChange={e => setFilterDept(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
            {departments.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Staff</label>
          <select value={filterStaff} onChange={e => setFilterStaff(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
            <option value="All">All Staff</option>
            {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {/* Quick presets */}
        <div className="flex gap-1 flex-wrap items-end">
          {[
            { label: "This Month", fn() { const r = thisMonthRange(); setFrom(r.from); setTo(r.to); } },
            { label: "Last Month", fn() {
              const now = new Date(); const m = now.getMonth(); const y = now.getFullYear();
              setFrom(new Date(y, m - 1, 1).toISOString().slice(0, 10));
              setTo(new Date(y, m, 0).toISOString().slice(0, 10));
            }},
            { label: "This Year", fn() { setFrom(`${new Date().getFullYear()}-01-01`); setTo(new Date().toISOString().slice(0, 10)); }},
          ].map(p => (
            <button key={p.label} onClick={p.fn}
              className="border border-gray-300 text-gray-500 text-xs px-2 py-1 rounded-lg hover:bg-gray-50">
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <SCard label="Present"      value={totalPresent}  color="green" />
        <SCard label="Absent"       value={totalAbsent}   color="red" />
        <SCard label="Half Day"     value={totalHalfDay}  color="yellow" />
        <SCard label="Leave"        value={totalLeave}    color="blue" />
        <SCard label="Attendance %" value={`${attendancePct}%`} color="orange" sub={`${filtered.length} records`} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 p-1 rounded-xl w-fit">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === t.key ? "bg-white shadow text-gray-800" : "text-gray-500 hover:text-gray-700"
            }`}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* ── Tab: Daily Summary ── */}
      {activeTab === "daily_summary" && (
        <div className="space-y-4">
          {/* Chart */}
          {dailySummary.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-gray-600 mb-3">Daily Attendance (last 30 days)</h3>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={[...dailySummary].reverse().slice(-30)} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={d => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="present"  stackId="a" name="Present"  fill={STATUS_COLORS.present}  />
                  <Bar dataKey="half_day" stackId="a" name="Half Day" fill={STATUS_COLORS.half_day} />
                  <Bar dataKey="leave"    stackId="a" name="Leave"    fill={STATUS_COLORS.leave}    />
                  <Bar dataKey="absent"   stackId="a" name="Absent"   fill={STATUS_COLORS.absent}   />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Table */}
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-700 text-sm">Daily Breakdown</h3>
              <div className="flex gap-2">
                <button onClick={() => printReport("Daily Attendance", ["Date","Present","Absent","Half Day","Leave","Total"],
                  dailySummary.map(r => [fmtDate(r.date), r.present, r.absent, r.half_day, r.leave, r.total]))}
                  className="flex items-center gap-1 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50">
                  🖨️ Print
                </button>
                <button onClick={() => exportXlsx(
                  dailySummary.map(r => [fmtDate(r.date), r.present, r.absent, r.half_day, r.leave, r.total]),
                  "daily-attendance", ["Date","Present","Absent","Half Day","Leave","Total"])}
                  className="flex items-center gap-1 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50">
                  📥 Export
                </button>
              </div>
            </div>
            {dailySummary.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">No records for selected range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      {["Date","Present","Absent","Half Day","Leave","Total","% Present"].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {dailySummary.map(r => (
                      <tr key={r.date} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-700">{fmtDate(r.date)}</td>
                        <td className="px-4 py-3"><span className="bg-green-100 text-green-700 text-xs px-2 py-0.5 rounded-full">{r.present}</span></td>
                        <td className="px-4 py-3"><span className="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full">{r.absent}</span></td>
                        <td className="px-4 py-3"><span className="bg-yellow-100 text-yellow-700 text-xs px-2 py-0.5 rounded-full">{r.half_day}</span></td>
                        <td className="px-4 py-3"><span className="bg-blue-100 text-blue-600 text-xs px-2 py-0.5 rounded-full">{r.leave}</span></td>
                        <td className="px-4 py-3 text-gray-600">{r.total}</td>
                        <td className="px-4 py-3 text-gray-600">
                          {r.total > 0 ? Math.round(((r.present + r.half_day * 0.5) / r.total) * 100) : 0}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab: By Staff ── */}
      {activeTab === "by_staff" && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="font-semibold text-gray-700 text-sm">Staff Attendance Summary</h3>
            <div className="flex gap-2">
              <button onClick={() => printReport("Staff Attendance", ["Name","Department","Present","Absent","Half Day","Leave","Total","% Present"],
                byStaff.map(r => [r.name, r.dept, r.present, r.absent, r.half_day, r.leave, r.total,
                  r.total > 0 ? `${Math.round(((r.present + r.half_day * 0.5) / r.total) * 100)}%` : "0%"]))}
                className="flex items-center gap-1 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50">
                🖨️ Print
              </button>
              <button onClick={() => exportXlsx(
                byStaff.map(r => [r.name, r.dept, r.present, r.absent, r.half_day, r.leave, r.total]),
                "staff-attendance", ["Name","Department","Present","Absent","Half Day","Leave","Total"])}
                className="flex items-center gap-1 border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-50">
                📥 Export
              </button>
            </div>
          </div>
          {byStaff.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">No records for selected range.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    {["Name","Department","Present","Absent","Half Day","Leave","Total","% Present"].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {byStaff.map(r => {
                    const pct = r.total > 0 ? Math.round(((r.present + r.half_day * 0.5) / r.total) * 100) : 0;
                    return (
                      <tr key={r.name} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-800">{r.name}</td>
                        <td className="px-4 py-3"><span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">{r.dept}</span></td>
                        <td className="px-4 py-3"><span className="text-green-700 font-medium">{r.present}</span></td>
                        <td className="px-4 py-3"><span className="text-red-500 font-medium">{r.absent}</span></td>
                        <td className="px-4 py-3"><span className="text-yellow-600 font-medium">{r.half_day}</span></td>
                        <td className="px-4 py-3"><span className="text-blue-600 font-medium">{r.leave}</span></td>
                        <td className="px-4 py-3 text-gray-600">{r.total}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-20 bg-gray-200 rounded-full overflow-hidden">
                              <div className="h-full bg-green-400 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`text-xs font-medium ${pct >= 80 ? "text-green-600" : pct >= 60 ? "text-yellow-600" : "text-red-500"}`}>{pct}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Monthly Calendar ── */}
      {activeTab === "monthly_calendar" && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          {filterStaff === "All" ? (
            <div className="text-center py-12 text-gray-400">
              <p className="text-4xl mb-3">🗓️</p>
              <p className="text-sm">Please select a specific staff member to view their calendar.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-700">
                  {staff.find(s => s.id === filterStaff)?.name} · {fmtDate(from)} – {fmtDate(to)}
                </h3>
                <div className="flex gap-3 text-xs">
                  {(Object.keys(STATUS_LABELS) as AttendanceStatus[]).map(s => (
                    <span key={s} className="flex items-center gap-1">
                      <span className="w-3 h-3 rounded-sm inline-block" style={{ background: STATUS_COLORS[s] }} />
                      {STATUS_LABELS[s]}
                    </span>
                  ))}
                  <span className="flex items-center gap-1">
                    <span className="w-3 h-3 rounded-sm inline-block bg-gray-200" />
                    Not Marked
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-1 text-center text-xs">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d => (
                  <div key={d} className="py-1 font-semibold text-gray-400">{d}</div>
                ))}
                {/* Empty offset for first day */}
                {Array.from({ length: new Date(calendarDays[0]).getDay() }).map((_, i) => (
                  <div key={`empty-${i}`} />
                ))}
                {calendarDays.map(day => {
                  const status = calendarData[day] as AttendanceStatus | undefined;
                  const bg = status ? STATUS_COLORS[status] : "#e5e7eb";
                  const isToday = day === new Date().toISOString().slice(0, 10);
                  return (
                    <div key={day}
                      style={{ backgroundColor: bg }}
                      className={`rounded-lg py-2 text-white font-medium ${isToday ? "ring-2 ring-offset-1 ring-orange-400" : ""}`}
                      title={status ? STATUS_LABELS[status] : "Not marked"}>
                      <div>{new Date(day).getDate()}</div>
                      {status && <div className="text-[9px] opacity-80">{STATUS_LABELS[status].slice(0, 3)}</div>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}