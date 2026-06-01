import { useEffect, useState } from "react";
import {
  collection, getDocs, setDoc, doc, query, orderBy,
  where, getDoc,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { StaffMember } from "./Staff";

// ── Types ────────────────────────────────────────────────────────
export type AttendanceStatus = "present" | "absent" | "half_day" | "leave";

export interface AttendanceRecord {
  id?: string; // staffId_YYYY-MM-DD
  staffId: string;
  staffName: string;
  department: string;
  date: string; // YYYY-MM-DD
  status: AttendanceStatus;
  note?: string;
  markedAt: string;
}

const STATUS_CONFIG: Record<AttendanceStatus, { label: string; color: string; bg: string }> = {
  present:  { label: "Present",  color: "text-green-700",  bg: "bg-green-100" },
  absent:   { label: "Absent",   color: "text-red-600",    bg: "bg-red-100" },
  half_day: { label: "Half Day", color: "text-yellow-700", bg: "bg-yellow-100" },
  leave:    { label: "Leave",    color: "text-blue-600",   bg: "bg-blue-100" },
};

function todayISO() { return new Date().toISOString().slice(0, 10); }

// ── Component ────────────────────────────────────────────────────
export default function StaffAttendance() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [attendance, setAttendance] = useState<Record<string, AttendanceStatus>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [filterDept, setFilterDept] = useState("All");

  const departments = ["All", ...Array.from(new Set(staff.map(s => s.department))).sort()];

  // Load active staff
  useEffect(() => {
    getDocs(query(collection(db, "staff"), orderBy("name")))
      .then(snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() } as StaffMember));
        setStaff(all.filter(s => s.isActive));
      });
  }, []);

  // Load existing attendance for selected date
  useEffect(() => {
    if (!date) return;
    setLoading(true);
    getDocs(query(collection(db, "attendance"), where("date", "==", date)))
      .then(snap => {
        const map: Record<string, AttendanceStatus> = {};
        const noteMap: Record<string, string> = {};
        snap.docs.forEach(d => {
          const r = d.data() as AttendanceRecord;
          map[r.staffId] = r.status;
          if (r.note) noteMap[r.staffId] = r.note;
        });
        setAttendance(map);
        setNotes(noteMap);
        // If records already exist for this date, treat as already saved
        setSaved(snap.docs.length > 0);
        setLoading(false);
      });
  }, [date]);

  const setStatus = (staffId: string, status: AttendanceStatus) => {
    setAttendance(prev => ({ ...prev, [staffId]: status }));
    setSaved(false);
  };

  const markAll = (status: AttendanceStatus) => {
    const newMap: Record<string, AttendanceStatus> = {};
    visibleStaff.forEach(s => { newMap[s.id!] = status; });
    setAttendance(prev => ({ ...prev, ...newMap }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    const batch: Promise<void>[] = [];
    staff.forEach(s => {
      const status = attendance[s.id!];
      if (!status) return; // skip unmarked
      const id = `${s.id}_${date}`;
      const record: AttendanceRecord = {
        staffId: s.id!,
        staffName: s.name,
        department: s.department,
        date,
        status,
        note: notes[s.id!] ?? "",
        markedAt: new Date().toISOString(),
      };
      batch.push(setDoc(doc(db, "attendance", id), record));
    });
    await Promise.all(batch);
    setSaving(false);
    setSaved(true);
  };

  const visibleStaff = filterDept === "All" ? staff : staff.filter(s => s.department === filterDept);
  const markedCount = visibleStaff.filter(s => attendance[s.id!]).length;
  const presentCount = visibleStaff.filter(s => attendance[s.id!] === "present").length;
  const absentCount = visibleStaff.filter(s => attendance[s.id!] === "absent").length;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Attendance</h1>
          <p className="text-sm text-gray-500 mt-0.5">Mark daily attendance for all staff</p>
        </div>
        <button onClick={handleSave} disabled={saving || markedCount === 0}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50 transition-colors">
          {saving ? "Saving…" : saved ? "✓ Saved" : "💾 Save Attendance"}
        </button>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-center gap-3">
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1">Department</label>
          <select value={filterDept} onChange={e => setFilterDept(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
            {departments.map(d => <option key={d}>{d}</option>)}
          </select>
        </div>
        <div className="ml-auto flex gap-2 items-end pb-0.5">
          <span className="text-xs text-gray-400">Mark all visible:</span>
          {(["present", "absent", "half_day", "leave"] as AttendanceStatus[]).map(s => (
            <button key={s} onClick={() => markAll(s)}
              className={`text-xs px-2 py-1 rounded-full font-medium border ${STATUS_CONFIG[s].bg} ${STATUS_CONFIG[s].color} border-current`}>
              {STATUS_CONFIG[s].label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary bar */}
      {markedCount > 0 && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: "Present", value: presentCount, color: "border-green-400" },
            { label: "Absent",  value: absentCount,  color: "border-red-400" },
            { label: "Marked",  value: markedCount,  color: "border-orange-400" },
          ].map(c => (
            <div key={c.label} className={`bg-white rounded-xl shadow-sm p-4 border-l-4 ${c.color}`}>
              <p className="text-xs text-gray-400 uppercase font-medium">{c.label}</p>
              <p className="text-2xl font-bold text-gray-800">{c.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Staff list */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : visibleStaff.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No active staff found.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visibleStaff.map(s => {
              const status = attendance[s.id!] as AttendanceStatus | undefined;
              const cfg = status ? STATUS_CONFIG[status] : null;
              return (
                <div key={s.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
                  {/* Staff info */}
                  <div className="flex-1 min-w-[140px]">
                    <p className="font-medium text-gray-800 text-sm">{s.name}</p>
                    <p className="text-xs text-gray-400">{s.role} · <span className="text-blue-500">{s.department}</span></p>
                  </div>

                  {/* Status buttons */}
                  <div className="flex gap-1.5 flex-wrap">
                    {(["present", "absent", "half_day", "leave"] as AttendanceStatus[]).map(st => {
                      const c = STATUS_CONFIG[st];
                      const active = status === st;
                      return (
                        <button key={st} onClick={() => setStatus(s.id!, st)}
                          className={`text-xs px-3 py-1.5 rounded-lg font-medium border transition-all ${
                            active ? `${c.bg} ${c.color} border-current ring-2 ring-offset-1 ring-current` : "border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600"
                          }`}>
                          {c.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Note input — shows only when something is marked */}
                  {status && (
                    <input
                      value={notes[s.id!] ?? ""}
                      onChange={e => setNotes(prev => ({ ...prev, [s.id!]: e.target.value }))}
                      placeholder="Note (optional)"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-orange-300" />
                  )}

                  {/* Status badge */}
                  {cfg && (
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.bg} ${cfg.color} ml-auto`}>
                      {cfg.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating save hint */}
      {markedCount > 0 && !saved && (
        <div className="fixed bottom-6 right-6 bg-orange-500 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
          {markedCount} staff marked · <button onClick={handleSave} disabled={saving} className="underline font-medium">{saving ? "Saving…" : "Save now"}</button>
        </div>
      )}
    </div>
  );
}