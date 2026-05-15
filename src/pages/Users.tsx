import { useEffect, useState, useMemo } from "react";
import { collection, getDocs, setDoc, doc, updateDoc, orderBy, query } from "firebase/firestore";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { db } from "../firebase/config";
import { AppUser, UserRole, Region } from "../types";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";

export default function Users() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showRegionModal, setShowRegionModal] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "", role: "field_agent" as UserRole });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [editUser, setEditUser] = useState<AppUser | null>(null);
  const [editForm, setEditForm] = useState({ name: "", phone: "", role: "field_agent" as UserRole });

  // ── Tamil-aware search ────────────────────────────────────────────────────
  // Searches name, email, phone. Works with English typing for Tamil names.
  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults } =
    useTamilSearch(users as unknown as Record<string, unknown>[], ["name", "email", "phone"]);

  const fetchAll = async () => {
    const [usersSnap, regionsSnap] = await Promise.all([
      getDocs(query(collection(db, "users"), orderBy("name"))),
      getDocs(query(collection(db, "regions"), orderBy("name"))),
    ]);
    setUsers(usersSnap.docs.map((d) => d.data() as AppUser));
    const allRegions = regionsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Region));
    const seen = new Set<string>();
    setRegions(allRegions.filter((r) => {
      const key = r.name.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const handleToggleActive = async (u: AppUser) => {
    const newStatus = u.isActive === false ? true : false;
    if (!confirm(`${newStatus ? "Activate" : "Deactivate"} ${u.name}?`)) return;
    await updateDoc(doc(db, "users", u.uid), { isActive: newStatus });
    fetchAll();
  };

  const handleEditUser = (user: AppUser) => {
    setEditUser(user);
    setEditForm({ name: user.name, phone: user.phone || "", role: user.role });
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    setSubmitting(true);
    try {
      await updateDoc(doc(db, "users", editUser.uid), {
        name: editForm.name,
        phone: editForm.phone,
        role: editForm.role,
      });
      setEditUser(null);
      fetchAll();
    } catch (err: any) {
      alert(err.message || "Failed to update user.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const secondaryApp = initializeApp(
        {
          apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
          authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
          projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        },
        `secondary-${Date.now()}`
      );
      const secondaryAuth = getAuth(secondaryApp);
      const result = await createUserWithEmailAndPassword(secondaryAuth, form.email, form.password);
      const newUser: AppUser = {
        uid: result.user.uid,
        name: form.name,
        email: form.email,
        role: form.role,
        phone: form.phone,
        assignedRegions: [],
        createdAt: new Date().toISOString(),
      };
      await setDoc(doc(db, "users", result.user.uid), newUser);
      await secondaryAuth.signOut();
      setForm({ name: "", email: "", password: "", phone: "", role: "field_agent" });
      setShowForm(false);
      fetchAll();
    } catch (err: any) {
      setError(err.message || "Failed to create user.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegionToggle = async (regionId: string) => {
    if (!selectedAgent) return;
    const current = selectedAgent.assignedRegions || [];
    const updated = current.includes(regionId)
      ? current.filter((r) => r !== regionId)
      : [...current, regionId];
    await updateDoc(doc(db, "users", selectedAgent.uid), { assignedRegions: updated });
    setSelectedAgent({ ...selectedAgent, assignedRegions: updated });
    setUsers((prev) => prev.map((u) => u.uid === selectedAgent.uid ? { ...u, assignedRegions: updated } : u));
  };

  const getRegionTags = (user: AppUser) => {
    if (!user.assignedRegions?.length) return null;
    return user.assignedRegions.map((id) => regions.find((r) => r.id === id)?.name).filter(Boolean);
  };

  const roleColor: Record<string, string> = {
    admin: "bg-orange-100 text-orange-700",
    field_agent: "bg-blue-100 text-blue-700",
    delivery: "bg-green-100 text-green-700",
    packing_staff: "bg-purple-100 text-purple-700",
  };

  const searchedUsers = searchResults as unknown as AppUser[];

  const fieldAgents    = searchedUsers.filter((u) => u.role === "field_agent");
  const deliveryAgents = searchedUsers.filter((u) => u.role === "delivery");
  const packingStaff   = searchedUsers.filter((u) => u.role === "packing_staff");
  const admins         = searchedUsers.filter((u) => u.role === "admin");

  // Reusable user group table with optional region column
  const UserTable = ({
    title, userList, showRegions,
  }: { title: string; userList: AppUser[]; showRegions: boolean }) => (
    <div>
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
        {title} ({userList.length})
      </h3>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-left">
            <tr>
              <th className="px-5 py-4">Name</th>
              <th className="px-5 py-4">Email</th>
              <th className="px-5 py-4">Phone</th>
              <th className="px-5 py-4">Status</th>
              {showRegions && <th className="px-5 py-4">Assigned Regions</th>}
              <th className="px-5 py-4">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {userList.map((user) => (
              <tr key={user.uid} className="hover:bg-gray-50">
                <td className="px-5 py-4 font-medium text-gray-800">{user.name}</td>
                <td className="px-5 py-4 text-gray-600">{user.email}</td>
                <td className="px-5 py-4 text-gray-600">{user.phone || "—"}</td>
                <td className="px-5 py-4">
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                    user.isActive === false
                      ? "bg-red-100 text-red-600"
                      : "bg-green-100 text-green-600"
                  }`}>
                    {user.isActive === false ? "Inactive" : "Active"}
                  </span>
                </td>
                {showRegions && (
                  <td className="px-5 py-4">
                    {getRegionTags(user) ? (
                      <div className="flex flex-wrap gap-1">
                        {getRegionTags(user)!.map((name, i) => (
                          <span key={i} className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">
                            {name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs italic">No regions assigned</span>
                    )}
                  </td>
                )}
                <td className="px-5 py-4">
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleEditUser(user)}
                      className="text-xs bg-gray-50 text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-100 border border-gray-200"
                    >
                      ✏️ Edit
                    </button>
                    {showRegions && (
                      <button
                        onClick={() => { setSelectedAgent(user); setShowRegionModal(true); }}
                        className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-lg hover:bg-blue-100"
                      >
                        🗂️ Regions
                      </button>
                    )}
                    <button
                      onClick={() => handleToggleActive(user)}
                      className={`text-xs px-3 py-1 rounded-lg border transition-all ${
                        user.isActive === false
                          ? "bg-green-50 text-green-600 border-green-200 hover:bg-green-100"
                          : "bg-red-50 text-red-500 border-red-200 hover:bg-red-100"
                      }`}
                    >
                      {user.isActive === false ? "Activate" : "Deactivate"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {userList.length === 0 && (
              <tr>
                <td colSpan={showRegions ? 6 : 5} className="text-center py-8 text-gray-400">
                  No {title.toLowerCase()} yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Users</h2>
          <p className="text-sm text-gray-400 mt-0.5">{users.length} users</p>
        </div>
        <button onClick={() => setShowForm(true)}
          className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
          + Add User
        </button>
      </div>

      {/* Search */}
      <div className="mb-6">
        <TamilSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by name, email, phone... (supports Tamil)"
          className="w-72"
        />
      </div>

      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="space-y-8">
          <UserTable title="Field Agents" userList={fieldAgents} showRegions={true} />
          <UserTable title="Delivery Agents" userList={deliveryAgents} showRegions={true} />
          <UserTable title="Packing Staff" userList={packingStaff} showRegions={false} />
          <UserTable title="Admins" userList={admins} showRegions={false} />
        </div>
      )}

      {/* Add User Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-800">Add New User</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              {[
                { label: "Full Name", key: "name", type: "text", placeholder: "e.g. Ravi Kumar" },
                { label: "Email", key: "email", type: "email", placeholder: "ravi@example.com" },
                { label: "Password", key: "password", type: "password", placeholder: "Min 6 characters" },
                { label: "Phone", key: "phone", type: "text", placeholder: "9876543210" },
              ].map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
                  <input type={field.type}
                    value={form[field.key as keyof typeof form] as string}
                    onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                    required placeholder={field.placeholder}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              ))}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="admin">Admin</option>
                  <option value="packing_staff">Packing Staff</option>
                  <option value="field_agent">Field Agent</option>
                  <option value="delivery">Delivery Agent</option>
                </select>
              </div>
              {error && <p className="text-red-500 text-xs">{error}</p>}
              <div className="flex gap-3 mt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={submitting}
                  className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50">
                  {submitting ? "Creating..." : "Create User"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit User Modal */}
      {editUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-800">Edit User</h3>
              <button onClick={() => setEditUser(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="mb-4 bg-gray-50 rounded-lg px-4 py-3">
              <p className="text-xs text-gray-500">Email (cannot be changed)</p>
              <p className="text-sm text-gray-700 font-medium">{editUser.email}</p>
            </div>
            <form onSubmit={handleUpdateUser} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input type="text" value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  required className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input type="text" value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value as UserRole })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="admin">Admin</option>
                  <option value="packing_staff">Packing Staff</option>
                  <option value="field_agent">Field Agent</option>
                  <option value="delivery">Delivery Agent</option>
                </select>
              </div>
              <p className="text-xs text-gray-400">⚠️ Password cannot be changed here. User must reset via email.</p>
              <div className="flex gap-3 mt-2">
                <button type="button" onClick={() => setEditUser(null)}
                  className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={submitting}
                  className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50">
                  {submitting ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assign / Manage Regions Modal */}
      {showRegionModal && selectedAgent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold text-gray-800">Manage Regions</h3>
              <button onClick={() => setShowRegionModal(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <p className="text-sm text-gray-500 mb-1">{selectedAgent.role === "delivery" ? "Delivery Agent" : "Agent"}: <strong>{selectedAgent.name}</strong></p>
            {selectedAgent.role === "delivery" && (
              <p className="text-xs text-blue-500 bg-blue-50 px-3 py-1.5 rounded-lg mb-2">
                🚚 Regions are optional for delivery agents. When assigned, their name will be highlighted in the assign modal for matching orders.
              </p>
            )}

            {/* Currently assigned summary */}
            <div className="mb-4">
              {selectedAgent.assignedRegions?.length ? (
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedAgent.assignedRegions.map((rId) => {
                    const region = regions.find((r) => r.id === rId);
                    return region ? (
                      <span
                        key={rId}
                        onClick={() => handleRegionToggle(rId)}
                        className="bg-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full cursor-pointer hover:bg-red-100 hover:text-red-600 transition-all"
                        title="Click to remove"
                      >
                        {region.name} ✕
                      </span>
                    ) : null;
                  })}
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic mt-1">No regions assigned yet</p>
              )}
            </div>

            <p className="text-xs text-gray-500 mb-2 font-medium">Toggle to assign / remove:</p>

            {regions.length === 0 ? (
              <p className="text-gray-400 text-sm text-center py-4">
                No regions yet. Add regions while creating customers first.
              </p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {regions.map((region) => {
                  const isAssigned = selectedAgent.assignedRegions?.includes(region.id!) || false;
                  return (
                    <div
                      key={region.id}
                      onClick={() => handleRegionToggle(region.id!)}
                      className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-all ${
                        isAssigned
                          ? "border-orange-400 bg-orange-50"
                          : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      <span className="text-sm font-medium text-gray-700">{region.name}</span>
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${
                        isAssigned ? "bg-orange-500 border-orange-500" : "border-gray-300"
                      }`}>
                        {isAssigned && <span className="text-white text-xs">✓</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button
              onClick={() => setShowRegionModal(false)}
              className="w-full mt-5 bg-orange-500 text-white py-2 rounded-xl text-sm font-semibold hover:bg-orange-600"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}