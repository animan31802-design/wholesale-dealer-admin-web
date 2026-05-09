import { useEffect, useState } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  deleteDoc, doc, orderBy, query
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer, Region } from "../types";
import MapPicker from "../components/MapPicker";
import { useAuthStore } from "../store/authStore";

const emptyCustomer = (): Customer => ({
  shopName: "",
  ownerName: "",
  phone: "",
  alternatePhone: "",
  address: "",
  area: "",
  regionId: "",
  regionName: "",
  lat: undefined,
  lng: undefined,
  locationAddress: "",
  gstin: "",
  notes: "",
});

export default function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [form, setForm] = useState<Customer>(emptyCustomer());
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNewRegion, setShowNewRegion] = useState(false);
  const [newRegion, setNewRegion] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const fetchRegions = async (): Promise<Region[]> => {
    const regSnap = await getDocs(query(collection(db, "regions"), orderBy("name")));
    const all = regSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Region));
    // Deduplicate by name (keep first occurrence)
    const seen = new Set<string>();
    return all.filter((r) => {
      const key = r.name.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const fetchAll = async () => {
    const [custSnap, regions] = await Promise.all([
      getDocs(query(collection(db, "customers"), orderBy("shopName"))),
      fetchRegions(),
    ]);
    setCustomers(custSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer)));
    setRegions(regions);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const handleAddRegion = async () => {
    if (!newRegion.trim()) return;
    const exists = regions.find((r) => r.name.toLowerCase() === newRegion.trim().toLowerCase());
    let regionId = exists?.id || "";
    let regionName = exists?.name || newRegion.trim();

    if (!exists) {
      const ref = await addDoc(collection(db, "regions"), {
        name: newRegion.trim(),
        createdAt: new Date().toISOString(),
      });
      regionId = ref.id;
      regionName = newRegion.trim();
      // Don't push to local state — re-fetch to avoid duplicates
    }

    setForm({ ...form, regionId, regionName });
    setNewRegion("");
    setShowNewRegion(false);
    // Re-fetch and deduplicate regions
    setRegions(await fetchRegions());
  };

  const handleRegionSelect = (regionId: string) => {
    if (regionId === "__new__") {
      setShowNewRegion(true);
      return;
    }
    const region = regions.find((r) => r.id === regionId);
    if (region) {
      setForm({ ...form, regionId: region.id!, regionName: region.name });
      setShowNewRegion(false);
    }
  };

  const handleMapConfirm = (lat: number, lng: number, address: string) => {
    setForm({ ...form, lat, lng, locationAddress: address });
    setShowMap(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date().toISOString();
    if (editId) {
      await updateDoc(doc(db, "customers", editId), { ...form });
    } else {
      await addDoc(collection(db, "customers"), { ...form, createdAt: now });
    }
    setForm(emptyCustomer());
    setEditId(null);
    setShowForm(false);
    fetchAll();
  };

  const handleEdit = (customer: Customer) => {
    setForm(customer);
    setEditId(customer.id!);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this customer?")) return;
    await deleteDoc(doc(db, "customers", id));
    fetchAll();
  };

  const filtered = customers.filter((c) => {
    const matchSearch =
      c.shopName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.ownerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      c.phone.includes(searchTerm);
    const matchRegion = filterRegion ? c.regionId === filterRegion : true;
    return matchSearch && matchRegion;
  });

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Customers</h2>
        {isAdmin ? (
          <button
            onClick={() => { setForm(emptyCustomer()); setEditId(null); setShowForm(true); }}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600"
          >
            + Add Customer
          </button>
        ) : (
          <span className="text-xs text-gray-400 bg-gray-100 px-3 py-2 rounded-lg">View Only</span>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by name, owner, phone..."
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-orange-300"
        />
        <select
          value={filterRegion}
          onChange={(e) => setFilterRegion(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
        >
          <option value="">All Regions</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>

      {/* Table */}
      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-5 py-4">Shop Name</th>
                <th className="px-5 py-4">Owner</th>
                <th className="px-5 py-4">Phone</th>
                <th className="px-5 py-4">Region</th>
                <th className="px-5 py-4">Area</th>
                <th className="px-5 py-4">Location</th>
                {isAdmin && <th className="px-5 py-4">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((customer) => (
                <tr key={customer.id} className="hover:bg-gray-50">
                  <td className="px-5 py-4 font-medium text-gray-800">{customer.shopName}</td>
                  <td className="px-5 py-4 text-gray-700">{customer.ownerName}</td>
                  <td className="px-5 py-4 text-gray-600">{customer.phone}</td>
                  <td className="px-5 py-4">
                    <span className="bg-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full font-medium">
                      {customer.regionName || "—"}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-gray-600">{customer.area}</td>
                  <td className="px-5 py-4">
                    {customer.lat ? (
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${customer.lat}&mlon=${customer.lng}&zoom=17`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-500 hover:underline text-xs flex items-center gap-1"
                      >
                        📍 View Map
                      </a>
                    ) : (
                      <span className="text-gray-400 text-xs">No location</span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="px-5 py-4 flex gap-2">
                      <button onClick={() => handleEdit(customer)} className="text-blue-500 hover:underline text-xs">Edit</button>
                      <button onClick={() => handleDelete(customer.id!)} className="text-red-500 hover:underline text-xs">Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No customers found.</div>}
        </div>
      )}

      {/* Customer Form Modal */}
      {showForm && isAdmin && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-2xl w-full max-w-xl shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editId ? "Edit Customer" : "Add New Customer"}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-6">

              {/* ── SHOP INFO ── */}
              <Section title="Shop Information">
                <Field label="Shop Name *">
                  <input value={form.shopName}
                    onChange={(e) => setForm({ ...form, shopName: e.target.value })}
                    required placeholder="e.g. Sri Murugan Stores"
                    className={inputCls} />
                </Field>
                <Field label="Owner Name *">
                  <input value={form.ownerName}
                    onChange={(e) => setForm({ ...form, ownerName: e.target.value })}
                    required placeholder="e.g. Ravi Kumar"
                    className={inputCls} />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Phone *">
                    <input value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      required placeholder="9876543210"
                      className={inputCls} />
                  </Field>
                  <Field label="Alternate Phone">
                    <input value={form.alternatePhone || ""}
                      onChange={(e) => setForm({ ...form, alternatePhone: e.target.value })}
                      placeholder="Optional"
                      className={inputCls} />
                  </Field>
                </div>
                <Field label="GSTIN (Optional)">
                  <input value={form.gstin || ""}
                    onChange={(e) => setForm({ ...form, gstin: e.target.value })}
                    placeholder="e.g. 33AAAAA0000A1Z5"
                    className={inputCls} />
                </Field>
              </Section>

              {/* ── REGION & AREA ── */}
              <Section title="Region & Area">
                <Field label="Region *">
                  <select
                    value={showNewRegion ? "__new__" : form.regionId}
                    onChange={(e) => handleRegionSelect(e.target.value)}
                    required={!showNewRegion}
                    className={inputCls}
                  >
                    <option value="">-- Select Region --</option>
                    {regions.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                    <option value="__new__">+ Create New Region</option>
                  </select>
                  {showNewRegion && (
                    <div className="flex gap-2 mt-2">
                      <input value={newRegion}
                        onChange={(e) => setNewRegion(e.target.value)}
                        placeholder="New region name (e.g. Anna Nagar)"
                        className={inputCls} />
                      <button type="button" onClick={handleAddRegion}
                        className="bg-orange-500 text-white px-3 py-2 rounded-lg text-sm whitespace-nowrap">Add</button>
                      <button type="button" onClick={() => setShowNewRegion(false)}
                        className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm">✕</button>
                    </div>
                  )}
                  {form.regionName && !showNewRegion && (
                    <p className="text-xs text-orange-500 mt-1">📍 Region: {form.regionName}</p>
                  )}
                </Field>

                <Field label={form.lat ? "Area / Locality (Optional — location set via map)" : "Area / Locality *"}>
                  <input value={form.area}
                    onChange={(e) => setForm({ ...form, area: e.target.value })}
                    required={!form.lat}
                    placeholder="e.g. 2nd Street, Anna Nagar"
                    className={inputCls} />
                </Field>

                <Field label={form.lat ? "Full Address (Optional — location set via map)" : "Full Address *"}>
                  <textarea value={form.address}
                    onChange={(e) => setForm({ ...form, address: e.target.value })}
                    required={!form.lat}
                    placeholder="Door no, Street, City, Pincode"
                    rows={2}
                    className={inputCls} />
                  {!form.lat && (
                    <p className="text-xs text-gray-400 mt-1">
                      💡 You can skip this by picking location on map below
                    </p>
                  )}
                </Field>
              </Section>

              {/* ── LOCATION ── */}
              <Section title="Shop Location on Map">
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    {form.lat && form.lng ? (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                        <p className="text-sm text-green-700 font-medium">✅ Location Set</p>
                        <p className="text-xs text-green-600 mt-1 break-words">{form.locationAddress}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          {form.lat?.toFixed(6)}, {form.lng?.toFixed(6)}
                        </p>
                      </div>
                    ) : (
                      <div className="bg-gray-50 border border-dashed border-gray-300 rounded-lg p-3">
                        <p className="text-sm text-gray-500">No location picked yet</p>
                        <p className="text-xs text-gray-400 mt-1">Click below to open map</p>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowMap(true)}
                    className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600 whitespace-nowrap"
                  >
                    🗺️ {form.lat ? "Change Location" : "Pick Location"}
                  </button>
                </div>
              </Section>

              {/* ── NOTES ── */}
              <Section title="Additional Info">
                <Field label="Notes (Optional)">
                  <textarea value={form.notes || ""}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="Any special instructions or notes about this shop"
                    rows={2}
                    className={inputCls} />
                </Field>
              </Section>

              {/* Submit */}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 border border-gray-300 text-gray-600 py-3 rounded-xl text-sm hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit"
                  className="flex-1 bg-orange-500 text-white py-3 rounded-xl text-sm font-semibold hover:bg-orange-600">
                  {editId ? "Update Customer" : "Add Customer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Map Picker */}
      {showMap && (
        <MapPicker
          initialLat={form.lat}
          initialLng={form.lng}
          onConfirm={handleMapConfirm}
          onClose={() => setShowMap(false)}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-orange-500 uppercase tracking-wide mb-3 pb-1 border-b border-orange-100">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputCls = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300";
