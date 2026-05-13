import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  collection, getDocs, addDoc, query, orderBy,
  doc, runTransaction, onSnapshot,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer, Product, Order, OrderItem } from "../types";
import { useAuthStore } from "../store/authStore";

// ─── Helpers ──────────────────────────────────────────────────────

function getSlabPrice(product: Product, qty: number): number {
  if (!product.priceSlabs || product.priceSlabs.length === 0) return product.sellingPrice;
  for (const slab of product.priceSlabs) {
    if (qty >= slab.minQty && (slab.maxQty === null || qty <= slab.maxQty)) return slab.price;
  }
  return product.sellingPrice;
}

function availableQty(p: Product): number {
  if (!p.trackInventory) return Infinity;
  const buf =
    p.safetyBuffer?.type === "fixed"
      ? p.safetyBuffer.value
      : ((p.safetyBuffer?.value ?? 0) / 100) * p.stock;
  return Math.max(0, p.stock - (p.reservedStock ?? 0) - buf);
}

function gstRate(p: Product): number {
  return p.gst === "none" || !p.gst ? 0 : parseFloat(p.gst);
}

function fmtPrice(v: number): string { return Number(v).toFixed(2); }
function fmtQty(v: number): string   { return Number.isInteger(v) ? String(v) : v.toFixed(2); }
function round2(v: number): number   { return Math.round(v * 100) / 100; }
function fmtRupees(v: number): string { return `₹${fmtPrice(v)}`; }

// Module-level draft store — survives re-renders, cleared on order save
const draftStore: Record<string, Record<string, number>> = {};

// ─── Qty Dialog ───────────────────────────────────────────────────

function QtyDialog({
  product, currentQty, onConfirm, onDismiss,
}: {
  product: Product; currentQty: number;
  onConfirm: (qty: number) => void; onDismiss: () => void;
}) {
  const [input, setInput] = useState(currentQty > 0 ? fmtQty(currentQty) : "");
  const qty       = parseFloat(input) || 0;
  const avail     = availableQty(product);
  const slabPrice = getSlabPrice(product, qty);
  const availText = product.trackInventory ? fmtQty(avail) : "∞";

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]"
      onClick={onDismiss}
    >
      <div
        className="bg-white rounded-2xl p-6 w-80 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="font-semibold text-gray-800 mb-0.5 truncate">{product.name}</p>
        <p className="text-xs text-gray-400 mb-4">Set quantity ({product.unit})</p>

        <div className="relative mb-2">
          <input
            autoFocus
            type="number"
            step={product.sellInFraction ? "0.1" : "1"}
            min="0"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full text-lg px-3 py-2.5 pr-14 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-300"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
            {product.unit}
          </span>
        </div>

        <p className="text-xs text-gray-400 mb-2">Available: {availText} {product.unit}</p>

        {product.priceSlabs.length > 0 && qty > 0 && (
          <p className="text-xs font-medium text-orange-600 mb-1">
            Price for {fmtQty(qty)} {product.unit}: ₹{fmtPrice(slabPrice)}
            {slabPrice !== product.sellingPrice ? " (slab)" : ""}
          </p>
        )}
        {product.priceSlabs.length > 0 && (
          <p className="text-xs text-gray-400 mb-4">
            {product.priceSlabs.map((s, i) => (
              <span key={i} className="mr-2">
                {fmtQty(s.minQty)}{s.maxQty != null ? `–${fmtQty(s.maxQty)}` : "+"}: ₹{fmtPrice(s.price)}
              </span>
            ))}
          </p>
        )}

        <div className="flex gap-2 mt-4">
          <button onClick={onDismiss}
            className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
            Cancel
          </button>
          <button
            disabled={!input || qty <= 0}
            onClick={() => {
              const capped = product.trackInventory ? Math.min(qty, avail) : qty;
              onConfirm(capped);
            }}
            className="flex-[2] bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-40"
          >
            Set Qty
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Back/Draft Dialog ────────────────────────────────────────────

function BackDraftDialog({
  customerName, onSave, onDiscard, onCancel,
}: {
  customerName: string; onSave: () => void; onDiscard: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-2xl p-6 w-80 shadow-2xl">
        <p className="font-semibold text-gray-800 mb-2">Save cart as draft?</p>
        <p className="text-sm text-gray-500 mb-5 leading-relaxed">
          You have items in the cart for <strong>{customerName}</strong>.{" "}
          Save as draft to continue this bill later?
        </p>
        <div className="flex flex-col gap-2">
          <button onClick={onSave}
            className="w-full bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600">
            Save Draft
          </button>
          <button onClick={onDiscard}
            className="w-full border border-red-200 text-red-500 py-2.5 rounded-xl text-sm hover:bg-red-50">
            Discard &amp; Go Back
          </button>
          <button onClick={onCancel}
            className="w-full text-gray-400 py-2 text-sm hover:text-gray-600">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Product Row ──────────────────────────────────────────────────

function ProductRow({
  product, qtyInCart, onAdd, onRemove, onQtyTapped,
}: {
  product: Product; qtyInCart: number;
  onAdd: () => void; onRemove: () => void; onQtyTapped: () => void;
}) {
  const avail       = availableQty(product);
  const outOfStock  = product.trackInventory && avail <= 0;
  const atLimit     = product.trackInventory && qtyInCart >= avail;
  const lowStock    = product.trackInventory && avail <= product.minStockAlert && avail > 0;
  const gst         = gstRate(product);
  const displayPrice = getSlabPrice(product, Math.max(qtyInCart, 1));
  const activePrice  = qtyInCart > 0 ? getSlabPrice(product, qtyInCart) : null;
  const lineTotal    = activePrice ? activePrice * qtyInCart : 0;
  const gstAmt       = lineTotal * gst / 100;

  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0">
      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm text-gray-800 mb-0.5 truncate">{product.name}</p>
        <p className={`text-xs ${lowStock ? "text-red-500" : "text-gray-400"}`}>
          ₹{fmtPrice(displayPrice)} / {product.unit}
          {" · "}
          {product.trackInventory ? `Stock: ${fmtQty(avail)}` : "Stock: ∞"}
          {gst > 0 && ` · GST ${gst}%`}
        </p>

        {/* Active slab price hint */}
        {product.priceSlabs.length > 0 && qtyInCart > 0 && activePrice !== product.sellingPrice && (
          <p className="text-xs text-orange-600 font-medium mt-0.5">
            Slab: ₹{fmtPrice(activePrice!)} for {fmtQty(qtyInCart)} {product.unit}
          </p>
        )}
        {/* Slab tiers when nothing in cart */}
        {product.priceSlabs.length > 0 && qtyInCart === 0 && (
          <p className="text-xs text-orange-400 mt-0.5">
            {product.priceSlabs.map((s, i) => (
              <span key={i} className="mr-2">
                {fmtQty(s.minQty)}{s.maxQty != null ? `–${fmtQty(s.maxQty)}` : "+"}: ₹{fmtPrice(s.price)}
              </span>
            ))}
          </p>
        )}
        {product.category && (
          <p className="text-xs text-orange-500 mt-0.5">{product.category}</p>
        )}
      </div>

      {/* Controls */}
      {qtyInCart > 0 ? (
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <button onClick={onRemove}
              className="w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center font-bold text-gray-600 hover:bg-gray-100">
              −
            </button>
            <button onClick={onQtyTapped}
              className="min-w-[38px] h-7 px-2 rounded-lg bg-orange-100 text-orange-700 font-bold text-sm">
              {fmtQty(qtyInCart)}
            </button>
            <button onClick={onAdd} disabled={atLimit}
              className="w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-30">
              +
            </button>
          </div>
          <p className="text-xs font-semibold text-orange-600">
            {gst > 0 ? `${fmtRupees(lineTotal + gstAmt)} incl. GST` : fmtRupees(lineTotal)}
          </p>
        </div>
      ) : (
        <button onClick={onAdd} disabled={outOfStock}
          className="px-4 py-1.5 rounded-lg border-2 border-orange-400 text-orange-600 text-sm font-semibold hover:bg-orange-50 disabled:opacity-30 disabled:border-gray-200 disabled:text-gray-400 whitespace-nowrap">
          {outOfStock ? "Out of stock" : "Add"}
        </button>
      )}
    </div>
  );
}

// ─── Cart Item Row ────────────────────────────────────────────────

function CartItemRow({
  item, index, onDecrease, onIncrease, onRemove, onQtyTapped,
}: {
  item: OrderItem; index: number;
  onDecrease: () => void; onIncrease: () => void;
  onRemove: () => void; onQtyTapped: () => void;
}) {
  const gstPct = parseFloat(item.gst ?? "0") || 0;
  const gstAmt = item.total * gstPct / 100;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 mb-2 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-gray-800 mb-1">
            <span className="text-gray-400 mr-1">{index + 1}.</span>
            {item.productName}
          </p>
          <p className="text-xs text-gray-400">
            ₹{fmtPrice(item.price)} × {fmtQty(item.quantity)} {item.unit} = ₹{fmtPrice(item.total)}
          </p>
          {gstAmt > 0 && (
            <p className="text-xs text-gray-300 mt-0.5">
              GST {item.gst}% = ₹{fmtPrice(gstAmt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={onDecrease}
            className="w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center font-bold text-gray-600 hover:bg-gray-100">
            −
          </button>
          <button onClick={onQtyTapped}
            className="min-w-[36px] h-7 px-2 rounded-lg bg-orange-100 text-orange-700 font-bold text-sm">
            {fmtQty(item.quantity)}
          </button>
          <button onClick={onIncrease}
            className="w-7 h-7 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center font-bold text-gray-600 hover:bg-gray-100">
            +
          </button>
          <button onClick={onRemove}
            className="w-7 h-7 flex items-center justify-center text-red-400 hover:text-red-600 text-base ml-1">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page Component ──────────────────────────────────────────

export default function CreateOrderPage() {
  const { user } = useAuthStore();

  type Step = "select-customer" | "billing";
  const [step, setStep]     = useState<Step>("select-customer");
  const [view, setView]     = useState<"products" | "cart">("products");

  // Firestore data
  const [customers, setCustomers]   = useState<Customer[]>([]);
  const [products, setProducts]     = useState<Product[]>([]);
  const [loading, setLoading]       = useState(true);
  const [frequentIds, setFrequentIds] = useState<string[]>([]);

  // Billing state
  const [customer, setCustomer]     = useState<Customer | null>(null);
  const [cartQty, setCartQty]       = useState<Record<string, number>>({});
  const [paidAmount, setPaidAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash"|"upi"|"bank"|"credit">("cash");
  const [notes, setNotes]           = useState("");
  const [message, setMessage]       = useState("");
  const [isSaving, setIsSaving]     = useState(false);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);

  // UI state
  const [searchQuery, setSearchQuery]           = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [sortMode, setSortMode]                 = useState<"frequent"|"name">("frequent");
  const [qtyDialogProduct, setQtyDialogProduct] = useState<Product | null>(null);
  const [showBackDialog, setShowBackDialog]     = useState(false);
  const [draftWarnings, setDraftWarnings]       = useState<string[]>([]);
  const [customerSearch, setCustomerSearch]     = useState("");

  const searchRef = useRef<HTMLInputElement>(null);

  // ── Load customers, products, frequent ids ──────────────────────
  useEffect(() => {
    let unsubProducts: (() => void) | null = null;

    const init = async () => {
      setLoading(true);
      try {
        const [custSnap, ordersSnap] = await Promise.all([
          getDocs(query(collection(db, "customers"), orderBy("shopName"))),
          getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"))),
        ]);

        setCustomers(custSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer)));

        // Compute frequent product ids from last 100 orders
        const freq: Record<string, number> = {};
        ordersSnap.docs.slice(0, 100).forEach((d) => {
          const o = d.data() as Order;
          o.items?.forEach((item) => {
            freq[item.productId] = (freq[item.productId] ?? 0) + (item.quantity ?? 1);
          });
        });
        setFrequentIds(
          Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([id]) => id)
        );
      } finally {
        setLoading(false);
      }
    };

    // Real-time products so stock is always live
    unsubProducts = onSnapshot(
      query(collection(db, "products"), orderBy("name")),
      (snap) => setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product)))
    );

    init();
    return () => { unsubProducts?.(); };
  }, []);

  useEffect(() => {
    if (step === "billing") setTimeout(() => searchRef.current?.focus(), 80);
  }, [step]);

  // ── Derived lists ────────────────────────────────────────────────
  const categories = useMemo(
    () => ["All", ...Array.from(new Set(products.map((p) => p.category).filter(Boolean)))],
    [products]
  );

  const filteredProducts = useMemo(() => {
    let list = products;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.category || "").toLowerCase().includes(q) ||
          (p.barcode || "").includes(q)
      );
    } else if (selectedCategory !== "All") {
      list = list.filter((p) => p.category === selectedCategory);
    }

    if (sortMode === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));

    // Frequent-first
    const freqSet = new Set(frequentIds);
    const freq = frequentIds.map((id) => list.find((p) => p.id === id)).filter(Boolean) as Product[];
    const rest = list.filter((p) => !freqSet.has(p.id!)).sort((a, b) => a.name.localeCompare(b.name));
    return [...freq, ...rest];
  }, [products, searchQuery, selectedCategory, sortMode, frequentIds]);

  const frequentProducts = useMemo(
    () => products.filter((p) => frequentIds.includes(p.id!)),
    [products, frequentIds]
  );

  const showFrequentRow =
    sortMode === "frequent" && !searchQuery.trim() && selectedCategory === "All" && frequentProducts.length > 0;

  // ── Bill calculation ─────────────────────────────────────────────
  const billItems = useMemo<OrderItem[]>(() => {
    return products
      .filter((p) => (cartQty[p.id!] ?? 0) > 0)
      .map((p) => {
        const qty   = cartQty[p.id!];
        const price = getSlabPrice(p, qty);
        const total = price * qty;
        const gst   = p.gst === "none" ? undefined : p.gst;
        return {
          productId:    p.id!,
          productName:  p.name,
          price,
          unit:         p.unit,
          quantity:     qty,
          total,
          hsn:          p.hsn,
          gst,
          taxInclusive: p.taxInclusive,
        } as OrderItem;
      });
  }, [cartQty, products]);

  const itemsTotal = useMemo(() => billItems.reduce((s, i) => s + i.total, 0), [billItems]);
  const gstTotal   = useMemo(() =>
    billItems.reduce((s, i) => s + i.total * (parseFloat(i.gst ?? "0") || 0) / 100, 0),
    [billItems]
  );
  const grandTotal = useMemo(() => itemsTotal + gstTotal, [itemsTotal, gstTotal]);
  const prevBalance = customer?.outstandingDue ?? 0;
  const totalOwed  = useMemo(() => grandTotal + prevBalance, [grandTotal, prevBalance]);
  const cartCount  = useMemo(() => Object.values(cartQty).reduce((s, v) => s + v, 0), [cartQty]);

  const paymentSuggestions = useMemo(() => {
    const fa = round2(totalOwed);
    const opts = [fa];
    [2000, 1000, 500].forEach((v) => { if (v < fa) opts.push(v); });
    return opts;
  }, [totalOwed]);

  // ── Cart actions ─────────────────────────────────────────────────
  const addToCart = useCallback((product: Product) => {
    const cur   = cartQty[product.id!] ?? 0;
    const avail = availableQty(product);
    if (product.trackInventory && cur >= avail) return;
    if (product.sellInFraction && cur === 0) { setQtyDialogProduct(product); return; }
    setCartQty((prev) => ({ ...prev, [product.id!]: cur + 1 }));
  }, [cartQty]);

  const removeFromCart = useCallback((product: Product) => {
    const cur = cartQty[product.id!] ?? 0;
    if (cur <= 1) {
      setCartQty((prev) => { const n = { ...prev }; delete n[product.id!]; return n; });
    } else {
      setCartQty((prev) => ({ ...prev, [product.id!]: cur - 1 }));
    }
  }, [cartQty]);

  const removeItem = useCallback((productId: string) => {
    setCartQty((prev) => { const n = { ...prev }; delete n[productId]; return n; });
  }, []);

  // ── Save order to Firestore (transactional) ──────────────────────
  const handleSaveOrder = async () => {
    if (!customer || !user) return;
    if (billItems.length === 0) { setMessage("Add at least one product"); return; }
    const paid = parseFloat(paidAmount);
    if (isNaN(paid))    { setMessage("Enter a valid paid amount"); return; }
    if (paid < 0)        { setMessage("Amount cannot be negative"); return; }
    if (paid > totalOwed + 0.01) { setMessage("Amount exceeds total payable"); return; }

    setIsSaving(true);
    setMessage("");

    try {
      let newOrderId = "";

      await runTransaction(db, async (t) => {
        // ── READ PHASE: verify stock live ─────────────────────────
        const productRefs  = billItems.map((item) => doc(db, "products", item.productId));
        const productSnaps = await Promise.all(productRefs.map((ref) => t.get(ref)));

        productSnaps.forEach((snap, i) => {
          const item = billItems[i];
          const data = snap.data() as Product | undefined;
          if (!data) throw new Error(`Product "${item.productName}" not found`);
          if (data.trackInventory) {
            const avail = availableQty({ ...data, id: snap.id });
            if (item.quantity > avail + 0.01)
              throw new Error(`"${item.productName}" only has ${fmtQty(avail)} ${item.unit} in stock`);
          }
        });

        // ── WRITE PHASE ───────────────────────────────────────────
        // Reserve stock
        productSnaps.forEach((snap, i) => {
          const data = snap.data() as Product;
          if (!data.trackInventory) return;
          t.update(productRefs[i], {
            reservedStock: (data.reservedStock ?? 0) + billItems[i].quantity,
          });
        });

        // Build order doc
        const orderPayload: Omit<Order, "id"> = {
          customerId:      customer.id!,
          customerName:    customer.shopName,
          customerAddress: customer.address,
          customerPhone:   customer.phone,
          customerLat:     customer.lat,
          customerLng:     customer.lng,
          agentId:         user.uid,
          agentName:       user.name,
          regionId:        customer.regionId,
          regionName:      customer.regionName,
          items:           billItems,
          totalAmount:     round2(totalOwed),
          status:          "pending",
          amountCollected: paid,
          paymentMode,
          notes:           notes.trim() || undefined,
          createdAt:       new Date().toISOString(),
        };

        const orderRef = doc(collection(db, "orders"));
        newOrderId     = orderRef.id;
        t.set(orderRef, orderPayload);

        // Update customer outstanding due
        const newDue = round2(prevBalance + grandTotal - paid);
        t.update(doc(db, "customers", customer.id!), { outstandingDue: newDue });
      });

      // Success
      delete draftStore[customer.id!];
      setLastOrderId(newOrderId);
      setCartQty({});
      setPaidAmount("");
      setNotes("");
      setMessage("✓ Order placed successfully");
      resetBilling();
    } catch (err: any) {
      setMessage(`Error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  // ── Navigation helpers ───────────────────────────────────────────
  const resetBilling = () => {
    setStep("select-customer");
    setCustomer(null);
    setView("products");
    setSearchQuery("");
    setSelectedCategory("All");
    setSortMode("frequent");
    setPaidAmount("");
    setNotes("");
    setDraftWarnings([]);
  };

  const handleBack = () => {
    if (Object.keys(cartQty).length === 0) {
      delete draftStore[customer?.id ?? ""];
      resetBilling();
    } else {
      setShowBackDialog(true);
    }
  };

  const handleSaveDraft = () => {
    if (customer) draftStore[customer.id!] = { ...cartQty };
    setShowBackDialog(false);
    setCartQty({});
    resetBilling();
  };

  const handleSelectCustomer = (c: Customer) => {
    setCustomer(c);
    setStep("billing");
    setView("products");
    setSearchQuery("");
    setSelectedCategory("All");
    setSortMode("frequent");
    setPaidAmount("");
    setNotes("");
    setMessage("");
    setDraftWarnings([]);

    // Restore draft with live stock validation
    const draft = draftStore[c.id!];
    if (draft && Object.keys(draft).length > 0) {
      const warnings: string[] = [];
      const restored: Record<string, number> = {};

      Object.entries(draft).forEach(([pid, qty]) => {
        const p = products.find((x) => x.id === pid);
        if (!p) { warnings.push("⚠ A product was removed from catalogue"); return; }
        if (!p.trackInventory) { restored[pid] = qty; return; }
        const avail = availableQty(p);
        if (avail <= 0) { warnings.push(`⚠ "${p.name}" removed from draft — out of stock`); return; }
        if (qty > avail) {
          restored[pid] = avail;
          warnings.push(`⚠ "${p.name}" qty reduced ${fmtQty(qty)}→${fmtQty(avail)} (stock limit)`);
          return;
        }
        restored[pid] = qty;
      });

      setCartQty(restored);
      setDraftWarnings(warnings);
    } else {
      setCartQty({});
    }
  };

  const filteredCustomers = useMemo(() => {
    if (!customerSearch.trim()) return customers;
    const q = customerSearch.toLowerCase();
    return customers.filter(
      (c) =>
        c.shopName.toLowerCase().includes(q) ||
        c.ownerName.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        c.area.toLowerCase().includes(q)
    );
  }, [customers, customerSearch]);

  // ─── CUSTOMER SELECTION SCREEN ────────────────────────────────────

  if (step === "select-customer") {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Create Order</h2>
            <p className="text-sm text-gray-400 mt-0.5">Select a customer to begin billing</p>
          </div>
        </div>

        {/* Success banner */}
        {lastOrderId && (
          <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-xl px-4 py-3 mb-5">
            <span className="text-green-500 text-lg">✓</span>
            <div>
              <p className="text-sm font-semibold text-green-700">Order placed successfully!</p>
              <p className="text-xs text-green-500">Order ID: {lastOrderId.slice(0, 12)}…</p>
            </div>
          </div>
        )}

        {/* Customer search */}
        <div className="relative mb-4">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          <input
            type="text"
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
            placeholder="Search by shop, owner, phone, area…"
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-gray-50"
          />
          {customerSearch && (
            <button onClick={() => setCustomerSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              ✕
            </button>
          )}
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-400 text-sm">Loading customers…</div>
        ) : (
          <div className="flex flex-col gap-2">
            {filteredCustomers.length === 0 && (
              <div className="text-center py-12 text-gray-400 text-sm">No customers found.</div>
            )}
            {filteredCustomers.map((c) => (
              <button
                key={c.id}
                onClick={() => handleSelectCustomer(c)}
                className="bg-white rounded-xl border border-gray-100 px-5 py-4 text-left hover:border-orange-300 hover:bg-orange-50/30 transition-all shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-800">{c.shopName}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{c.ownerName} · {c.phone}</p>
                    <p className="text-xs text-gray-400">{c.area}{c.regionName ? ` · ${c.regionName}` : ""}</p>
                  </div>
                  <div className="text-right flex-shrink-0 ml-4">
                    {(c.outstandingDue ?? 0) > 0 && (
                      <p className="text-xs font-semibold text-red-500">Due: ₹{fmtPrice(c.outstandingDue!)}</p>
                    )}
                    {draftStore[c.id!] && Object.keys(draftStore[c.id!] ?? {}).length > 0 && (
                      <p className="text-xs text-orange-500 mt-1">📋 Draft saved</p>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── BILLING SCREEN ───────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">

      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 max-w-3xl mx-auto">
          <button onClick={handleBack}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 flex-shrink-0">
            ←
          </button>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-gray-800 truncate">{customer?.shopName}</p>
            {prevBalance > 0 && (
              <p className="text-xs text-red-500">Previous balance: ₹{fmtPrice(prevBalance)}</p>
            )}
          </div>
          {/* Cart / Products toggle */}
          <button
            onClick={() => { setView(view === "products" ? "cart" : "products"); setMessage(""); }}
            className={`relative px-4 py-2 rounded-xl text-sm font-semibold transition-all flex-shrink-0 ${
              view === "cart"
                ? "bg-orange-500 text-white"
                : "bg-orange-50 text-orange-600 border border-orange-200"
            }`}
          >
            {view === "cart" ? "← Products" : `Cart ${fmtRupees(grandTotal)}`}
            {cartCount > 0 && view === "products" && (
              <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-xs font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1">
                {fmtQty(cartCount)}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Banners ── */}
      {draftWarnings.length > 0 && (
        <div className="bg-red-50 border-b border-red-100 px-4 py-3 flex gap-3 max-w-3xl mx-auto w-full">
          <div className="flex-1">
            <p className="text-xs font-semibold text-red-600 mb-1">📋 Draft restored — some items adjusted:</p>
            {draftWarnings.map((w, i) => <p key={i} className="text-xs text-red-500">{w}</p>)}
          </div>
          <button onClick={() => setDraftWarnings([])} className="text-red-400 hover:text-red-600">✕</button>
        </div>
      )}
      {draftWarnings.length === 0 && customer && draftStore[customer.id!] && cartCount > 0 && (
        <div className="bg-green-50 border-b border-green-100 px-4 py-2">
          <p className="text-xs text-green-600 max-w-3xl mx-auto">📋 Draft restored — prices updated to current rates</p>
        </div>
      )}
      {message && (
        <div className={`px-4 py-2.5 border-b text-sm font-medium ${
          message.startsWith("✓")
            ? "bg-green-50 border-green-100 text-green-700"
            : "bg-red-50 border-red-100 text-red-600"
        }`}>
          <p className="max-w-3xl mx-auto">{message}</p>
        </div>
      )}

      {/* ── PRODUCTS VIEW ── */}
      {view === "products" && (
        <div className="flex-1 flex flex-col overflow-hidden max-w-3xl mx-auto w-full">
          {/* Search */}
          <div className="px-4 py-3 relative">
            <span className="absolute left-7 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSelectedCategory("All"); }}
              placeholder="Search product, category, barcode…"
              className="w-full pl-8 pr-8 py-2.5 border border-gray-200 rounded-xl bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")}
                className="absolute right-7 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                ✕
              </button>
            )}
          </div>

          {/* Filter chips */}
          <div className="flex gap-2 px-4 pb-2 overflow-x-auto">
            {(["frequent", "name"] as const).map((m) => (
              <button key={m} onClick={() => setSortMode(m)}
                className={`px-3 py-1 rounded-full text-xs font-medium border whitespace-nowrap transition-all ${
                  sortMode === m
                    ? "bg-orange-500 text-white border-orange-500"
                    : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                }`}>
                {m === "frequent" ? "Most sold" : "A→Z"}
              </button>
            ))}
            <div className="w-px bg-gray-200 mx-1 self-stretch" />
            {categories.map((cat) => (
              <button key={cat} onClick={() => { setSelectedCategory(cat); setSearchQuery(""); }}
                className={`px-3 py-1 rounded-full text-xs font-medium border whitespace-nowrap transition-all ${
                  selectedCategory === cat
                    ? "bg-orange-500 text-white border-orange-500"
                    : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                }`}>
                {cat}
              </button>
            ))}
          </div>

          {/* Frequently sold chips */}
          {showFrequentRow && (
            <>
              <p className="text-xs font-semibold text-orange-500 px-4 pt-1 pb-1">Frequently sold</p>
              <div className="flex gap-2 px-4 pb-3 overflow-x-auto">
                {frequentProducts.map((p) => {
                  const avail    = availableQty(p);
                  const disabled = p.trackInventory && avail <= (cartQty[p.id!] ?? 0);
                  return (
                    <button key={p.id} onClick={() => addToCart(p)} disabled={disabled}
                      className="bg-white border border-gray-100 rounded-xl p-2.5 text-left min-w-[110px] hover:border-orange-200 shadow-sm disabled:opacity-40 flex-shrink-0">
                      <p className="text-xs font-medium text-gray-800 truncate max-w-[100px]">{p.name}</p>
                      <p className="text-xs text-gray-400">₹{fmtPrice(getSlabPrice(p, 1))}</p>
                      {(cartQty[p.id!] ?? 0) > 0 && (
                        <p className="text-xs text-orange-500 mt-0.5">In cart: {fmtQty(cartQty[p.id!])}</p>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="border-b border-gray-100 mx-4" />
            </>
          )}

          {/* Product list */}
          <div className="flex-1 overflow-y-auto px-4">
            {filteredProducts.length === 0 && searchQuery ? (
              <div className="text-center py-16 text-gray-400 text-sm">
                No products found for "{searchQuery}"
              </div>
            ) : (
              filteredProducts.map((p) => (
                <ProductRow
                  key={p.id}
                  product={p}
                  qtyInCart={cartQty[p.id!] ?? 0}
                  onAdd={() => addToCart(p)}
                  onRemove={() => removeFromCart(p)}
                  onQtyTapped={() => setQtyDialogProduct(p)}
                />
              ))
            )}
          </div>
        </div>
      )}

      {/* ── CART VIEW ── */}
      {view === "cart" && (
        <div className="flex-1 overflow-y-auto px-4 py-4 max-w-3xl mx-auto w-full">
          {billItems.length === 0 ? (
            <div className="text-center py-20 text-gray-400">
              <p className="text-4xl mb-3">🛒</p>
              <p className="font-medium text-gray-600">Cart is empty</p>
              <p className="text-sm mt-1">Go back to Products and add items</p>
              <button onClick={() => setView("products")}
                className="mt-5 px-6 py-2.5 bg-orange-500 text-white rounded-xl text-sm font-semibold hover:bg-orange-600">
                Browse Products
              </button>
            </div>
          ) : (
            <>
              {/* Cart items */}
              {billItems.map((item, i) => (
                <CartItemRow
                  key={item.productId}
                  item={item}
                  index={i}
                  onDecrease={() => {
                    const cur = cartQty[item.productId] ?? 1;
                    if (cur <= 1) removeItem(item.productId);
                    else setCartQty((prev) => ({ ...prev, [item.productId]: cur - 1 }));
                  }}
                  onIncrease={() => {
                    const p   = products.find((x) => x.id === item.productId);
                    const cur = cartQty[item.productId] ?? 1;
                    if (p && (!p.trackInventory || cur < availableQty(p)))
                      setCartQty((prev) => ({ ...prev, [item.productId]: cur + 1 }));
                  }}
                  onRemove={() => removeItem(item.productId)}
                  onQtyTapped={() => {
                    const p = products.find((x) => x.id === item.productId);
                    if (p) setQtyDialogProduct(p);
                  }}
                />
              ))}

              {/* Summary card */}
              <div className="bg-white rounded-xl border border-gray-100 p-4 mb-3 shadow-sm">
                <div className="flex justify-between text-sm text-gray-500 mb-2">
                  <span>Items total</span>
                  <span>₹{fmtPrice(itemsTotal)}</span>
                </div>
                {gstTotal > 0 && (
                  <div className="flex justify-between text-sm text-gray-400 mb-2">
                    <span>GST</span>
                    <span>₹{fmtPrice(gstTotal)}</span>
                  </div>
                )}
                {prevBalance > 0 && (
                  <div className="flex justify-between text-sm text-red-500 mb-2">
                    <span>Previous balance</span>
                    <span>₹{fmtPrice(prevBalance)}</span>
                  </div>
                )}
                <div className="border-t border-gray-100 mt-2 pt-2 flex justify-between font-bold text-gray-800 text-base">
                  <span>Total payable</span>
                  <span>₹{fmtPrice(totalOwed)}</span>
                </div>
              </div>

              {/* Notes */}
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Delivery instructions, special requests…"
                  rows={2}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>

              {/* Paid amount */}
              <div className="mb-2">
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Amount paid (₹)</label>
                <input
                  type="number" min="0" step="0.01"
                  value={paidAmount}
                  onChange={(e) => { setPaidAmount(e.target.value); setMessage(""); }}
                  placeholder="0.00"
                  className="w-full border border-gray-200 rounded-xl px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>

              {/* Quick amount chips */}
              <div className="flex gap-2 mb-3 flex-wrap">
                {paymentSuggestions.map((amt, i) => (
                  <button key={i}
                    onClick={() => { setPaidAmount(String(amt)); setMessage(""); }}
                    className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-gray-50 hover:bg-orange-50 hover:border-orange-300 transition-all">
                    {i === 0 ? `Full ₹${fmtPrice(amt)}` : `₹${fmtPrice(amt)}`}
                  </button>
                ))}
              </div>

              {/* Payment mode */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Payment mode</label>
                <div className="flex gap-2">
                  {(["cash", "upi", "bank", "credit"] as const).map((m) => (
                    <button key={m} onClick={() => setPaymentMode(m)}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium border capitalize transition-all ${
                        paymentMode === m
                          ? "bg-orange-500 text-white border-orange-500"
                          : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                      }`}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              {/* Place order button */}
              <button
                onClick={handleSaveOrder}
                disabled={billItems.length === 0 || isSaving}
                className="w-full py-3.5 rounded-xl bg-orange-500 text-white font-bold text-base hover:bg-orange-600 disabled:opacity-40 transition-all mb-4"
              >
                {isSaving ? "Placing order…" : "Place Order"}
              </button>
            </>
          )}
        </div>
      )}

      {/* ── Saving overlay ── */}
      {isSaving && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl px-12 py-8 text-center shadow-2xl">
            <p className="text-3xl mb-3">⏳</p>
            <p className="font-semibold text-gray-800">Placing order…</p>
            <p className="text-xs text-gray-400 mt-1">Updating stock & saving</p>
          </div>
        </div>
      )}

      {/* ── Back / draft dialog ── */}
      {showBackDialog && customer && (
        <BackDraftDialog
          customerName={customer.shopName}
          onSave={handleSaveDraft}
          onDiscard={() => {
            delete draftStore[customer.id!];
            setShowBackDialog(false);
            setCartQty({});
            resetBilling();
          }}
          onCancel={() => setShowBackDialog(false)}
        />
      )}

      {/* ── Qty dialog ── */}
      {qtyDialogProduct && (
        <QtyDialog
          product={qtyDialogProduct}
          currentQty={cartQty[qtyDialogProduct.id!] ?? 0}
          onConfirm={(qty) => {
            if (qty <= 0) removeItem(qtyDialogProduct.id!);
            else setCartQty((prev) => ({ ...prev, [qtyDialogProduct.id!]: qty }));
            setQtyDialogProduct(null);
          }}
          onDismiss={() => setQtyDialogProduct(null)}
        />
      )}
    </div>
  );
}