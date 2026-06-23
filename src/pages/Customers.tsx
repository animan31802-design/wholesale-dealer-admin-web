import { useEffect, useState, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import {
  collection, getDocs, addDoc, updateDoc,
  deleteDoc, doc, orderBy, query, where, setDoc, runTransaction
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer, Region } from "../types";
import { LedgerEntry } from "../types/ledger";
import Pagination from "../components/Pagination";
import { Order } from "../types";
import { getLedger, calcBalance, recordManualPayment, recordAdjustment, applyPaymentToOrders } from "../utils/ledger";
import MapPicker from "../components/MapPicker";
import { useAuthStore } from "../store/authStore";
import { useModalKeyboard } from "../hooks/useModalKeyboard";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";

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

function round2(n: number): number { return Math.round(n * 100) / 100; }

export default function Customers() {
  const [customers, setCustomers]     = useState<Customer[]>([]);
  const [regions, setRegions]         = useState<Region[]>([]);
  const [form, setForm]               = useState<Customer>(emptyCustomer());
  const [editId, setEditId]           = useState<string | null>(null);
  const [showForm, setShowForm]       = useState(false);
  useModalKeyboard({ onClose: () => { setShowForm(false); setLedgerCustomer(null); }, confirmOnEnter: false });
  const [showMap, setShowMap]         = useState(false);
  const [loading, setLoading]         = useState(true);
  const [showNewRegion, setShowNewRegion] = useState(false);
  const [newRegion, setNewRegion]     = useState("");
  const [filterRegion, setFilterRegion] = useState("");
  const [ledgerCustomer, setLedgerCustomer] = useState<Customer | null>(null);
  const [page, setPage] = useState(1);
  const PER_PAGE = 15;
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";
  const isPackingStaff = user?.role === "packing_staff";
  const canCreate = isAdmin || isPackingStaff;
  const csvRef = useRef<HTMLInputElement>(null);

  // ── Tamil-aware search ────────────────────────────────────────────────────
  // Searches shopName, ownerName, phone. Works with English typing for Tamil names.
  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults } =
    useTamilSearch(customers as unknown as Record<string, unknown>[], ["shopName", "ownerName", "phone"]);

  // ── Export customers to Excel ──
  const handleExport = () => {
    const rows = customers.map((c) => ({
      "Shop Name":        c.shopName,
      "Owner Name":       c.ownerName,
      "Phone":            c.phone,
      "Alternate Phone":  c.alternatePhone || "",
      "Address":          c.address || "",
      "Area":             c.area || "",
      "Region":           c.regionName || "",
      "GSTIN":            c.gstin || "",
      "Lat":              c.lat || "",
      "Lng":              c.lng || "",
      "Notes":            c.notes || "",
      "Outstanding Due":  c.outstandingDue || 0,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = Object.keys(rows[0] || {}).map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Customers");
    XLSX.writeFile(wb, `customers-export-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // ── Import customers from CSV/Excel ──
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data  = new Uint8Array(ev.target!.result as ArrayBuffer);
        const wb    = XLSX.read(data, { type: "array" });
        const ws    = wb.Sheets[wb.SheetNames[0]];
        const rows  = XLSX.utils.sheet_to_json<any>(ws);
        if (rows.length === 0) { alert("No data found in file."); return; }

        let imported = 0; let skipped = 0;
        const regs = await fetchRegions();

        for (const row of rows) {
          const shopName  = (row["Shop Name"] || row["shopName"] || "").toString().trim();
          const ownerName = (row["Owner Name"] || row["ownerName"] || "").toString().trim();
          const phone     = (row["Phone"] || row["phone"] || "").toString().trim();
          const regionName = (row["Region"] || row["regionName"] || "").toString().trim();

          if (!shopName || !phone) { skipped++; continue; }

          // Find or create region
          let regionId = "";
          if (regionName) {
            const found = regs.find((r) => r.name.toLowerCase() === regionName.toLowerCase());
            if (found) {
              regionId = found.id!;
            } else {
              const ref = await addDoc(collection(db, "regions"), { name: regionName, createdAt: new Date().toISOString() });
              regionId = ref.id;
            }
          }

          await addDoc(collection(db, "customers"), {
            shopName,
            ownerName,
            phone,
            alternatePhone: (row["Alternate Phone"] || row["alternatePhone"] || "").toString().trim(),
            address:        (row["Address"] || row["address"] || "").toString().trim(),
            area:           (row["Area"] || row["area"] || "").toString().trim(),
            regionId,
            regionName:     regionName,
            gstin:          (row["GSTIN"] || row["gstin"] || "").toString().trim(),
            lat:            parseFloat(row["Lat"] || row["lat"]) || undefined,
            lng:            parseFloat(row["Lng"] || row["lng"]) || undefined,
            notes:          (row["Notes"] || row["notes"] || "").toString().trim(),
            outstandingDue: parseFloat(row["Outstanding Due"] || row["outstandingDue"]) || 0,
            createdAt:      new Date().toISOString(),
          });
          imported++;
        }

        alert(`✅ Import complete!
${imported} customers imported
${skipped} rows skipped (missing shop name or phone)`);
        fetchAll();
      } catch (err: any) {
        alert("Import failed: " + (err.message || "Unknown error"));
      }
      e.target.value = "";
    };
    reader.readAsArrayBuffer(file);
  };

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

    // ── Phone validation: must be 10 digits ──────────────────────
    const phoneDigits = form.phone.replace(/\D/g, "");
    if (phoneDigits.length !== 10) {
      alert("Please enter a valid 10-digit phone number.");
      return;
    }

    // ── Alternate phone: if provided, must also be 10 digits ─────
    if (form.alternatePhone) {
      const altDigits = form.alternatePhone.replace(/\D/g, "");
      if (altDigits.length !== 10) {
        alert("Please enter a valid 10-digit alternate phone number.");
        return;
      }
    }

    // ── GSTIN validation (optional, but if provided must match format) ──
    if (form.gstin && form.gstin.trim()) {
      const gstinRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
      if (!gstinRegex.test(form.gstin.trim().toUpperCase())) {
        alert("Please enter a valid GSTIN (e.g. 33AAAAA0000A1Z5).");
        return;
      }
    }

    // Strip undefined lat/lng/locationAddress — Firestore rejects undefined values.
    // Only include location fields when the user has actually picked a map point.
    const cleanForm = { ...form, gstin: form.gstin?.trim().toUpperCase() || "" };
    if (cleanForm.lat == null)         delete (cleanForm as any).lat;
    if (cleanForm.lng == null)         delete (cleanForm as any).lng;
    if (!cleanForm.locationAddress)    delete (cleanForm as any).locationAddress;

    if (editId) {
      await updateDoc(doc(db, "customers", editId), cleanForm);
    } else {
      await addDoc(collection(db, "customers"), { ...cleanForm, outstandingDue: 0, createdAt: new Date().toISOString() });
    }
    setForm(emptyCustomer()); setEditId(null); setShowForm(false); fetchAll();
  };

  const handleEdit   = (c: Customer) => { setForm(c); setEditId(c.id!); setShowForm(true); };
  const handleDelete = async (id: string) => {
    if (!confirm("Delete this customer?")) return;
    await deleteDoc(doc(db, "customers", id)); fetchAll();
  };

  const filtered = useMemo(() => {
    let list = searchResults as unknown as Customer[];
    if (filterRegion === "__due__") {
      list = list.filter((c) => (c.outstandingDue || 0) > 0);
    } else if (filterRegion) {
      list = list.filter((c) => c.regionId === filterRegion);
    }
    return list;
  }, [searchResults, filterRegion]);

  useEffect(() => { setPage(1); }, [searchQuery, filterRegion]);

  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const totalDue         = customers.reduce((s, c) => s + (c.outstandingDue || 0), 0);
  const customersWithDue = customers.filter((c) => (c.outstandingDue || 0) > 0).length;

  return (
    <div className="p-3 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
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
        <div className="flex gap-2 flex-wrap">
          {isAdmin && (
            <>
              <button onClick={handleExport}
                className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 flex items-center gap-1">
                ⬇️ Export
              </button>
              <button onClick={() => csvRef.current?.click()}
                className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50 flex items-center gap-1">
                ⬆️ Import
              </button>
              <input ref={csvRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleImport} />
            </>
          )}
          {canCreate && (
            <button onClick={() => { setForm(emptyCustomer()); setEditId(null); setShowForm(true); }}
              className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
              + Add Customer
            </button>
          )}
          {!canCreate && (
            <span className="text-xs text-gray-400 bg-gray-100 px-3 py-2 rounded-lg">View Only</span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-5 flex-wrap">
        <TamilSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by name, owner, phone... (supports Tamil)"
          className="w-72"
        />
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
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto -mx-3 md:mx-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-4">Shop Name</th>
                <th className="px-5 py-4">Owner</th>
                <th className="px-5 py-4">Phone</th>
                <th className="px-5 py-4">Area</th>
                <th className="px-5 py-4">Region</th>
                <th className="px-5 py-4">Outstanding Due</th>
                <th className="px-5 py-4">Last Order</th>
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
                    <td className="px-5 py-3 text-gray-600">{customer.area}</td>
                    <td className="px-5 py-3">
                      <span className="bg-orange-100 text-orange-700 text-xs px-2 py-1 rounded-full font-medium">
                        {customer.regionName || "—"}
                      </span>
                    </td>
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
                    <td className="px-5 py-3 text-xs text-gray-500">
                      {/* FIX: show lastOrderAt written by both web and mobile */}
                      {(customer as any).lastOrderAt
                        ? new Date((customer as any).lastOrderAt).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"2-digit" })
                        : <span className="text-gray-300">—</span>}
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
      {showForm && canCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-0 md:py-8 px-0 md:px-4">
          <div className="bg-white rounded-none md:rounded-2xl w-full max-w-xl shadow-2xl min-h-screen md:min-h-0">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editId ? "Edit Customer" : "Add New Customer"}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-6">
              <Sec title="Shop Information">
                <Fld label="Shop Name *"><input value={form.shopName} onChange={(e) => setForm({ ...form, shopName: e.target.value })} required placeholder="e.g. Sri Murugan Stores" className={inp} /></Fld>
                <Fld label="Owner Name"><input value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} placeholder="e.g. Ravi Kumar (optional)" className={inp} /></Fld>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Fld label="Phone *">
                    <input
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      required
                      placeholder="10-digit mobile number"
                      maxLength={15}
                      className={inp}
                    />
                  </Fld>
                  <Fld label="Alternate Phone">
                    <input
                      value={form.alternatePhone || ""}
                      onChange={(e) => setForm({ ...form, alternatePhone: e.target.value })}
                      placeholder="Optional"
                      maxLength={15}
                      className={inp}
                    />
                  </Fld>
                </div>
                <Fld label="GSTIN">
                  <input
                    value={form.gstin || ""}
                    onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
                    placeholder="e.g. 33AAAAA0000A1Z5"
                    maxLength={15}
                    className={inp}
                  />
                  <p className="text-xs text-gray-400 mt-1">15-character GST number (optional)</p>
                </Fld>
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
                  <div className="flex flex-col gap-2">
                    <button type="button" onClick={() => setShowMap(true)} className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600 whitespace-nowrap">
                      🗺️ {form.lat ? "Change" : "Pick Location"}
                    </button>
                    {form.lat && (
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, lat: undefined, lng: undefined, locationAddress: "" })}
                        className="border border-red-200 text-red-500 px-4 py-2 rounded-lg text-sm hover:bg-red-50 whitespace-nowrap"
                      >
                        🗑 Clear
                      </button>
                    )}
                  </div>
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
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());

  const fetchOrders = async () => {
    setOrdersLoading(true);
    try {
      // Use top-level imports (already imported at file top)
      const snap = await getDocs(
        query(collection(db, "orders"), where("customerId", "==", customer.id), orderBy("createdAt", "desc"))
      );
      setCustOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
    } catch (e) {
      console.error("Orders fetch error:", e);
      setCustOrders([]);
    } finally {
      setOrdersLoading(false);
    }
  };

  const fetchLedger = async () => {
    setLoading(true);
    try {
      let data = await getLedger(customer.id!);

      // ── Dedup: remove duplicate entries for the same orderId+type written by
      //    a previous buggy backfill run. Keep only the first entry per orderId+type.
      if (data.length > 0) {
        const seen = new Set<string>();
        const { deleteDoc: dd, doc: fdoc } = await import("firebase/firestore");
        for (const entry of data) {
          if (!entry.orderId) continue;
          const key = entry.orderId + "__" + entry.type + "__" + entry.direction;
          if (seen.has(key)) {
            // Duplicate — delete it from Firestore
            try {
              await dd(fdoc(db, "customers", customer.id!, "payments", entry.id!));
            } catch (_) {}
          } else {
            seen.add(key);
          }
        }
        // Re-fetch cleaned data
        data = await getLedger(customer.id!);
      }

      // ── Backfill: if ledger is empty but customer has orders,
      //    auto-generate ledger entries so history shows up correctly.
      //    Uses orderId deduplication to prevent double-writing.
      if (data.length === 0 && (customer.outstandingDue ?? 0) !== 0) {
        const ordSnap = await getDocs(
          query(collection(db, "orders"), where("customerId", "==", customer.id), orderBy("createdAt", "asc"))
        );
        const orders = ordSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Order));

        // Check existing ledger entries by orderId to avoid duplicates
        const existingSnap = await getDocs(
          query(collection(db, "customers", customer.id!, "payments"), orderBy("createdAt", "asc"))
        );
        const writtenOrderIds = new Set(
          existingSnap.docs.map((d) => d.data().orderId).filter(Boolean)
        );

        const ledgerCol = collection(db, "customers", customer.id!, "payments");

        for (const o of orders.filter((o) => o.status !== "cancelled")) {
          // Skip if already backfilled for this order
          if (writtenOrderIds.has(o.id)) continue;

          const advance = (o as any).advancePaid ?? 0;

          // Debit: order placed
          await addDoc(ledgerCol, {
            type:          "order_placed",
            direction:     "debit",
            amount:        o.totalAmount,
            orderId:       o.id,
            orderAmount:   o.totalAmount,
            note:          "Order #" + (o.id ?? "").slice(0, 8).toUpperCase() + " placed (backfilled)",
            createdBy:     o.agentId ?? "system",
            createdByName: o.agentName ?? "System",
            createdAt:     o.createdAt ?? new Date().toISOString(),
          });

          // Credit: advance paid at order creation
          if (advance > 0) {
            await addDoc(ledgerCol, {
              type:          "delivery_payment",
              direction:     "credit",
              amount:        advance,
              orderId:       o.id,
              note:          "Advance collected at order #" + (o.id ?? "").slice(0, 8).toUpperCase() + " (backfilled)",
              createdBy:     o.agentId ?? "system",
              createdByName: o.agentName ?? "System",
              createdAt:     o.createdAt ?? new Date().toISOString(),
            });
          }

          // Credit: delivery collection (if more was collected than advance)
          if (o.status === "delivered" && (o.amountCollected ?? 0) > advance) {
            const deliveryAmt = (o.amountCollected ?? 0) - advance;
            await addDoc(ledgerCol, {
              type:          "delivery_payment",
              direction:     "credit",
              amount:        deliveryAmt,
              orderId:       o.id,
              note:          "Payment collected at delivery for order #" + (o.id ?? "").slice(0, 8).toUpperCase() + " (backfilled)",
              createdBy:     (o as any).deliveryPersonId ?? "system",
              createdByName: (o as any).deliveryPersonName ?? "Delivery Agent",
              createdAt:     (o as any).deliveredAt ?? o.createdAt ?? new Date().toISOString(),
            });
          }
        }

        // Re-fetch after backfill
        data = await getLedger(customer.id!);
      }

      setEntries(data);
    } catch (e) {
      console.error("Ledger fetch error:", e);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLedger(); }, [customer.id]);
  useEffect(() => { if (tab === "orders" || tab === "payment") fetchOrders(); }, [tab]);

  const balance = calcBalance(entries);

  const [paymentMode, setPaymentMode] = useState<"cash"|"upi"|"bank"|"cheque">("cash");

  // Orders with an outstanding balance, oldest first — this is the pool the
  // admin picks from when settling a payment against specific order(s).
  // Oldest-first ordering matters: applyPaymentToOrders fills whichever
  // orders are passed to it in array order, fully settling each before any
  // amount spills into the next.
  const unpaidOrdersOldestFirst = useMemo(() => {
    return custOrders
      .filter((o) => o.status !== "cancelled")
      .filter((o) => Math.max(0, Math.round((o.totalAmount - (o.amountCollected ?? 0)) * 100) / 100) > 0)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [custOrders]);

  const toggleOrderSelection = (orderId: string) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  // Orders the admin has checked, kept in the oldest-first order so the
  // allocation always fills earlier orders before later ones, regardless of
  // click order.
  const selectedOrdersOldestFirst = unpaidOrdersOldestFirst.filter((o) => selectedOrderIds.has(o.id!));
  const selectedOrdersTotalDue = round2(
    selectedOrdersOldestFirst.reduce((s, o) => s + Math.max(0, o.totalAmount - (o.amountCollected ?? 0)), 0)
  );

  const handlePayment = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;
    if (amt > balance + 0.01) {
      alert("Amount cannot exceed the current balance due.");
      return;
    }
    if (selectedOrdersOldestFirst.length > 0 && amt > selectedOrdersTotalDue + 0.01) {
      alert(`Amount exceeds the total due for the ${selectedOrdersOldestFirst.length} selected order(s) (₹${selectedOrdersTotalDue.toFixed(2)}). Select more orders, or reduce the amount, or deselect all orders for a general (non order-linked) payment.`);
      return;
    }
    setSaving(true);
    try {
      if (selectedOrdersOldestFirst.length > 0) {
        // Order-aware settlement — fills the selected orders oldest-first,
        // fully settling each before any remainder spills into the next.
        // This keeps order.amountCollected / balanceDue / paymentMode in
        // sync, which is what every report and the order drawer read from.
        await applyPaymentToOrders(
          customer.id!,
          selectedOrdersOldestFirst.map((o) => ({
            id: o.id!, totalAmount: o.totalAmount,
            amountCollected: o.amountCollected, adminCollected: (o as any).adminCollected,
          })),
          amt,
          paymentMode,
          note.trim(),
          user!.uid, user!.name
        );
      } else {
        // No specific order(s) chosen — plain ledger-only credit (e.g. a
        // goodwill adjustment or a payment that genuinely isn't tied to a
        // specific order). Does not touch any order doc.
        await recordManualPayment(
          customer.id!, amt,
          (note.trim() || "Manual payment") + " [" + paymentMode + "]",
          user!.uid, user!.name
        );
      }
      setAmount(""); setNote(""); setSelectedOrderIds(new Set());
      await fetchLedger();
      await fetchOrders();
      setTab("ledger");
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleAdjustment = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt === 0) return;
    if (!note.trim()) return;
    setSaving(true);
    try {
      await recordAdjustment(customer.id!, amt, note.trim(), user!.uid, user!.name);
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
              <button onClick={() => { setTab("payment"); setAmount(""); setNote(""); setSelectedOrderIds(new Set()); }}
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
            <div className="p-3 md:p-6">
              {balance <= 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <p className="text-3xl mb-3">✅</p>
                  <p className="font-medium text-green-600">No outstanding balance</p>
                  <p className="text-sm mt-1">This customer has no pending dues</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Current balance banner */}
                  <div className="flex justify-between items-center bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                    <span className="text-sm text-gray-600 font-medium">Current Balance Due</span>
                    <span className="font-bold text-red-600 text-xl">₹{balance.toFixed(2)}</span>
                  </div>

                  {/* Settle specific order(s) — optional */}
                  {unpaidOrdersOldestFirst.length > 0 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Settle Specific Order(s) <span className="text-gray-400 font-normal">(optional)</span>
                      </label>
                      <p className="text-xs text-gray-400 mb-2">
                        Pick which unpaid orders this payment covers. Oldest orders are filled first — pick fewer
                        orders for a focused settlement, or several to clear multiple at once.
                      </p>
                      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 max-h-56 overflow-y-auto">
                        {unpaidOrdersOldestFirst.map((o) => {
                          const due = Math.max(0, round2(o.totalAmount - (o.amountCollected ?? 0)));
                          const checked = selectedOrderIds.has(o.id!);
                          return (
                            <label key={o.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                              <span className="flex items-center gap-2 min-w-0">
                                <input type="checkbox" checked={checked}
                                  onChange={() => toggleOrderSelection(o.id!)}
                                  className="rounded border-gray-300" />
                                <span className="truncate">
                                  #{o.orderNo ?? o.id!.slice(0, 8).toUpperCase()}
                                  <span className="text-gray-400 ml-1">{new Date(o.createdAt).toLocaleDateString("en-IN")}</span>
                                </span>
                              </span>
                              <span className="font-medium text-red-600 flex-shrink-0">₹{due.toFixed(2)}</span>
                            </label>
                          );
                        })}
                      </div>
                      {selectedOrdersOldestFirst.length > 0 && (
                        <div className="flex justify-between items-center mt-2 px-1">
                          <span className="text-xs text-gray-500">
                            {selectedOrdersOldestFirst.length} order{selectedOrdersOldestFirst.length > 1 ? "s" : ""} selected
                          </span>
                          <button type="button"
                            onClick={() => setAmount(selectedOrdersTotalDue.toFixed(2))}
                            className="text-xs bg-orange-100 text-orange-700 px-3 py-1 rounded-full hover:bg-orange-200 font-medium">
                            Use total: ₹{selectedOrdersTotalDue.toFixed(2)}
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Amount input */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Amount Received (₹) *</label>
                    <input type="number" min="0.01" step="0.01" value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className={inp} />
                    <div className="flex gap-2 mt-2 flex-wrap">
                      <button onClick={() => setAmount(balance.toFixed(2))}
                        className="text-xs bg-green-100 text-green-700 px-3 py-1 rounded-full hover:bg-green-200 font-medium">
                        Full ₹{balance.toFixed(2)}
                      </button>
                      {[500, 1000, 2000].filter(v => v < balance).map(v => (
                        <button key={v} onClick={() => setAmount(String(v))}
                          className="text-xs bg-gray-100 text-gray-600 px-3 py-1 rounded-full hover:bg-gray-200">
                          ₹{v}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Payment mode */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Payment Mode *</label>
                    <div className="flex gap-2">
                      {(["cash","upi","bank","cheque"] as const).map((m) => (
                        <button key={m} onClick={() => setPaymentMode(m)}
                          className={`flex-1 py-2 rounded-lg text-xs font-medium border capitalize transition-all ${
                            paymentMode === m
                              ? "bg-orange-500 text-white border-orange-500"
                              : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                          }`}>
                          {m === "upi" ? "UPI" : m.charAt(0).toUpperCase() + m.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Note */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
                    <input value={note} onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Reference number, transaction ID..."
                      className={inp} />
                  </div>

                  {/* Preview */}
                  {amount && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0 && (
                    parseFloat(amount) > balance + 0.01 ? (
                      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-600 font-medium">
                        ⚠️ Amount exceeds balance due. Max is ₹{balance.toFixed(2)}
                      </div>
                    ) : selectedOrdersOldestFirst.length > 0 && parseFloat(amount) > selectedOrdersTotalDue + 0.01 ? (
                      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-600 font-medium">
                        ⚠️ Amount exceeds the ₹{selectedOrdersTotalDue.toFixed(2)} due on the {selectedOrdersOldestFirst.length} selected order(s).
                        Select more orders or reduce the amount.
                      </div>
                    ) : (
                      <div className="bg-gray-50 rounded-lg px-4 py-3 text-sm flex justify-between">
                        <span className="text-gray-500">Balance after payment:</span>
                        <span className={`font-bold ${Math.max(0, balance - parseFloat(amount)) > 0 ? "text-red-600" : "text-green-600"}`}>
                          ₹{Math.max(0, balance - parseFloat(amount)).toFixed(2)}
                          {Math.max(0, balance - parseFloat(amount)) === 0 && "  ✓ Fully Cleared"}
                        </span>
                      </div>
                    )
                  )}

                  <div className="flex gap-3 pt-2">
                    <button onClick={() => { setTab("ledger"); setSelectedOrderIds(new Set()); }} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
                    <button onClick={handlePayment}
                      disabled={
                        saving || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0 ||
                        parseFloat(amount) > balance + 0.01 ||
                        (selectedOrdersOldestFirst.length > 0 && parseFloat(amount) > selectedOrdersTotalDue + 0.01)
                      }
                      className="flex-1 bg-green-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-600 disabled:opacity-50">
                      {saving ? "Saving..." : "✅ Record Payment"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Adjustment tab */}
          {tab === "adjust" && isAdmin && (
            <div className="p-3 md:p-6">
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-4">
                <p className="text-sm text-blue-700 font-medium">Use adjustments to correct errors or add charges/credits.</p>
                <p className="text-sm text-blue-600 mt-1">
                  <span className="font-semibold">Positive</span> = adds to balance (customer owes more) &nbsp;|&nbsp;
                  <span className="font-semibold">Negative</span> = reduces balance (credit)
                </p>
              </div>

              {/* Current balance */}
              <div className="flex justify-between items-center bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 mb-4">
                <span className="text-sm text-gray-600">Current Balance</span>
                <span className={`font-bold text-lg ${balance > 0 ? "text-red-600" : "text-green-600"}`}>
                  ₹{balance.toFixed(2)}
                </span>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (₹) *</label>
                  <input type="number" step="0.01" value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="e.g. 200 (charge) or -200 (credit)"
                    className={inp} />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Reason * <span className="text-xs text-gray-400 font-normal">(required)</span>
                  </label>
                  <input value={note} onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Damage charges, return credit, price correction..."
                    className={inp} />
                  {!note.trim() && amount && (
                    <p className="text-xs text-red-500 mt-1">⚠ Please enter a reason before applying</p>
                  )}
                </div>

                {/* Preview new balance */}
                {amount && !isNaN(parseFloat(amount)) && parseFloat(amount) !== 0 && (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Current balance:</span>
                      <span className="font-medium text-gray-700">₹{balance.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Adjustment:</span>
                      <span className={`font-medium ${parseFloat(amount) >= 0 ? "text-red-600" : "text-green-600"}`}>
                        {parseFloat(amount) >= 0 ? "+" : ""}₹{parseFloat(amount).toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-gray-200 pt-1 mt-1">
                      <span className="text-gray-600 font-medium">New balance:</span>
                      <span className={`font-bold ${Math.max(0, balance + parseFloat(amount)) > 0 ? "text-red-600" : "text-green-600"}`}>
                        ₹{Math.max(0, balance + parseFloat(amount)).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  <button onClick={() => setTab("ledger")} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
                  <button onClick={handleAdjustment}
                    disabled={saving || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) === 0 || !note.trim()}
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