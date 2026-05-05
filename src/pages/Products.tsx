import { useEffect, useState } from "react";
import {
  collection, getDocs, addDoc, updateDoc,
  deleteDoc, doc, orderBy, query
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Product, PriceSlab, ProductUnit, GSTRate } from "../types";

const UNITS: ProductUnit[] = ["Piece", "KG", "Gram", "Liter", "ML", "Box", "Packet", "Dozen", "Bag", "Bottle", "Other"];
const GST_RATES: { label: string; value: GSTRate }[] = [
  { label: "No GST (0%)", value: "none" },
  { label: "5%", value: "5" },
  { label: "12%", value: "12" },
  { label: "18%", value: "18" },
  { label: "28%", value: "28" },
];

const emptyProduct = (): Product => ({
  name: "",
  category: "",
  unit: "Piece",
  sellingPrice: 0,
  costPrice: 0,
  gst: "none",
  trackInventory: true,
  stock: 0,
  minStockAlert: 0,
  safetyBuffer: { type: "fixed", value: 0 },
  sellInFraction: false,
  priceSlabs: [],
  barcode: "",
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

  const fetchProducts = async () => {
    const snap = await getDocs(query(collection(db, "products"), orderBy("name")));
    const prods = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product));
    setProducts(prods);
    // Extract unique categories
    const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))];
    setCategories(cats);
    setLoading(false);
  };

  useEffect(() => { fetchProducts(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date().toISOString();
    const data = { ...form, updatedAt: now };
    if (!data.createdAt) data.createdAt = now;

    if (editId) {
      await updateDoc(doc(db, "products", editId), { ...data });
    } else {
      await addDoc(collection(db, "products"), data);
    }
    setForm(emptyProduct());
    setEditId(null);
    setShowForm(false);
    fetchProducts();
  };

  const handleEdit = (product: Product) => {
    setForm({
      ...product,
      safetyBuffer: product.safetyBuffer || { type: "fixed", value: 0 },
      priceSlabs: product.priceSlabs || [],
    });
    setEditId(product.id!);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this product?")) return;
    await deleteDoc(doc(db, "products", id));
    fetchProducts();
  };

  // Price Slabs
  const addSlab = () => {
    const lastSlab = form.priceSlabs[form.priceSlabs.length - 1];
    const newMin = lastSlab ? (lastSlab.maxQty ?? 0) + 1 : 1;
    setForm({
      ...form,
      priceSlabs: [...form.priceSlabs, { minQty: newMin, maxQty: null, price: 0 }],
    });
  };

  const updateSlab = (index: number, field: keyof PriceSlab, value: number | null) => {
    const slabs = [...form.priceSlabs];
    slabs[index] = { ...slabs[index], [field]: value };
    setForm({ ...form, priceSlabs: slabs });
  };

  const removeSlab = (index: number) => {
    setForm({ ...form, priceSlabs: form.priceSlabs.filter((_, i) => i !== index) });
  };

  const handleAddCategory = () => {
    if (newCategory.trim() && !categories.includes(newCategory.trim())) {
      setCategories([...categories, newCategory.trim()]);
    }
    setForm({ ...form, category: newCategory.trim() });
    setNewCategory("");
    setShowNewCategory(false);
  };

  const filtered = products.filter((p) =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.category.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getLowStockColor = (product: Product) => {
    if (!product.trackInventory) return "";
    if (product.stock <= product.minStockAlert) return "text-red-500 font-semibold";
    return "text-green-600";
  };

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Products</h2>
        <button
          onClick={() => { setForm(emptyProduct()); setEditId(null); setShowForm(true); }}
          className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600"
        >
          + Add Product
        </button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by name or category..."
          className="border border-gray-300 rounded-lg px-4 py-2 text-sm w-full max-w-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
        />
      </div>

      {/* Table */}
      {loading ? <p className="text-gray-400">Loading...</p> : (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-5 py-4">Name</th>
                <th className="px-5 py-4">Category</th>
                <th className="px-5 py-4">Unit</th>
                <th className="px-5 py-4">Selling Price</th>
                <th className="px-5 py-4">Cost Price</th>
                <th className="px-5 py-4">GST</th>
                <th className="px-5 py-4">Stock</th>
                <th className="px-5 py-4">Slabs</th>
                <th className="px-5 py-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((product) => (
                <tr key={product.id} className="hover:bg-gray-50">
                  <td className="px-5 py-4 font-medium text-gray-800">
                    {product.name}
                    {product.sellInFraction && <span className="ml-1 text-xs text-blue-500">(fraction)</span>}
                  </td>
                  <td className="px-5 py-4 text-gray-600">{product.category || "-"}</td>
                  <td className="px-5 py-4 text-gray-600">{product.unit}</td>
                  <td className="px-5 py-4 text-gray-800">₹{product.sellingPrice}</td>
                  <td className="px-5 py-4 text-gray-600">₹{product.costPrice}</td>
                  <td className="px-5 py-4 text-gray-600">{product.gst === "none" ? "No GST" : `${product.gst}%`}</td>
                  <td className={`px-5 py-4 ${getLowStockColor(product)}`}>
                    {product.trackInventory ? product.stock : "—"}
                    {product.trackInventory && product.stock <= product.minStockAlert && (
                      <span className="ml-1 text-red-500">⚠️</span>
                    )}
                  </td>
                  <td className="px-5 py-4 text-gray-600">{product.priceSlabs.length > 0 ? `${product.priceSlabs.length} slabs` : "—"}</td>
                  <td className="px-5 py-4 flex gap-2">
                    <button onClick={() => handleEdit(product)} className="text-blue-500 hover:underline text-xs">Edit</button>
                    <button onClick={() => handleDelete(product.id!)} className="text-red-500 hover:underline text-xs">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="text-center py-12 text-gray-400">No products found.</div>}
        </div>
      )}

      {/* Product Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 overflow-y-auto py-8 px-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-800">{editId ? "Edit Product" : "Add New Product"}</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <form onSubmit={handleSubmit} className="p-6 space-y-6">

              {/* ── BASIC INFO ── */}
              <Section title="Basic Information">
                {/* Name */}
                <Field label="Product Name *">
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    required placeholder="e.g. Basmati Rice"
                    className={inputCls} />
                </Field>

                {/* Category */}
                <Field label="Category *">
                  <div className="flex gap-2">
                    <select
                      value={showNewCategory ? "__new__" : form.category}
                      onChange={(e) => {
                        if (e.target.value === "__new__") { setShowNewCategory(true); }
                        else { setForm({ ...form, category: e.target.value }); setShowNewCategory(false); }
                      }}
                      className={inputCls}
                    >
                      <option value="">-- Select Category --</option>
                      {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                      <option value="__new__">+ Create New Category</option>
                    </select>
                  </div>
                  {showNewCategory && (
                    <div className="flex gap-2 mt-2">
                      <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
                        placeholder="New category name"
                        className={inputCls} />
                      <button type="button" onClick={handleAddCategory}
                        className="bg-orange-500 text-white px-3 py-2 rounded-lg text-sm whitespace-nowrap">Add</button>
                      <button type="button" onClick={() => setShowNewCategory(false)}
                        className="border border-gray-300 text-gray-600 px-3 py-2 rounded-lg text-sm">Cancel</button>
                    </div>
                  )}
                </Field>

                {/* Unit */}
                <Field label="Unit *">
                  <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value as ProductUnit })} className={inputCls}>
                    {UNITS.map((u) => <option key={u}>{u}</option>)}
                  </select>
                </Field>

                {/* Sell in Fraction */}
                <div className="flex items-center gap-3">
                  <Toggle
                    checked={form.sellInFraction}
                    onChange={(v) => setForm({ ...form, sellInFraction: v })}
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-700">Sell in Fractions</p>
                    <p className="text-xs text-gray-400">Allow quantities like 0.5, 0.25, 1.5</p>
                  </div>
                </div>

                {/* Barcode */}
                <Field label="Barcode (Optional)">
                  <input value={form.barcode || ""} onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                    placeholder="Scan or type barcode"
                    className={inputCls} />
                </Field>
              </Section>

              {/* ── PRICING ── */}
              <Section title="Pricing">
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Selling Price (₹) *">
                    <input type="number" min="0" step="0.01" value={form.sellingPrice}
                      onChange={(e) => setForm({ ...form, sellingPrice: Number(e.target.value) })}
                      required className={inputCls} />
                  </Field>
                  <Field label="Cost Price (₹) *">
                    <input type="number" min="0" step="0.01" value={form.costPrice}
                      onChange={(e) => setForm({ ...form, costPrice: Number(e.target.value) })}
                      required className={inputCls} />
                  </Field>
                </div>

                {/* GST */}
                <Field label="GST Rate *">
                  <div className="flex flex-wrap gap-2">
                    {GST_RATES.map((g) => (
                      <button key={g.value} type="button"
                        onClick={() => setForm({ ...form, gst: g.value })}
                        className={`px-3 py-2 rounded-lg text-sm border transition-all ${
                          form.gst === g.value
                            ? "bg-orange-500 text-white border-orange-500"
                            : "border-gray-300 text-gray-600 hover:border-orange-300"
                        }`}>
                        {g.label}
                      </button>
                    ))}
                  </div>
                </Field>

                {/* Price Slabs */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-gray-700">Quantity Price Slabs</label>
                    <button type="button" onClick={addSlab}
                      className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-lg hover:bg-blue-100">
                      + Add Slab
                    </button>
                  </div>
                  {form.priceSlabs.length === 0 && (
                    <p className="text-xs text-gray-400 italic">No slabs — single selling price applies. Add slabs for quantity-based pricing.</p>
                  )}
                  <div className="space-y-2">
                    {form.priceSlabs.map((slab, i) => (
                      <div key={i} className="flex items-center gap-2 bg-gray-50 p-3 rounded-lg">
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">Min Qty</label>
                          <input type="number" value={slab.minQty}
                            onChange={(e) => updateSlab(i, "minQty", Number(e.target.value))}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm mt-1" />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">Max Qty (blank = above)</label>
                          <input type="number" value={slab.maxQty ?? ""}
                            onChange={(e) => updateSlab(i, "maxQty", e.target.value === "" ? null : Number(e.target.value))}
                            placeholder="∞"
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm mt-1" />
                        </div>
                        <div className="flex-1">
                          <label className="text-xs text-gray-500">Price (₹)</label>
                          <input type="number" value={slab.price}
                            onChange={(e) => updateSlab(i, "price", Number(e.target.value))}
                            className="w-full border border-gray-300 rounded px-2 py-1 text-sm mt-1" />
                        </div>
                        <button type="button" onClick={() => removeSlab(i)}
                          className="text-red-400 hover:text-red-600 mt-4 text-lg">✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>

              {/* ── INVENTORY ── */}
              <Section title="Inventory">
                {/* Track Inventory Toggle */}
                <div className="flex items-center gap-3">
                  <Toggle
                    checked={form.trackInventory}
                    onChange={(v) => setForm({ ...form, trackInventory: v })}
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-700">Track Inventory</p>
                    <p className="text-xs text-gray-400">Monitor stock levels and get alerts</p>
                  </div>
                </div>

                {form.trackInventory && (
                  <div className="space-y-4 mt-2">
                    {/* Current Stock */}
                    <Field label="Current Stock Quantity">
                      <input type="number" min="0" step={form.sellInFraction ? "0.01" : "1"}
                        value={form.stock}
                        onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
                        className={inputCls} />
                    </Field>

                    {/* Min Stock Alert */}
                    <Field label="Minimum Stock Alert">
                      <input type="number" min="0" value={form.minStockAlert}
                        onChange={(e) => setForm({ ...form, minStockAlert: Number(e.target.value) })}
                        placeholder="Alert when stock falls below this"
                        className={inputCls} />
                      <p className="text-xs text-gray-400 mt-1">⚠️ Warning shown when stock ≤ this value</p>
                    </Field>

                    {/* Safety Buffer */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Safety Buffer <span className="text-gray-400 font-normal">(Optional)</span>
                      </label>
                      <div className="flex gap-2 items-start">
                        <select
                          value={form.safetyBuffer?.type || "fixed"}
                          onChange={(e) => setForm({
                            ...form,
                            safetyBuffer: { type: e.target.value as "fixed" | "percentage", value: form.safetyBuffer?.value || 0 }
                          })}
                          className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-36"
                        >
                          <option value="fixed">Fixed Qty</option>
                          <option value="percentage">Percentage %</option>
                        </select>
                        <div className="flex-1">
                          <input
                            type="number" min="0"
                            step={form.safetyBuffer?.type === "percentage" ? "0.1" : "1"}
                            value={form.safetyBuffer?.value || 0}
                            onChange={(e) => setForm({
                              ...form,
                              safetyBuffer: { type: form.safetyBuffer?.type || "fixed", value: Number(e.target.value) }
                            })}
                            placeholder={form.safetyBuffer?.type === "percentage" ? "e.g. 10 %" : "e.g. 5 units"}
                            className={inputCls}
                          />
                          <p className="text-xs text-gray-400 mt-1">
                            {form.safetyBuffer?.type === "percentage"
                              ? "Keep this % of stock as buffer"
                              : "Keep this many units as buffer"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Section>

              {/* Submit */}
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)}
                  className="flex-1 border border-gray-300 text-gray-600 py-3 rounded-xl text-sm hover:bg-gray-50">
                  Cancel
                </button>
                <button type="submit"
                  className="flex-1 bg-orange-500 text-white py-3 rounded-xl text-sm font-semibold hover:bg-orange-600">
                  {editId ? "Update Product" : "Add Product"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helper Components ──

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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? "bg-orange-500" : "bg-gray-300"}`}
    >
      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${checked ? "left-6" : "left-1"}`} />
    </button>
  );
}

const inputCls = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300";
