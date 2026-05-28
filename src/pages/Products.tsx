import { useEffect, useState, useMemo, useRef } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  deleteDoc, doc, orderBy, query,
  onSnapshot, where
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Product, PriceSlab, ProductUnit, GSTRate, Order } from "../types";
import { useAuthStore } from "../store/authStore";
import Pagination from "../components/Pagination";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";

const UNITS: ProductUnit[] = ["Piece", "KG", "Gram", "Liter", "ML", "Box", "Packet", "Dozen", "Bag", "Bottle", "Other"];
const GST_RATES: { label: string; value: GSTRate }[] = [
  { label: "No GST", value: "none" },
  { label: "5%", value: "5" },
  { label: "12%", value: "12" },
  { label: "18%", value: "18" },
  { label: "28%", value: "28" },
];

// Units that are naturally fractional — always allow decimals for stock
const FRACTIONAL_UNITS: ProductUnit[] = ["KG", "Gram", "Liter", "ML"];

type StockFilter = "ALL" | "LOW_STOCK" | "OUT_OF_STOCK";
type SortMode = "AZ" | "ZA" | "sellingPrice" | "costPrice" | "stock";

const emptyProduct = (): Product => ({
  name: "", category: "", unit: "Piece",
  sellingPrice: 0, costPrice: 0, gst: "none",
  trackInventory: true, stock: 0, minStockAlert: 0,
  safetyBuffer: { type: "fixed", value: 0 },
  sellInFraction: false, priceSlabs: [], barcode: "", hsn: "", taxInclusive: false,
});

// Whether a product should allow decimal stock entry
function allowsDecimal(p: Product): boolean {
  return p.sellInFraction || FRACTIONAL_UNITS.includes(p.unit);
}

function stockStep(p: Product): string {
  return allowsDecimal(p) ? "0.001" : "1";
}

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [form, setForm] = useState<Product>(emptyProduct());
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [stockFilter, setStockFilter] = useState<StockFilter>("ALL");
  const [sortBy, setSortBy] = useState<SortMode>("AZ");
  const [catFilter, setCatFilter] = useState("All");
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkPct, setBulkPct] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Product | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";
  const [stockModal, setStockModal] = useState<Product | null>(null);
  const [ledgerModal, setLedgerModal] = useState<Product | null>(null);
  const [page, setPage] = useState(1);
  const PER_PAGE = 25;

  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, "products"), orderBy("name")), (snap) => {
      const prods = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product));
      setProducts(prods);
      const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))];
      setCategories(cats);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  const { query: searchQuery, setQuery: setSearchQuery, results: searchResults } =
    useTamilSearch(products as unknown as Record<string, unknown>[], ["name", "category", "barcode"]);

  const filtered = useMemo(() => {
    let list = searchResults as unknown as Product[];
    if (catFilter !== "All") list = list.filter((p) => p.category === catFilter);
    switch (stockFilter) {
      case "LOW_STOCK":    list = list.filter((p) => p.trackInventory && p.stock > 0 && p.stock <= p.minStockAlert); break;
      case "OUT_OF_STOCK": list = list.filter((p) => p.trackInventory && p.stock <= 0); break;
    }
    const sorted = [...list];
    switch (sortBy) {
      case "AZ":           sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "ZA":           sorted.sort((a, b) => b.name.localeCompare(a.name)); break;
      case "sellingPrice": sorted.sort((a, b) => b.sellingPrice - a.sellingPrice); break;
      case "costPrice":    sorted.sort((a, b) => b.costPrice - a.costPrice); break;
      case "stock":        sorted.sort((a, b) => a.stock - b.stock); break;
    }
    return sorted;
  }, [searchResults, catFilter, stockFilter, sortBy]);

  useEffect(() => { setPage(1); }, [searchQuery, catFilter, stockFilter, sortBy]);

  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const lowStockCount   = products.filter((p) => p.trackInventory && p.stock > 0 && p.stock <= p.minStockAlert).length;
  const outOfStockCount = products.filter((p) => p.trackInventory && p.stock <= 0).length;
  const allCategories   = ["All", ...categories];
  const stockValue      = filtered.reduce((s, p) => s + (p.sellingPrice * p.stock), 0);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isFinite(form.sellingPrice) || form.sellingPrice < 0) {
      alert("Selling price must be a valid non-negative number."); return;
    }
    if (!isFinite(form.costPrice) || form.costPrice < 0) {
      alert("Cost price must be a valid non-negative number."); return;
    }
    if (form.trackInventory && (!isFinite(form.stock) || form.stock < 0)) {
      alert("Stock must be a valid non-negative number."); return;
    }
    if (!isFinite(form.minStockAlert) || form.minStockAlert < 0) {
      alert("Min stock alert must be a valid non-negative number."); return;
    }

    const now = new Date().toISOString();
    const data = { ...form, updatedAt: now };
    if (!data.createdAt) data.createdAt = now;
    if (editId) { await updateDoc(doc(db, "products", editId), { ...data }); }
    else { await addDoc(collection(db, "products"), data); }
    setForm(emptyProduct()); setEditId(null); setShowForm(false);
  };

  const handleEdit = (product: Product) => {
    setForm({ ...product, safetyBuffer: product.safetyBuffer || { type: "fixed", value: 0 }, priceSlabs: product.priceSlabs || [] });
    setEditId(product.id!); setShowForm(true);
  };

  const handleDelete = async (product: Product) => {
    await deleteDoc(doc(db, "products", product.id!));
    setDeleteConfirm(null);
  };

  const handleDuplicate = async (product: Product) => {
    const { id: _id, ...rest } = product;
    await addDoc(collection(db, "products"), { ...rest, name: `${product.name} (Copy)`, stock: 0, createdAt: new Date().toISOString() });
  };

  const handleBulkPrice = async () => {
    const pct = parseFloat(bulkPct);
    if (!pct) return alert("Enter a valid percentage");
    setBulkLoading(true);
    for (const p of filtered) {
      await updateDoc(doc(db, "products", p.id!), {
        sellingPrice: parseFloat((p.sellingPrice * (1 + pct / 100)).toFixed(2)),
        costPrice:    parseFloat((p.costPrice    * (1 + pct / 100)).toFixed(2)),
      });
    }
    setBulkLoading(false); setShowBulkModal(false); setBulkPct("");
  };

  const handleStockAdjust = async (product: Product, qty: number, reason: string, direction: "in" | "out") => {
    const newStock = direction === "in"
      ? parseFloat(((product.stock || 0) + qty).toFixed(4))
      : parseFloat((Math.max(0, (product.stock || 0) - qty)).toFixed(4));
    await updateDoc(doc(db, "products", product.id!), { stock: newStock, updatedAt: new Date().toISOString() });
    await addDoc(collection(db, "products", product.id!, "stockMovements"), {
      type: direction === "in" ? "manual_in" : "manual_out",
      direction, qty,
      stockBefore: product.stock || 0,
      stockAfter: newStock, reason,
      createdBy: user!.uid, createdByName: user!.name,
      createdAt: new Date().toISOString(),
    });
    setStockModal(null);
  };

  const handleExport = () => {
    const headers = ["Name","Category","Unit","SellingPrice","CostPrice","GST","HSN","Stock","MinStockAlert","SellInFraction","Barcode"];
    const rows = filtered.map((p) => [p.name, p.category, p.unit, p.sellingPrice, p.costPrice, p.gst, p.hsn || "", p.stock, p.minStockAlert, p.sellInFraction, p.barcode || ""]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "products.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      const lines = text.split("\n").filter(Boolean);
      const headers = lines[0].split(",");
      const rows = lines.slice(1).map((line) => {
        const vals = line.split(",");
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim() || ""; });
        return obj;
      });
      for (const row of rows) {
        if (!row.Name) continue;
        await addDoc(collection(db, "products"), {
          name: row.Name, category: row.Category || "", unit: row.Unit || "Piece",
          sellingPrice: parseFloat(row.SellingPrice) || 0,
          costPrice: parseFloat(row.CostPrice) || 0,
          gst: (row.GST as GSTRate) || "none", hsn: row.HSN || "",
          stock: parseFloat(row.Stock) || 0, minStockAlert: parseFloat(row.MinStockAlert) || 0,
          sellInFraction: row.SellInFraction === "true",
          trackInventory: true, priceSlabs: [], barcode: row.Barcode || "",
          createdAt: new Date().toISOString(),
        });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const addSlab = () => {
    const last = form.priceSlabs[form.priceSlabs.length - 1];
    const newMin = last ? (last.maxQty ?? 0) + 1 : 1;
    setForm({ ...form, priceSlabs: [...form.priceSlabs, { minQty: newMin, maxQty: null, price: 0 }] });
  };
  const updateSlab = (i: number, field: keyof PriceSlab, value: number | null) => {
    const slabs = [...form.priceSlabs];
    slabs[i] = { ...slabs[i], [field]: value };
    setForm({ ...form, priceSlabs: slabs });
  };
  const removeSlab = (i: number) => setForm({ ...form, priceSlabs: form.priceSlabs.filter((_, idx) => idx !== i) });

  const handleAddCategory = () => {
    if (newCategory.trim() && !categories.includes(newCategory.trim())) setCategories([...categories, newCategory.trim()]);
    setForm({ ...form, category: newCategory.trim() });
    setNewCategory(""); setShowNewCategory(false);
  };

  const margin = (p: Product) => p.costPrice > 0 ? (((p.sellingPrice - p.costPrice) / p.costPrice) * 100).toFixed(0) : null;

  // ── Format stock display with up to 3 decimal places, strip trailing zeros ─
  const fmtStock = (n: number) => {
    if (Number.isInteger(n)) return String(n);
    return parseFloat(n.toFixed(3)).toString();
  };

  return (
    <div className="p-3 md:p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Products</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            {products.length} products{isAdmin ? ` · Stock value ₹${stockValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })} (sell price)` : ""}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {isAdmin && (
            <>
              <button onClick={() => setShowBulkModal(true)} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">📊 Bulk Price</button>
              <button onClick={() => fileRef.current?.click()} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬆️ Import CSV</button>
              <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
              <button onClick={handleExport} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">⬇️ Export CSV</button>
              <button onClick={() => { setForm(emptyProduct()); setEditId(null); setShowForm(true); }}
                className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">+ Add Product</button>
            </>
          )}
          {!isAdmin && <span className="text-xs text-gray-400 bg-gray-100 px-3 py-2 rounded-lg">View Only</span>}
        </div>
      </div>

      {/* Search + Sort */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <TamilSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Search by name, category, barcode…"
          className="w-72"
        />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortMode)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="AZ">Sort: A → Z</option>
          <option value="ZA">Sort: Z → A</option>
          <option value="sellingPrice">Sort: Sell Price ↓</option>
          <option value="costPrice">Sort: Cost Price ↓</option>
          <option value="stock">Sort: Stock (low first)</option>
        </select>
      </div>

      {/* Stock Filter Chips */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {([
          { key: "ALL",          label: "All Products",                       color: "orange" },
          { key: "LOW_STOCK",    label: `⚠️ Low Stock (${lowStockCount})`,    color: "yellow" },
          { key: "OUT_OF_STOCK", label: `🔴 Out of Stock (${outOfStockCount})`, color: "red"  },
        ] as const).map(({ key, label, color }) => (
          <button key={key} onClick={() => setStockFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              stockFilter === key
                ? color === "orange" ? "bg-orange-100 text-orange-700 border-orange-300"
                : color === "yellow" ? "bg-yellow-100 text-yellow-700 border-yellow-300"
                : "bg-red-100 text-red-700 border-red-300"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
            }`}>{label}</button>
        ))}
      </div>

      {/* Category Chips */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {allCategories.map((c) => (
          <button key={c} onClick={() => setCatFilter(c)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              catFilter === c ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
            }`}>{c}</button>
        ))}
      </div>

      {/* Table */}
      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-4">Product</th>
                <th className="px-5 py-4">Category</th>
                <th className="px-5 py-4">Unit</th>
                <th className="px-5 py-4">Sell Price</th>
                {isAdmin && <th className="px-5 py-4">Cost Price</th>}
                <th className="px-5 py-4">HSN</th>
                <th className="px-5 py-4">GST</th>
                <th className="px-5 py-4">Stock</th>
                <th className="px-5 py-4">Slabs</th>
                {isAdmin && <th className="px-5 py-4">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {paginated.map((product) => {
                const isOut = product.trackInventory && product.stock <= 0;
                const isLow = product.trackInventory && product.stock > 0 && product.stock <= product.minStockAlert;
                const reserved = product.reservedStock || 0;
                const available = Math.max(0, product.stock - reserved);
                return (
                  <tr key={product.id} className={`hover:bg-gray-50 group ${isOut ? "opacity-60" : ""}`}>
                    <td className="px-5 py-4">
                      <p className="font-medium text-gray-800">{product.name}</p>
                      <div className="flex gap-1.5 mt-0.5 flex-wrap">
                        {product.sellInFraction && <span className="text-[10px] text-blue-500">Fractions</span>}
                        {FRACTIONAL_UNITS.includes(product.unit) && !product.sellInFraction && <span className="text-[10px] text-indigo-400">Decimal stock</span>}
                        {product.trackInventory  && <span className="text-[10px] text-green-500">Tracked</span>}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{product.category || "—"}</span>
                    </td>
                    <td className="px-5 py-4 text-gray-500 text-xs">{product.unit}</td>
                    <td className="px-5 py-4">
                      <span className="font-medium text-gray-800">₹{product.sellingPrice}</span>
                      {isAdmin && margin(product) && <span className="text-[10px] text-green-500 ml-1">+{margin(product)}%</span>}
                    </td>
                    {isAdmin && <td className="px-5 py-4 text-gray-500">₹{product.costPrice}</td>}
                    <td className="px-5 py-4 text-gray-500 text-xs">{product.hsn || "—"}</td>
                    <td className="px-5 py-4">
                      {product.gst === "none"
                        ? <span className="text-gray-400 text-xs">No GST</span>
                        : <div className="flex flex-col gap-0.5">
                            <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full w-fit">{product.gst}%</span>
                            <span className={`text-xs ${product.taxInclusive ? "text-blue-500" : "text-gray-400"}`}>
                              {product.taxInclusive ? "incl." : "excl."}
                            </span>
                          </div>}
                    </td>
                    <td className="px-5 py-4">
                      {product.trackInventory ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1">
                            {isOut
                              ? <span className="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full">Out</span>
                              : <span className={`font-bold text-base ${isLow ? "text-yellow-500" : "text-gray-800"}`}>{fmtStock(product.stock)}</span>}
                            {isLow && !isOut && <span title="Low stock">⚠️</span>}
                          </div>
                          {reserved > 0 && (
                            <div className="text-[10px] text-orange-500">
                              🔒 {fmtStock(reserved)} blocked · {fmtStock(available)} free
                            </div>
                          )}
                        </div>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-5 py-4 text-gray-500 text-xs">
                      {product.priceSlabs?.length > 0 ? `${product.priceSlabs.length} slabs` : "—"}
                    </td>
                    <td className="px-5 py-4">
                      {isAdmin && (
                        <div className="flex gap-1 flex-wrap opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                          <button onClick={() => handleEdit(product)} className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded hover:bg-blue-100">✏️ Edit</button>
                          <button onClick={() => handleDuplicate(product)} className="text-xs bg-gray-50 text-gray-600 px-2 py-1 rounded hover:bg-gray-100">📋 Copy</button>
                          {product.trackInventory && <button onClick={() => setStockModal(product)} className="text-xs bg-green-50 text-green-600 px-2 py-1 rounded hover:bg-green-100">📦 Stock</button>}
                          {product.trackInventory && <button onClick={() => setLedgerModal(product)} className="text-xs bg-purple-50 text-purple-600 px-2 py-1 rounded hover:bg-purple-100">📒 Ledger</button>}
                          <button onClick={() => setDeleteConfirm(product)} className="text-xs bg-red-50 text-red-500 px-2 py-1 rounded hover:bg-red-100">🗑️</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No products found.</div>}
          <Pagination total={filtered.length} page={page} perPage={PER_PAGE} onPage={setPage} />
          {isAdmin && filtered.length > 0 && (
            <div className="px-5 py-2 text-xs text-gray-400 text-right border-t border-gray-100">
              Stock value (sell price): ₹{stockValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </div>
          )}
        </div>
      )}

      {/* Product Form Modal */}
      {showForm && isAdmin && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-0 md:py-8 px-0 md:px-4">
          <div className="bg-white rounded-none md:rounded-2xl w-full max-w-2xl shadow-2xl min-h-screen md:min-h-0">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editId ? "Edit Product" : "Add New Product"}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <form onSubmit={handleSubmit} className="p-4 md:p-6 space-y-6">
              <Section title="Basic Information">
                <Field label="Product Name *">
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required placeholder="e.g. Basmati Rice" className={inputCls} />
                </Field>
                <Field label="Category *">
                  <select value={showNewCategory ? "__new__" : form.category}
                    onChange={(e) => { if (e.target.value === "__new__") setShowNewCategory(true); else { setForm({ ...form, category: e.target.value }); setShowNewCategory(false); } }}
                    className={inputCls}>
                    <option value="">-- Select Category --</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                    <option value="__new__">+ Create New Category</option>
                  </select>
                  {showNewCategory && (
                    <div className="flex gap-2 mt-2">
                      <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="New category name" className={inputCls} />
                      <button type="button" onClick={handleAddCategory} className="bg-orange-500 text-white px-3 py-2 rounded-lg text-sm whitespace-nowrap">Add</button>
                      <button type="button" onClick={() => setShowNewCategory(false)} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm">Cancel</button>
                    </div>
                  )}
                </Field>
                <Field label="Unit *">
                  <div className="flex flex-wrap gap-2">
                    {UNITS.map((u) => (
                      <button key={u} type="button" onClick={() => setForm({ ...form, unit: u })}
                        className={`px-3 py-1.5 rounded-lg text-sm border transition-all ${form.unit === u ? "bg-orange-500 text-white border-orange-500" : "border-gray-300 text-gray-600 hover:border-orange-300"}`}>{u}</button>
                    ))}
                  </div>
                  {FRACTIONAL_UNITS.includes(form.unit) && (
                    <p className="text-xs text-indigo-500 mt-1.5">ℹ️ {form.unit} automatically supports decimal stock quantities.</p>
                  )}
                </Field>
                <div className="flex items-center gap-3">
                  <Toggle checked={form.sellInFraction} onChange={(v) => setForm({ ...form, sellInFraction: v })} />
                  <div>
                    <p className="text-sm font-medium text-gray-700">Sell in Fractions</p>
                    <p className="text-xs text-gray-400">Allow order quantities like 0.5, 0.25, 1.5</p>
                  </div>
                </div>
                <Field label="Barcode (Optional)">
                  <input value={form.barcode || ""} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder="Scan or type barcode" className={inputCls} />
                </Field>
              </Section>

              <Section title="Pricing">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="Selling Price (₹) *">
                    <input type="number" min="0" step="0.01" value={form.sellingPrice}
                      onChange={(e) => setForm({ ...form, sellingPrice: Number(e.target.value) })} required className={inputCls} />
                  </Field>
                  <Field label="Cost Price (₹) *">
                    <input type="number" min="0" step="0.01" value={form.costPrice}
                      onChange={(e) => setForm({ ...form, costPrice: Number(e.target.value) })} required className={inputCls} />
                  </Field>
                </div>
                {form.costPrice > 0 && form.sellingPrice > 0 && (
                  <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 text-xs text-green-700">
                    Margin: ₹{(form.sellingPrice - form.costPrice).toFixed(2)} per unit ({(((form.sellingPrice - form.costPrice) / form.costPrice) * 100).toFixed(1)}%)
                  </div>
                )}
                <Field label="HSN Code (Optional)">
                  <input value={form.hsn || ""} onChange={(e) => setForm({ ...form, hsn: e.target.value })} placeholder="e.g. 1006 (for rice)" className={inputCls} />
                  <p className="text-xs text-gray-400 mt-1">Harmonised System of Nomenclature code for GST invoicing</p>
                </Field>
                <Field label="GST Rate *">
                  <div className="flex flex-wrap gap-2">
                    {GST_RATES.map((g) => (
                      <button key={g.value} type="button" onClick={() => setForm({ ...form, gst: g.value })}
                        className={`px-3 py-2 rounded-lg text-sm border transition-all ${form.gst === g.value ? "bg-orange-500 text-white border-orange-500" : "border-gray-300 text-gray-600 hover:border-orange-300"}`}>{g.label}</button>
                    ))}
                  </div>
                </Field>
                {form.gst !== "none" && (
                  <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-700">Tax Inclusive Price</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {form.taxInclusive
                          ? `Selling price ₹${form.sellingPrice} already includes GST — taxable base = ₹${form.sellingPrice > 0 ? (form.sellingPrice / (1 + parseFloat(form.gst) / 100)).toFixed(2) : "0.00"}`
                          : `Selling price ₹${form.sellingPrice} + ${form.gst}% GST = ₹${form.sellingPrice > 0 ? (form.sellingPrice * (1 + parseFloat(form.gst) / 100)).toFixed(2) : "0.00"} on bill`}
                      </p>
                    </div>
                    <button type="button" onClick={() => setForm({ ...form, taxInclusive: !form.taxInclusive })}
                      className={`relative w-12 h-6 rounded-full transition-colors flex-shrink-0 ${form.taxInclusive ? "bg-orange-500" : "bg-gray-300"}`}>
                      <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form.taxInclusive ? "translate-x-6" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                )}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-700">Quantity Price Slabs</label>
                    <button type="button" onClick={addSlab} className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-lg hover:bg-blue-100">+ Add Slab</button>
                  </div>
                  {form.priceSlabs.length === 0
                    ? <p className="text-xs text-gray-400 italic">No slabs — single price applies.</p>
                    : (
                      <>
                        <div className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 text-xs text-gray-400 px-1 mb-1">
                          <span>From qty</span><span>To qty (blank=∞)</span><span>Price ₹</span><span />
                        </div>
                        <div className="space-y-2">
                          {form.priceSlabs.map((slab, i) => (
                            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 items-center bg-gray-50 p-2 rounded-lg">
                              <input type="number" value={slab.minQty} onChange={(e) => updateSlab(i, "minQty", Number(e.target.value))} className="border border-gray-300 rounded px-2 py-1 text-sm" />
                              <input type="number" value={slab.maxQty ?? ""} onChange={(e) => updateSlab(i, "maxQty", e.target.value === "" ? null : Number(e.target.value))} placeholder="∞" className="border border-gray-300 rounded px-2 py-1 text-sm" />
                              <input type="number" value={slab.price} onChange={(e) => updateSlab(i, "price", Number(e.target.value))} className="border border-gray-300 rounded px-2 py-1 text-sm" />
                              <button type="button" onClick={() => removeSlab(i)} className="text-red-400 hover:text-red-600 text-lg flex items-center justify-center">✕</button>
                            </div>
                          ))}
                        </div>
                        {form.priceSlabs.length > 0 && (
                          <div className="mt-2 p-2 bg-blue-50 border border-blue-100 rounded-lg space-y-0.5">
                            <p className="text-[10px] text-blue-500 font-semibold uppercase">Preview</p>
                            {form.priceSlabs.map((s, i) => (
                              <p key={i} className="text-xs text-gray-600">{s.minQty} – {s.maxQty ?? "∞"} {form.unit} → ₹{s.price}</p>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                </div>
              </Section>

              <Section title="Inventory">
                <div className="flex items-center gap-3">
                  <Toggle checked={form.trackInventory} onChange={(v) => setForm({ ...form, trackInventory: v })} />
                  <div>
                    <p className="text-sm font-medium text-gray-700">Track Inventory</p>
                    <p className="text-xs text-gray-400">Monitor stock levels and get alerts</p>
                  </div>
                </div>
                {form.trackInventory && (
                  <div className="space-y-4 mt-2">
                    <Field label={`Current Stock Quantity${allowsDecimal(form) ? " (decimals supported)" : ""}`}>
                      <input
                        type="number" min="0"
                        step={stockStep(form)}
                        value={form.stock}
                        onChange={(e) => setForm({ ...form, stock: parseFloat(e.target.value) || 0 })}
                        className={inputCls}
                      />
                      {allowsDecimal(form) && (
                        <p className="text-xs text-indigo-500 mt-1">
                          You can enter decimal values like 2.5, 10.75, 0.250
                        </p>
                      )}
                    </Field>
                    <Field label="Minimum Stock Alert">
                      <input type="number" min="0" step={stockStep(form)} value={form.minStockAlert}
                        onChange={(e) => setForm({ ...form, minStockAlert: parseFloat(e.target.value) || 0 })} placeholder="Alert when stock falls below this" className={inputCls} />
                      <p className="text-xs text-gray-400 mt-1">⚠️ Warning shown when stock ≤ this value</p>
                    </Field>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Safety Buffer <span className="text-gray-400 font-normal">(Optional)</span></label>
                      <div className="flex gap-2 items-start">
                        <select value={form.safetyBuffer?.type || "fixed"}
                          onChange={(e) => setForm({ ...form, safetyBuffer: { type: e.target.value as "fixed" | "percentage", value: form.safetyBuffer?.value || 0 } })}
                          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-36">
                          <option value="fixed">Fixed Qty</option>
                          <option value="percentage">Percentage %</option>
                        </select>
                        <div className="flex-1">
                          <input type="number" min="0" step={form.safetyBuffer?.type === "percentage" ? "0.1" : stockStep(form)} value={form.safetyBuffer?.value || 0}
                            onChange={(e) => setForm({ ...form, safetyBuffer: { type: form.safetyBuffer?.type || "fixed", value: parseFloat(e.target.value) || 0 } })}
                            placeholder={form.safetyBuffer?.type === "percentage" ? "e.g. 10%" : "e.g. 5 units"} className={inputCls} />
                          <p className="text-xs text-gray-400 mt-1">{form.safetyBuffer?.type === "percentage" ? "Keep this % of stock as buffer" : "Keep this many units as buffer"}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 border border-gray-300 text-gray-600 py-3 rounded-xl text-sm hover:bg-gray-50">Cancel</button>
                <button type="submit" className="flex-1 bg-orange-500 text-white py-3 rounded-xl text-sm font-semibold hover:bg-orange-600">{editId ? "Update Product" : "Add Product"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Price Modal */}
      {showBulkModal && isAdmin && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-800 mb-1">Bulk Price Update</h3>
            <p className="text-sm text-gray-500 mb-4">Update prices for <strong>{filtered.length}</strong> currently filtered products.</p>
            <label className="block text-sm font-medium text-gray-700 mb-1">Change % <span className="text-gray-400">(positive = increase, negative = decrease)</span></label>
            <input type="number" value={bulkPct} onChange={(e) => setBulkPct(e.target.value)} placeholder="e.g. 10 or -5" className={inputCls} />
            <div className="flex gap-3 mt-4">
              <button onClick={() => setShowBulkModal(false)} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={handleBulkPrice} disabled={bulkLoading} className="flex-1 bg-orange-500 text-white py-2 rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50">
                {bulkLoading ? "Updating..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}

      {stockModal  && isAdmin && <StockAdjustModal  product={stockModal}  onClose={() => setStockModal(null)}  onAdjust={handleStockAdjust} />}
      {ledgerModal &&            <StockLedgerModal   product={ledgerModal} onClose={() => setLedgerModal(null)} />}
      {deleteConfirm && isAdmin && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Delete Product?</h3>
            <p className="text-sm text-gray-500 mb-5">Are you sure you want to delete <strong>{deleteConfirm.name}</strong>? This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirm(null)} className="flex-1 border border-gray-300 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button onClick={() => handleDelete(deleteConfirm)} className="flex-1 bg-red-500 text-white py-2 rounded-lg text-sm hover:bg-red-600">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-orange-500 uppercase tracking-wide mb-3 pb-1 border-b border-orange-100">{title}</h4>
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
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? "bg-orange-500" : "bg-gray-300"}`}>
      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${checked ? "left-6" : "left-1"}`} />
    </button>
  );
}

const inputCls = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300";

const FRACTIONAL_UNITS_LOCAL: ProductUnit[] = ["KG", "Gram", "Liter", "ML"];

function StockAdjustModal({ product, onClose, onAdjust }: {
  product: Product;
  onClose: () => void;
  onAdjust: (p: Product, qty: number, reason: string, dir: "in" | "out") => Promise<void>;
}) {
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [qty, setQty]             = useState("");
  const [reason, setReason]       = useState("");
  const [saving, setSaving]       = useState(false);
  const isDecimal = product.sellInFraction || FRACTIONAL_UNITS_LOCAL.includes(product.unit);
  const step = isDecimal ? "0.001" : "1";
  const parsedQty = parseFloat(qty) || 0;
  const preview = direction === "in"
    ? parseFloat(((product.stock || 0) + parsedQty).toFixed(4))
    : parseFloat((Math.max(0, (product.stock || 0) - parsedQty)).toFixed(4));

  const QUICK_REASONS: Record<"in" | "out", string[]> = {
    in:  ["New purchase / GRN", "Return from customer", "Stock correction", "Transfer in", "Opening stock"],
    out: ["Damage / expired", "Sample given", "Stock correction", "Transfer out", "Internal use"],
  };

  const handleSave = async () => {
    const q = parseFloat(qty);
    if (!q || q <= 0 || !reason.trim()) return;
    setSaving(true);
    await onAdjust(product, q, reason.trim(), direction);
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-1">Stock Adjustment</h3>
        <p className="text-sm text-gray-500 mb-4">
          {product.name} · Current: <strong>{parseFloat((product.stock || 0).toFixed(4))} {product.unit}</strong>
          {(product.reservedStock || 0) > 0 && (
            <span className="ml-2 text-orange-500 text-xs">🔒 {product.reservedStock} blocked in orders</span>
          )}
        </p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {(["in","out"] as const).map((d) => (
            <button key={d} onClick={() => setDirection(d)}
              className={`p-3 rounded-xl border-2 text-left transition-all ${direction === d ? (d === "in" ? "border-green-500 bg-green-50" : "border-red-400 bg-red-50") : "border-gray-200"}`}>
              <p className="font-semibold text-sm">{d === "in" ? "➕ Stock In" : "➖ Stock Out"}</p>
              <p className="text-xs text-gray-400 mt-0.5">{d === "in" ? "New goods arrived" : "Damaged / removed"}</p>
            </button>
          ))}
        </div>
        <div className="space-y-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Quantity ({product.unit}) *{isDecimal && <span className="text-indigo-500 font-normal ml-1">— decimals allowed</span>}
            </label>
            <input type="number" min="0.001" step={step}
              value={qty} onChange={(e) => setQty(e.target.value)} placeholder={isDecimal ? `e.g. 2.5 ${product.unit}` : `e.g. 50 ${product.unit}`}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason *</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {QUICK_REASONS[direction].map((r) => (
                <button key={r} type="button" onClick={() => setReason(r)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-all ${reason === r ? "bg-orange-100 text-orange-700 border-orange-300" : "bg-gray-50 text-gray-500 border-gray-200 hover:border-gray-300"}`}>
                  {r}
                </button>
              ))}
            </div>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type a custom reason…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
          </div>
        </div>
        {qty && !isNaN(parseFloat(qty)) && parseFloat(qty) > 0 && (
          <div className="bg-gray-50 rounded-lg px-4 py-3 mb-4 text-sm">
            Stock: <span className="font-bold">{product.stock}</span> → <span className={`font-bold ${direction === "in" ? "text-green-600" : "text-red-600"}`}>{preview} {product.unit}</span>
          </div>
        )}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm">Cancel</button>
          <button onClick={handleSave} disabled={saving || !qty || !reason.trim() || parseFloat(qty) <= 0}
            className={`flex-1 text-white py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50 ${direction === "in" ? "bg-green-500 hover:bg-green-600" : "bg-red-500 hover:bg-red-600"}`}>
            {saving ? "Saving..." : `Apply ${direction === "in" ? "Stock In" : "Stock Out"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Stock Ledger Modal ─────────────────────────────────────────────────────────
// Shows full stock history: manual in/out + order reservations/releases
// + which active orders are currently blocking stock
interface StockMovement {
  id: string;
  type: string;
  direction: "in" | "out";
  qty: number;
  stockBefore: number;
  stockAfter: number;
  reason?: string;
  createdByName?: string;
  createdAt: string;
  orderId?: string;
  orderNo?: string;
}

type LedgerTab = "history" | "blocked";

function StockLedgerModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [blockedOrders, setBlockedOrders] = useState<Order[]>([]);
  const [loading, setLoading]     = useState(true);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [tab, setTab]             = useState<LedgerTab>("history");

  useEffect(() => {
    // Load stock movements
    getDocs(query(collection(db, "products", product.id!, "stockMovements"), orderBy("createdAt", "desc")))
      .then((snap) => { setMovements(snap.docs.map((d) => ({ id: d.id, ...d.data() } as StockMovement))); setLoading(false); })
      .catch(() => setLoading(false));

    // Load orders that have this product and are not yet delivered/cancelled
    // Active statuses that block stock
    const activeStatuses = ["pending", "packed", "assigned", "out_for_delivery", "attempted", "returned_to_warehouse"];
    getDocs(query(collection(db, "orders"), where("status", "in", activeStatuses)))
      .then((snap) => {
        const orders = snap.docs
          .map((d) => ({ id: d.id, ...d.data() } as Order))
          .filter((o) => o.items?.some((item) => item.productId === product.id));
        setBlockedOrders(orders);
        setOrdersLoading(false);
      })
      .catch(() => setOrdersLoading(false));
  }, [product.id]);

  const TYPE_LABELS: Record<string, string> = {
    manual_in:       "Stock In",
    manual_out:      "Stock Out",
    order_placed:    "Order Reserved",
    order_cancelled: "Order Released",
    order_delivered: "Delivered",
  };

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const fmtQty = (n: number) => parseFloat(n.toFixed(4)).toString();

  const STATUS_COLORS: Record<string, string> = {
    pending:               "bg-yellow-100 text-yellow-700",
    packed:                "bg-blue-100 text-blue-700",
    assigned:              "bg-indigo-100 text-indigo-700",
    out_for_delivery:      "bg-purple-100 text-purple-700",
    attempted:             "bg-orange-100 text-orange-700",
    returned_to_warehouse: "bg-gray-100 text-gray-700",
  };

  const totalBlocked = blockedOrders.reduce((sum, o) => {
    const item = o.items?.find((i) => i.productId === product.id);
    return sum + (item?.quantity || 0);
  }, 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">{product.name}</h3>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              <span className="text-sm text-gray-500">
                Total stock: <strong>{fmtQty(product.stock || 0)} {product.unit}</strong>
              </span>
              {totalBlocked > 0 && (
                <>
                  <span className="text-sm text-orange-500">
                    🔒 Blocked: <strong>{fmtQty(totalBlocked)} {product.unit}</strong>
                  </span>
                  <span className="text-sm text-green-600">
                    ✅ Available: <strong>{fmtQty(Math.max(0, (product.stock || 0) - totalBlocked))} {product.unit}</strong>
                  </span>
                </>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl flex-shrink-0">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-0 border-b border-gray-100 px-6">
          {([
            { key: "history", label: "📋 Stock Ledger" },
            { key: "blocked", label: `🔒 Blocked in Orders${blockedOrders.length > 0 ? ` (${blockedOrders.length})` : ""}` },
          ] as const).map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-all -mb-px ${tab === key ? "border-orange-500 text-orange-600" : "border-transparent text-gray-400 hover:text-gray-600"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {tab === "history" && (
            loading
              ? <div className="text-center py-10 text-gray-400">Loading...</div>
              : movements.length === 0
                ? <div className="text-center py-16 text-gray-400"><p className="text-3xl mb-2">📭</p><p>No stock history yet</p></div>
                : (
                  <table className="w-full text-sm min-w-[500px]">
                    <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide sticky top-0">
                      <tr>
                        <th className="px-5 py-3 text-left">Date & Time</th>
                        <th className="px-5 py-3 text-left">Type</th>
                        <th className="px-5 py-3 text-left">Reason / By</th>
                        <th className="px-5 py-3 text-right">Qty</th>
                        <th className="px-5 py-3 text-right">Before</th>
                        <th className="px-5 py-3 text-right">After</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {movements.map((m) => (
                        <tr key={m.id} className="hover:bg-gray-50">
                          <td className="px-5 py-3 text-gray-500 text-xs whitespace-nowrap">
                            {fmtDate(m.createdAt)}
                          </td>
                          <td className="px-5 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                              m.direction === "in"
                                ? "bg-green-100 text-green-700"
                                : "bg-red-100 text-red-700"
                            }`}>
                              {TYPE_LABELS[m.type] ?? m.type}
                            </span>
                            {m.orderNo && (
                              <p className="text-[10px] text-blue-500 mt-0.5">Order #{m.orderNo}</p>
                            )}
                          </td>
                          <td className="px-5 py-3 text-gray-600 text-xs">
                            <p className="font-medium">{String(m.reason ?? "—")}</p>
                            {m.createdByName && <p className="text-gray-400">by {m.createdByName}</p>}
                          </td>
                          <td className={`px-5 py-3 text-right font-semibold ${m.direction === "in" ? "text-green-600" : "text-red-600"}`}>
                            {m.direction === "in" ? "+" : "−"}{fmtQty(m.qty)}
                          </td>
                          <td className="px-5 py-3 text-right text-gray-400 text-xs">{fmtQty(m.stockBefore)}</td>
                          <td className="px-5 py-3 text-right font-medium text-gray-800">{fmtQty(m.stockAfter)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
          )}

          {tab === "blocked" && (
            ordersLoading
              ? <div className="text-center py-10 text-gray-400">Loading...</div>
              : blockedOrders.length === 0
                ? (
                  <div className="text-center py-16 text-gray-400">
                    <p className="text-3xl mb-2">✅</p>
                    <p className="font-medium text-gray-500">No stock blocked</p>
                    <p className="text-xs mt-1">All stock is available — no active orders for this product</p>
                  </div>
                )
                : (
                  <div className="p-5 space-y-3">
                    {/* Summary bar */}
                    <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-orange-700">
                          🔒 {fmtQty(totalBlocked)} {product.unit} blocked across {blockedOrders.length} order{blockedOrders.length > 1 ? "s" : ""}
                        </p>
                        <p className="text-xs text-orange-500 mt-0.5">
                          Available stock: {fmtQty(Math.max(0, (product.stock || 0) - totalBlocked))} {product.unit}
                        </p>
                      </div>
                    </div>

                    {/* Orders list */}
                    {blockedOrders.map((order) => {
                      const item = order.items?.find((i) => i.productId === product.id);
                      if (!item) return null;
                      return (
                        <div key={order.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:border-orange-200 transition-colors">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-gray-800 text-sm">
                                  {order.orderNo ? `#${order.orderNo}` : `Order ${order.id?.slice(-6)}`}
                                </span>
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[order.status] ?? "bg-gray-100 text-gray-600"}`}>
                                  {order.status.replace(/_/g, " ")}
                                </span>
                              </div>
                              <p className="text-sm text-gray-600 mt-1">{order.customerName}</p>
                              {order.customerArea && <p className="text-xs text-gray-400">{order.customerArea}</p>}
                              <div className="flex gap-4 mt-2 text-xs text-gray-500 flex-wrap">
                                <span>🧑 Agent: {order.agentName}</span>
                                {order.deliveryPersonName && <span>🚚 {order.deliveryPersonName}</span>}
                                <span>📅 {new Date(order.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className="text-lg font-bold text-orange-600">{fmtQty(item.quantity)}</p>
                              <p className="text-xs text-gray-400">{product.unit}</p>
                              <p className="text-xs text-gray-500 mt-0.5">₹{item.total?.toFixed(2)}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
          )}
        </div>
      </div>
    </div>
  );
}