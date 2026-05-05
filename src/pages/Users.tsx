import { useEffect, useState } from "react";
import { collection, getDocs, setDoc, doc, orderBy, query } from "firebase/firestore";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../firebase/config";
import { AppUser, UserRole } from "../types";

export default function Users() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "", role: "field_agent" as UserRole });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fetchUsers = async () => {
    const snap = await getDocs(query(collection(db, "users"), orderBy("name")));
    setUsers(snap.docs.map((d) => d.data() as AppUser));
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const result = await createUserWithEmailAndPassword(auth, form.email, form.password);
      const newUser: AppUser = {
        uid: result.user.uid,
        name: form.name,
        email: form.email,
        role: form.role,
        phone: form.phone,
        createdAt: new Date().toISOString(),
      };
      await setDoc(doc(db, "users", result.user.uid), newUser);
      setForm({ name: "", email: "", password: "", phone: "", role: "field_agent" });
      setShowForm(false);
      fetchUsers();
    } catch (err: any) {
      setError(err.message || "Failed to create user.");
    } finally {
      setSubmitting(false);
    }
  };

  const roleColor: Record<string, string> = {
    admin: "bg-orange-100 text-orange-700",
    field_agent: "bg-blue-100 text-blue-700",
    delivery: "bg-green-100 text-green-700",
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Users</h2>
        <button
          onClick={() => setShowForm(true)}
          className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600"
        >
          + Add User
        </button>
      </div>

      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-6 py-4">Name</th>
                <th className="px-6 py-4">Email</th>
                <th className="px-6 py-4">Phone</th>
                <th className="px-6 py-4">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((user) => (
                <tr key={user.uid} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-800">{user.name}</td>
                  <td className="px-6 py-4 text-gray-600">{user.email}</td>
                  <td className="px-6 py-4 text-gray-600">{user.phone || "-"}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${roleColor[user.role]}`}>
                      {user.role.replace("_", " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {users.length === 0 && <div className="text-center py-12 text-gray-400">No users yet.</div>}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Add New User</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              {[
                { label: "Full Name", key: "name", type: "text", placeholder: "e.g. Ravi Kumar" },
                { label: "Email", key: "email", type: "email", placeholder: "ravi@example.com" },
                { label: "Password", key: "password", type: "password", placeholder: "Min 6 characters" },
                { label: "Phone", key: "phone", type: "text", placeholder: "9876543210" },
              ].map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
                  <input
                    type={field.type}
                    value={form[field.key as keyof typeof form] as string}
                    onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                    required
                    placeholder={field.placeholder}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              ))}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="admin">Admin</option>
                  <option value="field_agent">Field Agent</option>
                  <option value="delivery">Delivery Person</option>
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
    </div>
  );
}
