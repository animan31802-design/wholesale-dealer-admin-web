import { useEffect, useState } from "react";
import {
  collection, getDocs, addDoc, updateDoc, doc, orderBy, query,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { useModalKeyboard } from "../hooks/useModalKeyboard";

// ── Types ────────────────────────────────────────────────────────
export interface StaffMember {
  id?: string;
  name: string;
  phone: string;
  role: string;
  department: string;
  joinedAt: string;
  isActive: boolean;
  notes?: string;
  createdAt: string;
}

const DEPARTMENTS = ["Production", "Packing", "Delivery", "Office", "Security", "Cleaning", "Other"];
const ROLES = ["Worker", "Supervisor", "Helper", "Driver", "Guard", "Cleaner", "Other"];

const emptyForm = {
  name: "", phone: "", role: "Worker", department: "Production",
  joinedAt: new Date().toISOString().slice(0, 10), notes: "",
};

// ── Component ────────────────────────────────────────────────────
export default function Staff() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editStaff, setEditStaff] = useState<StaffMember | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filterDept, setFilterDept] = useState("All");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "inactive">("active");

  useModalKeyboard({
    onClose: () => { setShowForm(false); setEditStaff(null); },
    confirmOnEnter: false,
  });

  const fetchStaff = async () => {
    const snap = await getDocs(query(collection(db, "staff"), orderBy("name")));
    setStaff(snap.docs.map((d) => ({ id: d.id, ...d.data() } as StaffMember)));
    setLoading(false);
  };

  useEffect(() => { fetchStaff(); }, []);

  const openAdd = () => {
    setEditStaff(null);
    setForm({ ...emptyForm });
    setError("");
    setShowForm(true);
  };

  const openEdit = (s: StaffMember) => {
    setEditStaff(s);
    setForm({
      name: s.name, phone: s.phone, role: s.role,
      department: s.department,
      joinedAt: s.joinedAt?.slice(0, 10) ?? "",
      notes: s.notes ?? "",
    });
    setError("");
    setShowForm(true);
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) { setError("Name is required."); return; }
    if (!form.phone.trim()) { setError("Phone is required."); return; }
    setSubmitting(true);
    try {
      if (editStaff?.id) {
        await updateDoc(doc(db, "staff", editStaff.id), {
          name: form.name.trim(),
          phone: form.phone.trim(),
          role: form.role,
          department: form.department,
          joinedAt: form.joinedAt,
          notes: form.notes.trim(),
        });
      } else {
        const payload: StaffMember = {
          name: form.name.trim(),
          phone: form.phone.trim(),
          role: form.role,
          department: form.department,
          joinedAt: form.joinedAt,
          notes: form.notes.trim(),
          isActive: true,
          createdAt: new Date().toISOString(),
        };
        await addDoc(collection(db, "staff"), payload);
      }
      setShowForm(false);
      setEditStaff(null);
      fetchStaff();
    } catch (e: any) {
      setError(e.message ?? "Something went wrong.");
    }
    setSubmitting(false);
  };

  const toggleActive = async (s: StaffMember) => {
    if (!s.id) return;
    if (!confirm(`${s.isActive ? "Deactivate" : "Reactivate"} ${s.name}?`)) return;
    await updateDoc(doc(db, "staff", s.id), { isActive: !s.isActive });
    fetchStaff();
  };

  // Filter
  const visible = staff.filter((s) => {
    const matchSearch = !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.phone.includes(search);
    const matchDept = filterDept === "All" || s.department === filterDept;
    const matchStatus =
      filterStatus === "all" ? true :
      filterStatus === "active" ? s.isActive :
      !s.isActive;
    return matchSearch && matchDept && matchStatus;
  });

  const activeCount = staff.filter(s => s.isActive).length;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Staff</h1>
          <p className="text-sm text-gray-500 mt-0.5">{activeCount} active staff members</p>
        </div>
        <button onClick={openAdd}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          ➕ Add Staff
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap gap-3">
        <input
          type="text" placeholder="Search name or phone…" value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 w-52" />
        <select value={filterDept} onChange={e => setFilterDept(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="All">All Departments</option>
          {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
        </select>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {(["active", "inactive", "all"] as const).map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`px-3 py-2 capitalize ${filterStatus === s ? "bg-orange-500 text-white" : "text-gray-600 hover:bg-gray-50"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Loading…</div>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No staff found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  {["Name", "Phone", "Role", "Department", "Joined", "Status", "Actions"].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map(s => (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-medium text-gray-800">{s.name}</td>
                    <td className="px-4 py-3 text-gray-600">{s.phone}</td>
                    <td className="px-4 py-3 text-gray-600">{s.role}</td>
                    <td className="px-4 py-3">
                      <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full font-medium">{s.department}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {s.joinedAt ? new Date(s.joinedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.isActive ? "bg-green-100 text-green-700" : "bg-red-100 text-red-500"}`}>
                        {s.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button onClick={() => openEdit(s)}
                          className="text-xs border border-gray-300 text-gray-600 px-2 py-1 rounded hover:bg-gray-100">
                          Edit
                        </button>
                        <button onClick={() => toggleActive(s)}
                          className={`text-xs border px-2 py-1 rounded ${s.isActive ? "border-red-300 text-red-500 hover:bg-red-50" : "border-green-300 text-green-600 hover:bg-green-50"}`}>
                          {s.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-800">{editStaff ? "Edit Staff" : "Add Staff"}</h2>
              <button onClick={() => { setShowForm(false); setEditStaff(null); }}
                className="text-gray-400 hover:text-gray-600 text-xl font-bold">×</button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Full Name *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  placeholder="Staff member's name" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Phone *</label>
                <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
                  placeholder="10-digit phone number" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Role</label>
                  <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                    {ROLES.map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Department</label>
                  <select value={form.department} onChange={e => setForm({ ...form, department: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
                    {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Joined Date</label>
                <input type="date" value={form.joinedAt} onChange={e => setForm({ ...form, joinedAt: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase mb-1">Notes (optional)</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 resize-none"
                  placeholder="Any additional info…" />
              </div>
            </div>
            <div className="px-6 pb-5 flex gap-3 justify-end">
              <button onClick={() => { setShowForm(false); setEditStaff(null); }}
                className="border border-gray-300 text-gray-600 px-4 py-2 rounded-lg text-sm hover:bg-gray-50">
                Cancel
              </button>
              <button onClick={handleSubmit} disabled={submitting}
                className="bg-orange-500 hover:bg-orange-600 text-white px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-50">
                {submitting ? "Saving…" : editStaff ? "Save Changes" : "Add Staff"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}