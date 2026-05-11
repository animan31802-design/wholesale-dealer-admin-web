import { useEffect, useState } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  deleteDoc, doc, orderBy, query
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer, Region } from "../types";
import { LedgerEntry } from "../types/ledger";
import Pagination from "../components/Pagination";
import { Order } from "../types";
import { getLedger, calcBalance, recordManualPayment, recordAdjustment } from "../utils/ledger";
import MapPicker from "../components/MapPicker";
import { useAuthStore } from "../store/authStore";

const emptyCustomer = (): Customer => ({
  shopName: "", ownerName: "", phone: "", alternatePhone: "",
  address: "", area: "", regionId: "", regionName: "",
  lat: undefined, lng: undefined, locationAddress: "",
  gstin: "", notes: "", outstandingDue: 0,
});

const ENTRY_LABELS: Record<string, string> = {
  order_placed:      "Order Placed",
  delivery_payment:  "Payment at Delivery",
  manual_payment:    "Manual Payment",
  adjustment:        "Adjustment",
  order_cancelled:   "Order Cancelled",
};
const ENTRY_COLORS: Record<string, string> = {
  order_placed:     "text-red-600",
  order_cancelled:  "text-green-600",
  delivery_payment: "text-green-600",
  manual_payment:   "text-green-600",
  adjustment:       "text-gray-600",
};

export default function Customers() {
  const [customers, setCustomers]     = useState<Customer[]>([]);
  const [regions, setRegions]         = useState<Region[]>([]);
  const [form, setForm]               = useState<Customer>(emptyCustomer());
  const [editId, setEditId]           = useState<string | null>(null);
  const [showForm, setShowForm]       = useState(false);
  const [showMap, setShowMap]         = useState(false);
  const [loading, setLoading]         = useState(true);
  const [showNewRegion, setShowNewRegion] = useState(false);
  const [newRegion, setNewRegion]     = useState("");
  const [searchTerm, setSearchTerm]   = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [ledgerCustomer, setLedgerCustomer] = useState<Customer | null>(null);
  const [page, setPage] = useState(1);
  const PER_PAGE = 15;
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const fetchRegions = async (): Promise<Region[]> => {
    const snap = await getDocs(query(collection(db, "regions"), orderBy("name")));
    const all  = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Region));
    const seen = new Set<string>();
    return all.filter((r) => {
      const k = r.name.toLowerCase().trim();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
  };

  const fetchAll = async () => {
    const [custSnap, regs] = await Promise.all([
      getDocs(query(collection(db, "customers"), orderBy("shopName"))),
      fetchRegions(),
    ]);
    setCustomers(custSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer)));
    setRegions(regs);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const handleAddRegion = async () => {
    if (!newRegion.trim()) return;
    const exists = regions.find((r) => r.name.toLowerCase() === newRegion.trim().toLowerCase());
    let regionId = exists?.id || "";
    let regionName = exists?.name || newRegion.trim();
    if (!exists) {
      const ref = await addDoc(collection(db, "regions"), { name: newRegion.trim(), createdAt: new Date().toISOString() });
      regionId = ref.id; regionName = newRegion.trim();
    }
    setForm({ ...form, regionId, regionName });
    setNewRegion(""); setShowNewRegion(false);
    setRegions(await fetchRegions());
  };

  const handleRegionSelect = (regionId: string) => {
    if (regionId === "__new__") { setShowNewRegion(true); return; }
    const region = regions.find((r) => r.id === regionId);
    if (region) { setForm({ ...form, regionId: region.id!, regionName: region.name }); setShowNewRegion(false); }
  };

  const handleMapConfirm = (lat: number, lng: number, address: string) => {
    setForm({ ...form, lat, lng, locationAddress: address }); setShowMap(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editId) {
      await updateDoc(doc(db, "customers", editId), { ...form });
    } else {
      await addDoc(collection(db, "customers"), { ...form, outstandingDue: 0, createdAt: new Date().toISOString() });
    }
    setForm(emptyCustomer()); setEditId(null); setShowForm(false); fetchAll();
  };

  const handleEdit   = (c: Customer) => { setForm(c); setEditId(c.id!); setShowForm(true); };
  const handleDelete = async (id: string) => {
    if (!confirm("Delete this customer?")) return;
    await deleteDoc(doc(db, "customers", id)); fetchAll();
  };

  const filtered = customers.filter((c) => {
    const s = searchTerm.toLowerCase();
    const matchSearch = !s ||
      c.shopName.toLowerCase().includes(s) ||
      c.ownerName.toLowerCase().includes(s) ||
      c.phone.includes(s);
    const matchRegion = !filterRegion || filterRegion === "__due__"
      ? filterRegion === "__due__" ? (c.outstandingDue || 0) > 0 : true
      : c.regionId === filterRegion;
    return matchSearch && matchRegion;
  });

  useEffect(() => { setPage(1); }, [searchTerm, filterRegion]);

  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const totalDue         = customers.reduce((s, c) => s + (c.outstandingDue || 0), 0);
  const customersWithDue = customers.filter((c) => (c.outstandingDue || 0) > 0).length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Customers</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            {customers.length} customers
            {customersWithDue > 0 && (
              <span className="text-red-500 ml-2">
                · {customersWithDue} with due · Total ₹{totalDue.toLocaleString("en-IN", { maximumFractionDigits: 0 })} pending
              </span>
            )}
          </p>
        </div>
        {isAdmin ? (
          <button onClick={() => { setForm(emptyCustomer()); setEditId(null); setShowForm(true); }}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
            + Add Customer
          </button>
        ) : (
          <span className="text-xs text-gray-400 bg-gray-100 px-3 py-2 rounded-lg">View Only</span>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by name, owner, phone..."
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-orange-300" />
        <select value={filterRegion} onChange={(e) => setFilterRegion(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="">All Regions</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button
          onClick={() => setFilterRegion(filterRegion === "__due__" ? "" : "__due__")}
          className={`px-3 py-2 rounded-lg text-sm border transition-all ${
            filterRegion === "__due__"
              ? "bg-red-100 text-red-700 border-red-300"
              : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
          }`}>
          ⚠️ With Due Only
        </button>
      </div>

      {/* Table */}
      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-4">Shop Name</th>
                <th className="px-5 py-4">Owner</th>
                <th className="px-5 py-4">Phone</th>
                <th className="px-5 py-4">Region</th>
                <th className="px-5 py-4">Area</th>
                <th className="px-5 py-4">Outstanding Due</th>
                <th className="px-5 py-4">Location</th>
                {isAdmin && <th className="px-5 py-4">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {paginated.map((customer) => {
                const due = customer.outstandingDue || 0;
                return (
                  <tr key={customer.id} className={`hover:bg-gray-50 ${due > 0 ? "bg-red-50/30" : ""}`}>
                    <td className="px-5 py-3">
                      <button
                        onClick={() => setLedgerCustomer(customer)}
                        className="font-medium text-orange-600 hover:underline text-left">
                        {customer.shopName}
                      </button>
                    </td>
                    <td className="px-5 py-3 text-gray-700">{customer.ownerName}</td>
                    <td className="px-5 py-3 text-gray-600">{customer.phone}</td>
                    <td className="px-5 py-3">
                      <span className="bg-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full font-medium">
                        {customer.regionName || "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-600">{customer.area}</td>
                    <td className="px-5 py-3">
                      {due > 0 ? (
                        <button onClick={() => setLedgerCustomer(customer)}
                          className="font-semibold text-red-600 hover:underline text-left">
                          ₹{due.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        </button>
                      ) : (
                        <span className="text-green-600 text-xs font-medium">✓ Clear</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {customer.lat ? (
                        <a href={`https://www.openstreetmap.org/?mlat=${customer.lat}&mlon=${customer.lng}&zoom=17`}
                          target="_blank" rel="noreferrer" className="text-blue-500 hover:underline text-xs">
                          📍 View Map
                        </a>
                      ) : <span className="text-gray-400 text-xs">No location</span>}
                    </td>
                    {isAdmin && (
                      <td className="px-5 py-3">
                        <div className="flex gap-3">
                          <button onClick={() => handleEdit(customer)} className="text-blue-500 hover:underline text-xs">Edit</button>
                          <button onClick={() => handleDelete(customer.id!)} className="text-red-500 hover:underline text-xs">Delete</button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No customers found.</div>}
          <Pagination total={filtered.length} page={page} perPage={PER_PAGE} onPage={setPage} />
        </div>
      )}

      {/* Ledger Modal */}
      {ledgerCustomer && (
        <LedgerModal
          customer={ledgerCustomer}
          isAdmin={isAdmin}
          onClose={() => { setLedgerCustomer(null); fetchAll(); }}
        />
      )}

      {/* Customer Form Modal */}
      {showForm && isAdmin && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-2xl w-full max-w-xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editId ? "Edit Customer" : "Add New Customer"}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-6">
              <Sec title="Shop Information">
                <Fld label="Shop Name *"><input value={form.shopName} onChange={(e) => setForm({ ...form, shopName: e.target.value })} required placeholder="e.g. Sri Murugan Stores" className={inp} /></Fld>
                <Fld label="Owner Name *"><input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} required placeholder="e.g. Ravi Kumar" className={inp} /></Fld>
                <div className="grid grid-cols-2 gap-4">
                  <Fld label="Phone *"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required className={inp} /></Fld>
                  <Fld label="Alternate Phone"><input value={form.alternatePhone || ""} onChange={(e) => setForm({ ...form, alternatePhone: e.target.value })} className={inp} /></Fld>
                </div>
                <Fld label="GSTIN"><input value={form.gstin || ""} onChange={(e) => setForm({ ...form, gstin: e.target.value })} className={inp} /></Fld>
              </Sec>
              <Sec title="Region & Area">
                <Fld label="Region *">
                  <select value={showNewRegion ? "__new__" : form.regionId} onChange={(e) => handleRegionSelect(e.target.value)} required={!showNewRegion} className={inp}>
                    <option value="">-- Select Region --</option>
                    {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    <option value="__new__">+ Create New Region</option>
                  </select>
                  {showNewRegion && (
                    <div className="flex gap-2 mt-2">
                      <input value={newRegion} onChange={(e) => setNewRegion(e.target.value)} placeholder="New region name" className={inp} />
                      <button type="button" onClick={handleAddRegion} className="bg-orange-500 text-white px-3 py-2 rounded-lg text-sm">Add</button>
                      <button type="button" onClick={() => setShowNewRegion(false)} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm">✕</button>
                    </div>
                  )}
                </Fld>
                <Fld label="Area *"><input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} required={!form.lat} className={inp} /></Fld>
                <Fld label="Address"><textarea value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} rows={2} className={inp} /></Fld>
              </Sec>
              <Sec title="Location">
                <div className="flex items-start gap-4">
                  <div className="flex-1">
                    {form.lat ? (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                        <p className="text-sm text-green-700 font-medium">✅ Location Set</p>
                        <p className="text-xs text-green-600 mt-1">{form.locationAddress}</p>
                      </div>
                    ) : (
                      <div className="bg-gray-50 border border-dashed border-gray-300 rounded-lg p-3">
                        <p className="text-sm text-gray-500">No location picked yet</p>
                      </div>
                    )}
                  </div>
                  <button type="button" onClick={() => setShowMap(true)} className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600 whitespace-nowrap">
                    🗺️ {form.lat ? "Change" : "Pick Location"}
                  </button>
                </div>
              </Sec>
              <Sec title="Notes">
                <Fld label="Notes"><textarea value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={inp} /></Fld>
              </Sec>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 border border-gray-300 text-gray-600 py-3 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 text-white py-3 rounded-xl text-sm font-semibold hover:bg-orange-600">
                  {editId ? "Update Customer" : "Add Customer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showMap && (
        <MapPicker initialLat={form.lat} initialLng={form.lng} onConfirm={handleMapConfirm} onClose={() => setShowMap(false)} />
      )}
    </div>
  );
}

// ── Ledger Modal ──────────────────────────────────────────────────
function LedgerModal({ customer, isAdmin, onClose }: {
  customer: Customer; isAdmin: boolean; onClose: () => void;
}) {
  const { user } = useAuthStore();
  const [entries, setEntries]     = useState<LedgerEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [tab, setTab]             = useState<"ledger" | "orders" | "payment" | "adjust">("ledger");
  const [custOrders, setCustOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [amount, setAmount]       = useState("");
  const [note, setNote]           = useState("");
  const [saving, setSaving]       = useState(false);

  const fetchOrders = async () => {
    setOrdersLoading(true);
    try {
      const { getDocs, collection: col, query: q, where, orderBy: ob } = await import("firebase/firestore");
      const snap = await getDocs(
        q(col(db, "orders"), where("customerId", "==", customer.id), ob("createdAt", "desc"))
      );
      setCustOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
    } catch { setCustOrders([]); }
    finally { setOrdersLoading(false); }
  };

  const fetchLedger = async () => {
    setLoading(true);
    const data = await getLedger(customer.id!);
    setEntries(data);
    setLoading(false);
  };

  useEffect(() => { fetchLedger(); }, [customer.id]);
  useEffect(() => { if (tab === "orders") fetchOrders(); }, [tab]);

  const balance = calcBalance(entries);

  const handlePayment = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;
    setSaving(true);
    try {
      await recordManualPayment(customer.id!, amt, note, user!.uid, user!.name);
      setAmount(""); setNote("");
      await fetchLedger();
      setTab("ledger");
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleAdjustment = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt === 0) return;
    setSaving(true);
    try {
      await recordAdjustment(customer.id!, amt, note, user!.uid, user!.name);
      setAmount(""); setNote("");
      await fetchLedger();
      setTab("ledger");
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  // Running balance per row
  const rows = entries.map((e, i) => {
    const running = calcBalance(entries.slice(0, i + 1));
    return { ...e, running };
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">{customer.shopName}</h3>
            <p className="text-sm text-gray-500">{customer.ownerName} · {customer.phone}</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <p className="text-xs text-gray-400">Current Balance</p>
              <p className={`text-xl font-bold ${balance > 0 ? "text-red-600" : "text-green-600"}`}>
                {balance > 0 ? `₹${balance.toFixed(2)} due` : "✓ Clear"}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
          </div>
        </div>

        {/* Tabs — admin can record payment/adjust, packing staff view only */}
        <div className="flex border-b border-gray-100 flex-shrink-0">
          <button onClick={() => setTab("ledger")}
            className={`flex-1 py-3 text-sm font-medium transition-all ${tab === "ledger" ? "border-b-2 border-orange-500 text-orange-600" : "text-gray-500 hover:text-gray-700"}`}>
            📋 Ledger
          </button>
          <button onClick={() => setTab("orders")}
            className={`flex-1 py-3 text-sm font-medium transition-all ${tab === "orders" ? "border-b-2 border-orange-500 text-orange-600" : "text-gray-500 hover:text-gray-700"}`}>
            📦 Orders
          </button>
          {isAdmin && (
            <>
              <button onClick={() => { setTab("payment"); setAmount(""); setNote(""); }}
                className={`flex-1 py-3 text-sm font-medium transition-all ${tab === "payment" ? "border-b-2 border-green-500 text-green-600" : "text-gray-500 hover:text-gray-700"}`}>
                💰 Payment
              </button>
              <button onClick={() => { setTab("adjust"); setAmount(""); setNote(""); }}
                className={`flex-1 py-3 text-sm font-medium transition-all ${tab === "adjust" ? "border-b-2 border-blue-500 text-blue-600" : "text-gray-500 hover:text-gray-700"}`}>
                ✏️ Adjust
              </button>
            </>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">

          {/* Ledger tab */}
          {tab === "ledger" && (
            loading ? (
              <div className="text-center py-12 text-gray-400">Loading ledger...</div>
            ) : rows.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p className="text-3xl mb-3">📭</p>
                <p className="font-medium">No transactions yet</p>
                <p className="text-sm mt-1">Orders and payments will appear here</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="px-5 py-3 text-left">Date</th>
                    <th className="px-5 py-3 text-left">Type</th>
                    <th className="px-5 py-3 text-left">Note</th>
                    <th className="px-5 py-3 text-right">Debit</th>
                    <th className="px-5 py-3 text-right">Credit</th>
                    <th className="px-5 py-3 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((e) => (
                    <tr key={e.id} className="hover:bg-gray-50">
                      <td className="px-5 py-3 text-gray-500 whitespace-nowrap">
                        {new Date(e.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                          e.direction === "debit"
                            ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                        }`}>
                          {ENTRY_LABELS[e.type] || e.type}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-gray-500 text-xs max-w-[160px]">
                        <p>{e.note || "—"}</p>
                        <p className="text-gray-400">{e.createdByName}</p>
                      </td>
                      <td className="px-5 py-3 text-right text-red-600 font-medium">
                        {e.direction === "debit" ? `₹${e.amount.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-right text-green-600 font-medium">
                        {e.direction === "credit" ? `₹${e.amount.toFixed(2)}` : "—"}
                      </td>
                      <td className={`px-5 py-3 text-right font-bold ${e.running > 0 ? "text-red-600" : "text-green-600"}`}>
                        ₹{e.running.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t border-gray-200">
                  <tr>
                    <td colSpan={5} className="px-5 py-3 text-sm font-semibold text-gray-700">Current Balance</td>
                    <td className={`px-5 py-3 text-right font-bold text-lg ${balance > 0 ? "text-red-600" : "text-green-600"}`}>
                      ₹{balance.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )
          )}

          {/* Orders tab */}
          {tab === "orders" && (
            ordersLoading ? (
              <div className="text-center py-12 text-gray-400">Loading orders...</div>
            ) : custOrders.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <p className="text-3xl mb-3">📭</p>
                <p className="font-medium">No orders yet</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="px-5 py-3 text-left">Date</th>
                    <th className="px-5 py-3 text-left">Agent</th>
                    <th className="px-5 py-3 text-right">Amount</th>
                    <th className="px-5 py-3 text-left">Status</th>
                    <th className="px-5 py-3 text-right">Collected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {custOrders.map((o) => {
                    const STATUS_C: Record<string,string> = {
                      pending:"bg-yellow-100 text-yellow-700", packed:"bg-blue-100 text-blue-700",
                      assigned:"bg-indigo-100 text-indigo-700", out_for_delivery:"bg-purple-100 text-purple-700",
                      delivered:"bg-green-100 text-green-700", cancelled:"bg-gray-100 text-gray-500",
                    };
                    const STATUS_L: Record<string,string> = {
                      pending:"Pending", packed:"Packed", assigned:"Assigned",
                      out_for_delivery:"Out for Delivery", delivered:"Delivered", cancelled:"Cancelled",
                    };
                    const balance = o.amountCollected !== undefined ? o.totalAmount - o.amountCollected : null;
                    return (
                      <tr key={o.id} className="hover:bg-gray-50">
                        <td className="px-5 py-3 text-gray-500 whitespace-nowrap text-xs">
                          {new Date(o.createdAt).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })}
                        </td>
                        <td className="px-5 py-3 text-gray-600 text-xs">{o.agentName}</td>
                        <td className="px-5 py-3 text-right font-medium text-gray-800">₹{o.totalAmount.toFixed(2)}</td>
                        <td className="px-5 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_C[o.status] || ""}`}>
                            {STATUS_L[o.status] || o.status}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right text-xs">
                          {o.amountCollected !== undefined ? (
                            <div>
                              <span className="text-green-600 font-medium">₹{o.amountCollected.toFixed(2)}</span>
                              {balance !== null && balance > 0 && (
                                <p className="text-red-500">₹{balance.toFixed(2)} due</p>
                              )}
                            </div>
                          ) : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 border-t border-gray-200">
                  <tr>
                    <td colSpan={2} className="px-5 py-3 text-xs font-semibold text-gray-500">
                      {custOrders.length} orders total
                    </td>
                    <td className="px-5 py-3 text-right font-bold text-gray-800">
                      ₹{custOrders.reduce((s,o) => s + o.totalAmount, 0).toFixed(2)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            )
          )}

          {/* Record Payment tab */}
          {tab === "payment" && isAdmin && (
            <div className="p-6">
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-5">
                <p className="text-sm text-green-700 font-medium">Recording a payment will reduce the customer's outstanding balance.</p>
              </div>
              {balance > 0 && (
                <div className="flex justify-between items-center bg-red-50 border border-red-100 rounded-lg px-4 py-3 mb-5">
                  <span className="text-sm text-gray-600">Current Balance Due</span>
                  <span className="font-bold text-red-600 text-lg">₹{balance.toFixed(2)}</span>
                </div>
              )}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount Received (₹) *</label>
                  <input type="number" min="0.01" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="Enter amount received"
                    className={inp} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
                  <input value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Cash payment, UPI transfer..."
                    className={inp} />
                </div>
                {amount && !isNaN(parseFloat(amount)) && (
                  <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm">
                    New balance after payment: <span className={`font-bold ${Math.max(0, balance - parseFloat(amount)) > 0 ? "text-red-600" : "text-green-600"}`}>
                      ₹{Math.max(0, balance - parseFloat(amount)).toFixed(2)}
                    </span>
                  </div>
                )}
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setTab("ledger")} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
                  <button onClick={handlePayment} disabled={saving || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0}
                    className="flex-1 bg-green-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-600 disabled:opacity-50">
                    {saving ? "Saving..." : "✅ Record Payment"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Adjustment tab */}
          {tab === "adjust" && isAdmin && (
            <div className="p-6">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-5">
                <p className="text-sm text-blue-700 font-medium">Use adjustments to correct errors or add charges not from orders.</p>
                <p className="text-sm text-blue-600 mt-1">Positive amount = add to balance (debit). Negative amount = reduce balance (credit).</p>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (₹) *</label>
                  <input type="number" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="e.g. 200 or -200"
                    className={inp} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reason *</label>
                  <input value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Damage charges, credit note..."
                    className={inp} />
                </div>
                {amount && !isNaN(parseFloat(amount)) && (
                  <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm">
                    {parseFloat(amount) >= 0
                      ? <span>Adding <span className="font-bold text-red-600">₹{parseFloat(amount).toFixed(2)}</span> to balance</span>
                      : <span>Reducing balance by <span className="font-bold text-green-600">₹{Math.abs(parseFloat(amount)).toFixed(2)}</span></span>
                    }
                  </div>
                )}
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setTab("ledger")} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
                  <button onClick={handleAdjustment} disabled={saving || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) === 0 || !note.trim()}
                    className="flex-1 bg-blue-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-blue-600 disabled:opacity-50">
                    {saving ? "Saving..." : "Apply Adjustment"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Sec({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-orange-500 uppercase tracking-wide mb-3 pb-1 border-b border-orange-100">{title}</h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}
function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}
const inp = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300";