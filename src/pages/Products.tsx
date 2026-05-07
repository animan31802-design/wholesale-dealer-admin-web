import { useEffect, useState, useMemo, useRef } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  deleteDoc, doc, orderBy, query
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Product, PriceSlab, ProductUnit, GSTRate } from "../types";

const UNITS: ProductUnit[] = ["Piece", "KG", "Gram", "Liter", "ML", "Box", "Packet", "Dozen", "Bag", "Bottle", "Other"];
const GST_RATES: { label: string; value: GSTRate }[] = [
  { label: "No GST", value: "none" },
  { label: "5%", value: "5" },
  { label: "12%", value: "12" },
  { label: "18%", value: "18" },
  { label: "28%", value: "28" },
];

type StockFilter = "ALL" | "LOW_STOCK" | "OUT_OF_STOCK";
type SortMode = "AZ" | "ZA" | "sellingPrice" | "costPrice" | "stock";

const emptyProduct = (): Product => ({
  name: "", category: "", unit: "Piece",
  sellingPrice: 0, costPrice: 0, gst: "none",
  trackInventory: true, stock: 0, minStockAlert: 0,
  safetyBuffer: { type: "fixed", value: 0 },
  sellInFraction: false, priceSlabs: [], barcode: "",
});

export default function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [form, setForm] = useState<Product>(emptyProduct());
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("ALL");
  const [sortBy, setSortBy] = useState<SortMode>("AZ");
  const [catFilter, setCatFilter] = useState("All");
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkPct, setBulkPct] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Product | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchProducts = async () => {
    const snap = await getDocs(query(collection(db, "products"), orderBy("name")));
    const prods = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product));
    setProducts(prods);
    const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))];
    setCategories(cats);
    setLoading(false);
  };

  useEffect(() => { fetchProducts(); }, []);

  // ── Filtering & Sorting ──
  const filtered = useMemo(() => {
    let list = [...products];
    if (searchTerm) list = list.filter((p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.category || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.barcode || "").includes(searchTerm)
    );
    if (catFilter !== "All") list = list.filter((p) => p.category === catFilter);
    switch (stockFilter) {
      case "LOW_STOCK":    list = list.filter((p) => p.trackInventory && p.stock > 0 && p.stock <= p.minStockAlert); break;
      case "OUT_OF_STOCK": list = list.filter((p) => p.trackInventory && p.stock <= 0); break;
    }
    switch (sortBy) {
      case "AZ":           list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case "ZA":           list.sort((a, b) => b.name.localeCompare(a.name)); break;
      case "sellingPrice": list.sort((a, b) => b.sellingPrice - a.sellingPrice); break;
      case "costPrice":    list.sort((a, b) => b.costPrice - a.costPrice); break;
      case "stock":        list.sort((a, b) => a.stock - b.stock); break;
    }
    return list;
  }, [products, searchTerm, catFilter, stockFilter, sortBy]);

  const lowStockCount   = products.filter((p) => p.trackInventory && p.stock > 0 && p.stock <= p.minStockAlert).length;
  const outOfStockCount = products.filter((p) => p.trackInventory && p.stock <= 0).length;
  const allCategories   = ["All", ...categories];
  const stockValue      = filtered.reduce((s, p) => s + (p.costPrice * p.stock), 0);

  // ── CRUD ──
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date().toISOString();
    const data = { ...form, updatedAt: now };
    if (!data.createdAt) data.createdAt = now;
    if (editId) { await updateDoc(doc(db, "products", editId), { ...data }); }
    else { await addDoc(collection(db, "products"), data); }
    setForm(emptyProduct()); setEditId(null); setShowForm(false);
    fetchProducts();
  };

  const handleEdit = (product: Product) => {
    setForm({ ...product, safetyBuffer: product.safetyBuffer || { type: "fixed", value: 0 }, priceSlabs: product.priceSlabs || [] });
    setEditId(product.id!); setShowForm(true);
  };

  const handleDelete = async (product: Product) => {
    await deleteDoc(doc(db, "products", product.id!));
    setDeleteConfirm(null);
    fetchProducts();
  };

  const handleDuplicate = async (product: Product) => {
    const { id, ...rest } = product;
    await addDoc(collection(db, "products"), { ...rest, name: `${product.name} (Copy)`, stock: 0, createdAt: new Date().toISOString() });
    fetchProducts();
  };

  // ── Bulk Price Update ──
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
    fetchProducts();
  };

  // ── Export CSV ──
  const handleExport = () => {
    const headers = ["Name","Category","Unit","SellingPrice","CostPrice","GST","Stock","MinStockAlert","SellInFraction","Barcode"];
    const rows = filtered.map((p) => [
      p.name, p.category, p.unit, p.sellingPrice, p.costPrice,
      p.gst, p.stock, p.minStockAlert, p.sellInFraction, p.barcode || ""
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "products.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Import CSV ──
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
          gst: (row.GST as GSTRate) || "none",
          stock: parseFloat(row.Stock) || 0,
          minStockAlert: parseFloat(row.MinStockAlert) || 0,
          sellInFraction: row.SellInFraction === "true",
          trackInventory: true, priceSlabs: [],
          barcode: row.Barcode || "",
          createdAt: new Date().toISOString(),
        });
      }
      fetchProducts(); alert(`Imported ${rows.length} products`);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── Price Slabs ──
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

  const margin = (p: Product) => p.costPrice > 0
    ? (((p.sellingPrice - p.costPrice) / p.costPrice) * 100).toFixed(0) : null;

  return (
    <div className="p-8">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Products</h2>
          <p className="text-sm text-gray-400 mt-0.5">{products.length} products · Stock value ₹{stockValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowBulkModal(true)} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">
            📊 Bulk Price
          </button>
          <button onClick={() => fileRef.current?.click()} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">
            ⬆️ Import CSV
          </button>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
          <button onClick={handleExport} className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm hover:bg-gray-50">
            ⬇️ Export CSV
          </button>
          <button onClick={() => { setForm(emptyProduct()); setEditId(null); setShowForm(true); }}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600">
            + Add Product
          </button>
        </div>
      </div>

      {/* ── Search + Sort ── */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by name, category, barcode..."
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-orange-400" />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortMode)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300">
          <option value="AZ">Sort: A → Z</option>
          <option value="ZA">Sort: Z → A</option>
          <option value="sellingPrice">Sort: Sell Price ↓</option>
          <option value="costPrice">Sort: Cost Price ↓</option>
          <option value="stock">Sort: Stock (low first)</option>
        </select>
      </div>

      {/* ── Stock Filter Chips ── */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {([
          { key: "ALL", label: "All Products", color: "orange" },
          { key: "LOW_STOCK", label: `⚠️ Low Stock (${lowStockCount})`, color: "yellow" },
          { key: "OUT_OF_STOCK", label: `🔴 Out of Stock (${outOfStockCount})`, color: "red" },
        ] as const).map(({ key, label, color }) => (
          <button key={key} onClick={() => setStockFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              stockFilter === key
                ? color === "orange" ? "bg-orange-100 text-orange-700 border-orange-300"
                : color === "yellow" ? "bg-yellow-100 text-yellow-700 border-yellow-300"
                : "bg-red-100 text-red-700 border-red-300"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Category Chips ── */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {allCategories.map((c) => (
          <button key={c} onClick={() => setCatFilter(c)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              catFilter === c
                ? "bg-gray-800 text-white border-gray-800"
                : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
            }`}>
            {c}
          </button>
        ))}
      </div>

      {/* ── Table ── */}
      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-5 py-4">Product</th>
                <th className="px-5 py-4">Category</th>
                <th className="px-5 py-4">Unit</th>
                <th className="px-5 py-4">Sell Price</th>
                <th className="px-5 py-4">Cost Price</th>
                <th className="px-5 py-4">GST</th>
                <th className="px-5 py-4">Stock</th>
                <th className="px-5 py-4">Slabs</th>
                <th className="px-5 py-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((product) => {
                const isOut = product.trackInventory && product.stock <= 0;
                const isLow = product.trackInventory && product.stock > 0 && product.stock <= product.minStockAlert;
                return (
                  <tr key={product.id} className={`hover:bg-gray-50 group ${isOut ? "opacity-60" : ""}`}>
                    <td className="px-5 py-4">
                      <p className="font-medium text-gray-800">{product.name}</p>
                      <div className="flex gap-1.5 mt-0.5">
                        {product.sellInFraction && <span className="text-[10px] text-blue-500">Fractions</span>}
                        {product.trackInventory  && <span className="text-[10px] text-green-500">Tracked</span>}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <span className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{product.category || "—"}</span>
                    </td>
                    <td className="px-5 py-4 text-gray-500 text-xs">{product.unit}</td>
                    <td className="px-5 py-4">
                      <span className="font-medium text-gray-800">₹{product.sellingPrice}</span>
                      {margin(product) && <span className="text-[10px] text-green-500 ml-1">+{margin(product)}%</span>}
                    </td>
                    <td className="px-5 py-4 text-gray-500">₹{product.costPrice}</td>
                    <td className="px-5 py-4">
                      {product.gst === "none"
                        ? <span className="text-gray-400 text-xs">No GST</span>
                        : <span className="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">{product.gst}%</span>}
                    </td>
                    <td className="px-5 py-4">
                      {product.trackInventory ? (
                        <div className="flex items-center gap-1">
                          {isOut
                            ? <span className="bg-red-100 text-red-600 text-xs px-2 py-0.5 rounded-full">Out</span>
                            : <span className={`font-bold text-base ${isLow ? "text-yellow-500" : "text-gray-800"}`}>{product.stock}</span>}
                          {isLow && !isOut && <span title="Low stock">⚠️</span>}
                        </div>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-5 py-4 text-gray-500 text-xs">
                      {product.priceSlabs?.length > 0 ? `${product.priceSlabs.length} slabs` : "—"}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => handleEdit(product)}
                          className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded hover:bg-blue-100">✏️ Edit</button>
                        <button onClick={() => handleDuplicate(product)}
                          className="text-xs bg-gray-50 text-gray-600 px-2 py-1 rounded hover:bg-gray-100">📋 Copy</button>
                        <button onClick={() => setDeleteConfirm(product)}
                          className="text-xs bg-red-50 text-red-500 px-2 py-1 rounded hover:bg-red-100">🗑️</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No products found.</div>}
          {filtered.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 flex justify-between text-xs text-gray-400">
              <span>Showing {filtered.length} of {products.length} products</span>
              <span>Stock value (cost): ₹{stockValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Product Form Modal ── */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editId ? "Edit Product" : "Add New Product"}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-6">

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
                        className={`px-3 py-1.5 rounded-lg text-sm border transition-all ${form.unit === u ? "bg-orange-500 text-white border-orange-500" : "border-gray-300 text-gray-600 hover:border-orange-300"}`}>
                        {u}
                      </button>
                    ))}
                  </div>
                </Field>
                <div className="flex items-center gap-3">
                  <Toggle checked={form.sellInFraction} onChange={(v) => setForm({ ...form, sellInFraction: v })} />
                  <div>
                    <p className="text-sm font-medium text-gray-700">Sell in Fractions</p>
                    <p className="text-xs text-gray-400">Allow quantities like 0.5, 0.25, 1.5</p>
                  </div>
                </div>
                <Field label="Barcode (Optional)">
                  <input value={form.barcode || ""} onChange={(e) => setForm({ ...form, barcode: e.target.value })} placeholder="Scan or type barcode" className={inputCls} />
                </Field>
              </Section>

              <Section title="Pricing">
                <div className="grid grid-cols-2 gap-4">
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
                    Margin: ₹{(form.sellingPrice - form.costPrice).toFixed(2)} per unit
                    ({(((form.sellingPrice - form.costPrice) / form.costPrice) * 100).toFixed(1)}%)
                  </div>
                )}
                <Field label="GST Rate *">
                  <div className="flex flex-wrap gap-2">
                    {GST_RATES.map((g) => (
                      <button key={g.value} type="button" onClick={() => setForm({ ...form, gst: g.value })}
                        className={`px-3 py-2 rounded-lg text-sm border transition-all ${form.gst === g.value ? "bg-orange-500 text-white border-orange-500" : "border-gray-300 text-gray-600 hover:border-orange-300"}`}>
                        {g.label}
                      </button>
                    ))}
                  </div>
                </Field>
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
                    <Field label="Current Stock Quantity">
                      <input type="number" min="0" step={form.sellInFraction ? "0.01" : "1"} value={form.stock}
                        onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })} className={inputCls} />
                    </Field>
                    <Field label="Minimum Stock Alert">
                      <input type="number" min="0" value={form.minStockAlert}
                        onChange={(e) => setForm({ ...form, minStockAlert: Number(e.target.value) })} placeholder="Alert when stock falls below this" className={inputCls} />
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
                          <input type="number" min="0" step={form.safetyBuffer?.type === "percentage" ? "0.1" : "1"} value={form.safetyBuffer?.value || 0}
                            onChange={(e) => setForm({ ...form, safetyBuffer: { type: form.safetyBuffer?.type || "fixed", value: Number(e.target.value) } })}
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

      {/* ── Bulk Price Modal ── */}
      {showBulkModal && (
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

      {/* ── Delete Confirm Modal ── */}
      {deleteConfirm && (
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