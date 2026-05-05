import { useEffect, useState } from "react";
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, orderBy, query } from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer } from "../types";

const emptyCustomer: Customer = { shopName: "", ownerName: "", phone: "", address: "", area: "" };

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [form, setForm] = useState<Customer>(emptyCustomer);
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchCustomers = async () => {
    const snap = await getDocs(query(collection(db, "customers"), orderBy("shopName")));
    setCustomers(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer)));
    setLoading(false);
  };

  useEffect(() => { fetchCustomers(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editId) {
      await updateDoc(doc(db, "customers", editId), { ...form });
    } else {
      await addDoc(collection(db, "customers"), { ...form, createdAt: new Date().toISOString() });
    }
    setForm(emptyCustomer);
    setEditId(null);
    setShowForm(false);
    fetchCustomers();
  };

  const handleEdit = (customer: Customer) => {
    setForm(customer);
    setEditId(customer.id!);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this customer?")) return;
    await deleteDoc(doc(db, "customers", id));
    fetchCustomers();
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Customers</h2>
        <button
          onClick={() => { setForm(emptyCustomer); setEditId(null); setShowForm(true); }}
          className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600"
        >
          + Add Customer
        </button>
      </div>

      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-6 py-4">Shop Name</th>
                <th className="px-6 py-4">Owner</th>
                <th className="px-6 py-4">Phone</th>
                <th className="px-6 py-4">Area</th>
                <th className="px-6 py-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {customers.map((customer) => (
                <tr key={customer.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 font-medium text-gray-800">{customer.shopName}</td>
                  <td className="px-6 py-4 text-gray-700">{customer.ownerName}</td>
                  <td className="px-6 py-4 text-gray-600">{customer.phone}</td>
                  <td className="px-6 py-4 text-gray-600">{customer.area}</td>
                  <td className="px-6 py-4 flex gap-2">
                    <button onClick={() => handleEdit(customer)} className="text-blue-500 hover:underline text-xs">Edit</button>
                    <button onClick={() => handleDelete(customer.id!)} className="text-red-500 hover:underline text-xs">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {customers.length === 0 && <div className="text-center py-12 text-gray-400">No customers yet.</div>}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">{editId ? "Edit Customer" : "Add Customer"}</h3>
            <form onSubmit={handleSubmit} className="space-y-4">
              {[
                { label: "Shop Name", key: "shopName", placeholder: "e.g. Sri Murugan Stores" },
                { label: "Owner Name", key: "ownerName", placeholder: "e.g. Ravi Kumar" },
                { label: "Phone", key: "phone", placeholder: "9876543210" },
                { label: "Area", key: "area", placeholder: "e.g. Anna Nagar" },
                { label: "Address", key: "address", placeholder: "Full address" },
              ].map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
                  <input
                    value={form[field.key as keyof Customer] as string}
                    onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                    required
                    placeholder={field.placeholder}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              ))}
              <div className="flex gap-3 mt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit"
                  className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600">
                  {editId ? "Update" : "Add Customer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
