import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import {
  collection, getDocs, addDoc, query, orderBy,
  doc, runTransaction, onSnapshot, setDoc, getDoc, increment, updateDoc,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer, Product, Order, OrderItem, GSTRate, ProductUnit, OrderItemOverride } from "../types";
import { useAuthStore } from "../store/authStore";
import { useModalKeyboard } from "../hooks/useModalKeyboard";
import { useTamilSearch } from "../utils/UseTamilSearch";
import { TamilSearchInput } from "../components/TamilSearchInput";
import { useBillingDraftsStore, BillDraft, PaymentMode } from "../store/billingDraftsStore";

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

// For a given selling price and product, compute:
//   taxableBase  — the pre-tax amount per unit
//   gstPerUnit   — the GST component per unit
//   billedPrice  — what actually appears on the bill per unit
//                  (= sellingPrice for exclusive; same sellingPrice for inclusive)
function gstBreakdown(price: number, gstPct: number, inclusive: boolean) {
  if (gstPct === 0) return { taxableBase: price, gstPerUnit: 0, billedPrice: price };
  if (inclusive) {
    // Price already contains GST — extract it
    // taxableBase = price / (1 + rate/100)
    const taxableBase = price / (1 + gstPct / 100);
    const gstPerUnit  = price - taxableBase;           // GST component inside the price
    return { taxableBase: round2(taxableBase), gstPerUnit: round2(gstPerUnit), billedPrice: price };
  } else {
    // Price is pre-tax — add GST on top
    const gstPerUnit = price * gstPct / 100;
    return { taxableBase: price, gstPerUnit: round2(gstPerUnit), billedPrice: round2(price + gstPerUnit) };
  }
}

function fmtPrice(v: number): string { return Number(v).toFixed(2); }
function fmtQty(v: number): string   { return Number.isInteger(v) ? String(v) : v.toFixed(2); }
function round2(v: number): number   { return Math.round(v * 100) / 100; }
function fmtRupees(v: number): string { return `₹${fmtPrice(v)}`; }

// ── Per-bill product overrides ───────────────────────────────────
// Lets a field agent fix a product's name, price, unit, GST%, category, or
// fractional-sale setting without leaving the "add to cart" flow.
// Changes can be applied to this bill only (in-memory) or saved back to
// the master catalogue. An overridden field is treated as intentional and
// is never overwritten by a catalogue-change warning on resume.
function overrideIsAllDefault(o: OrderItemOverride): boolean {
  return o.name === undefined && o.price === undefined && o.unit === undefined &&
    o.gst === undefined && o.category === undefined && o.sellInFraction === undefined;
}

const EDIT_UNITS: ProductUnit[] = ["Piece", "KG", "Gram", "Liter", "ML", "Box", "Packet", "Dozen", "Bag", "Bottle", "Other"];
const EDIT_GST_RATES: { label: string; value: GSTRate }[] = [
  { label: "No GST", value: "none" },
  { label: "5%", value: "5" },
  { label: "12%", value: "12" },
  { label: "18%", value: "18" },
  { label: "28%", value: "28" },
];

// ── WhatsApp order message builder ───────────────────────────────
function buildWhatsAppMessage(params: {
  businessName: string;
  orderId: string;
  customerName: string;
  items: OrderItem[];
  grandTotal: number;
  advancePaid: number;
  prevBalance: number;
}): string {
  const { businessName, orderId, customerName, items, grandTotal, advancePaid, prevBalance } = params;
  const balanceDue = round2(grandTotal - advancePaid);
  const shortId    = orderId.slice(0, 8).toUpperCase();

  const itemLines = items.map((item, i) =>
    `  ${i + 1}. ${item.productName}\n     ${fmtQty(item.quantity)} ${item.unit} × ₹${fmtPrice(item.price)} = ₹${fmtPrice(item.total)}`
  ).join("\n");

  const lines: string[] = [
    `🧾 *Order Confirmation*`,
    `*${businessName}*`,
    ``,
    `Hello *${customerName}*,`,
    `Your order has been placed successfully.`,
    ``,
    `*Order ID:* ${shortId}`,
    ``,
    `*Items:*`,
    itemLines,
    ``,
    `*Bill Total:*  ₹${fmtPrice(grandTotal)}`,
  ];

  if (prevBalance > 0) {
    lines.push(`*Previous Due:*  ₹${fmtPrice(prevBalance)}`);
    lines.push(`*Total Payable:*  ₹${fmtPrice(grandTotal + prevBalance)}`);
  }

  if (advancePaid > 0) {
    lines.push(`*Advance Paid:*  ₹${fmtPrice(advancePaid)}`);
    lines.push(`*Balance to Pay:*  ₹${fmtPrice(balanceDue > 0 ? balanceDue : 0)}`);
  }

  lines.push(``);
  lines.push(`Thank you for your order! 🙏`);

  return lines.join("\n");
}

function openWhatsApp(phone: string, message: string): void {
  // Normalize phone: strip non-digits, add 91 country code if not present
  const digits = phone.replace(/\D/g, "");
  const normalized = digits.startsWith("91") && digits.length === 12 ? digits : `91${digits}`;
  const url = `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
  window.open(url, "_blank");
}

// NOTE: in-progress bills ("drafts") used to live in a module-level object
// here (draftQty only, lost on navigation/refresh). That's been replaced by
// the persisted `useBillingDraftsStore` (src/store/billingDraftsStore.ts),
// which holds the FULL bill snapshot (cart, overrides, payment, notes) and
// survives navigating away, refreshing, and closing the tab — and powers
// the floating "minimized bill" bubbles shown app-wide in Layout.

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

  const handleConfirm = () => {
    if (!input || qty <= 0) return;
    const capped = product.trackInventory ? Math.min(qty, avail) : qty;
    onConfirm(capped);
  };
  useModalKeyboard({ onClose: onDismiss, onConfirm: handleConfirm, disabled: !input || qty <= 0 });

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

// ─── Product Edit Dialog ──────────────────────────────────────────
// Billing-time quick edit — fix a product's name, price, unit, GST%, or
// category without leaving the order screen. "Save to catalogue" updates
// the product permanently; "This bill only" applies just to this order.

function ProductEditDialog({
  product, currentOverride, existingCategories, onSaveToCatalogue, onBillOnly, onDismiss,
}: {
  product: Product; currentOverride?: OrderItemOverride; existingCategories: string[];
  onSaveToCatalogue: (o: OrderItemOverride) => void;
  onBillOnly: (o: OrderItemOverride) => void;
  onDismiss: () => void;
}) {
  const [name, setName]     = useState(currentOverride?.name ?? product.name);
  const [price, setPrice]   = useState(String(currentOverride?.price ?? product.sellingPrice));
  const [unit, setUnit]     = useState<string>(currentOverride?.unit ?? product.unit);
  const [customUnit, setCustomUnit] = useState(
    EDIT_UNITS.includes((currentOverride?.unit ?? product.unit) as ProductUnit) ? "" : (currentOverride?.unit ?? product.unit)
  );
  const [gst, setGst]       = useState<GSTRate>(currentOverride?.gst ?? product.gst);
  const [category, setCategory] = useState(currentOverride?.category ?? product.category);
  const [sellInFraction, setSellInFraction] = useState(currentOverride?.sellInFraction ?? product.sellInFraction);

  const effectiveUnit = customUnit.trim() ? customUnit.trim() : unit;
  const priceNum      = parseFloat(price);
  const priceValid    = !isNaN(priceNum) && priceNum > 0;
  const canConfirm    = name.trim().length > 0 && priceValid;

  const buildOverride = (): OrderItemOverride => ({
    name:           name.trim() !== product.name ? name.trim() : undefined,
    price:          priceValid && priceNum !== product.sellingPrice ? priceNum : undefined,
    unit:           effectiveUnit !== product.unit ? (effectiveUnit as ProductUnit) : undefined,
    gst:            gst !== product.gst ? gst : undefined,
    category:       category.trim() && category.trim() !== product.category ? category.trim() : undefined,
    sellInFraction: sellInFraction !== product.sellInFraction ? sellInFraction : undefined,
  });

  useModalKeyboard({ onClose: onDismiss, confirmOnEnter: false });

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4"
      onClick={onDismiss}
    >
      <div
        className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="font-semibold text-gray-800 mb-0.5">Edit product</p>
        <p className="text-xs text-gray-400 mb-4">
          Changes apply to this bill. Use "Save to catalogue" to update the product permanently.
        </p>

        <div className="flex flex-col gap-3">
          {/* Name */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Product name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full text-sm px-3 py-2.5 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>

          {/* Price */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Selling price (₹)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full text-sm px-3 py-2.5 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
            <p className="text-xs text-gray-400 mt-1">Catalogue: ₹{fmtPrice(product.sellingPrice)}</p>
          </div>

          {/* Unit */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Unit</label>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {EDIT_UNITS.map((opt) => (
                <button key={opt} type="button"
                  onClick={() => { setUnit(opt); setCustomUnit(""); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-all ${
                    unit === opt && !customUnit
                      ? "bg-orange-500 text-white border-orange-500"
                      : "border-gray-300 text-gray-600 hover:border-orange-300"
                  }`}>
                  {opt}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={customUnit}
              onChange={(e) => setCustomUnit(e.target.value)}
              placeholder="Custom unit (optional), e.g. Bundle, Tray…"
              className="w-full text-sm px-3 py-2 mt-1.5 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>

          {/* GST */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">GST %</label>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {EDIT_GST_RATES.map((g) => (
                <button key={g.value} type="button"
                  onClick={() => setGst(g.value)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-all ${
                    gst === g.value
                      ? "bg-orange-500 text-white border-orange-500"
                      : "border-gray-300 text-gray-600 hover:border-orange-300"
                  }`}>
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Category</label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full text-sm px-3 py-2.5 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
            {existingCategories.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-1 mt-1.5">
                {existingCategories.map((cat) => (
                  <button key={cat} type="button" onClick={() => setCategory(cat)}
                    className="px-2.5 py-1 rounded-full text-xs border border-gray-200 text-gray-500 whitespace-nowrap hover:border-orange-300">
                    {cat}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sell in fractions toggle */}
          <div className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm text-gray-700">Sell in fractions</p>
              <p className="text-xs text-gray-400">
                {sellInFraction ? "e.g. 0.5 Kg, 0.250 Kg" : "Whole units only (1, 2, 3…)"}
              </p>
            </div>
            <button type="button"
              onClick={() => setSellInFraction(!sellInFraction)}
              className={`w-11 h-6 rounded-full transition-colors relative flex-shrink-0 ${
                sellInFraction ? "bg-orange-500" : "bg-gray-300"
              }`}>
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                sellInFraction ? "translate-x-5" : "translate-x-0.5"
              }`} />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 mt-5">
          <button
            disabled={!canConfirm}
            onClick={() => onSaveToCatalogue(buildOverride())}
            className="w-full bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-40"
          >
            Save to catalogue
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => onBillOnly(buildOverride())}
            className="w-full border border-orange-300 text-orange-600 py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-50 disabled:opacity-40"
          >
            This bill only
          </button>
          <button onClick={onDismiss}
            className="w-full text-gray-400 py-2 text-sm hover:text-gray-600">
            Cancel
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
  useModalKeyboard({ onClose: onCancel, onConfirm: onSave });
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
      <div className="bg-white rounded-2xl p-6 w-80 shadow-2xl">
        <p className="font-semibold text-gray-800 mb-2">Save &amp; minimize this bill?</p>
        <p className="text-sm text-gray-500 mb-5 leading-relaxed">
          You have items in the cart for <strong>{customerName}</strong>.{" "}
          Save it and it'll show up as a floating bubble so you can continue it later.
        </p>
        <div className="flex flex-col gap-2">
          <button onClick={onSave}
            className="w-full bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600">
            Save &amp; Minimize
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
  product, qtyInCart, override, onAdd, onRemove, onQtyTapped, onProductTapped,
}: {
  product: Product; qtyInCart: number; override?: OrderItemOverride;
  onAdd: () => void; onRemove: () => void; onQtyTapped: () => void; onProductTapped: () => void;
}) {
  const avail       = availableQty(product);
  const outOfStock  = product.trackInventory && avail <= 0;
  const atLimit     = product.trackInventory && qtyInCart >= avail;
  const lowStock    = product.trackInventory && avail <= product.minStockAlert && avail > 0;

  // Bill-only override takes precedence over catalogue values
  const effName     = override?.name ?? product.name;
  const effUnit     = override?.unit ?? product.unit;
  const effGst      = override?.gst  ?? product.gst;
  const gstPct       = effGst === "none" || !effGst ? 0 : parseFloat(effGst);
  const inclusive    = product.taxInclusive === true;
  const displayPrice = override?.price ?? getSlabPrice(product, Math.max(qtyInCart, 1));
  const activePrice  = qtyInCart > 0 ? (override?.price ?? getSlabPrice(product, qtyInCart)) : null;
  // lineTotal = sum of selling prices (the price customer sees on product row)
  const lineTotal    = activePrice ? activePrice * qtyInCart : 0;
  // For inclusive: GST is already inside lineTotal; for exclusive: add on top
  const bd           = activePrice ? gstBreakdown(activePrice, gstPct, inclusive) : null;
  const gstAmt       = bd ? round2(bd.gstPerUnit * qtyInCart) : 0;
  // billTotal = what customer actually pays for this line
  const billTotal    = bd ? round2(bd.billedPrice * qtyInCart) : 0;

  return (
    <div className="flex items-center gap-3 py-3 border-b border-gray-100 last:border-0">
      {/* Info — tap to edit name/price/unit/GST/category for this bill (or the catalogue) */}
      <div className="flex-1 min-w-0 cursor-pointer" onClick={onProductTapped}>
        <p className="font-medium text-sm text-gray-800 mb-0.5 truncate">{effName}</p>
        <p className={`text-xs ${lowStock ? "text-red-500" : "text-gray-400"}`}>
          ₹{fmtPrice(displayPrice)} / {effUnit}
          {gstPct > 0 && (
            <span className="text-gray-400">
              {inclusive
                ? ` (incl. ${gstPct}% GST)`
                : ` + ${gstPct}% GST`}
            </span>
          )}
          {" · "}
          {product.trackInventory ? `Stock: ${fmtQty(avail)}` : "Stock: ∞"}
        </p>

        {/* Active slab price hint (only when price isn't overridden) */}
        {!override?.price && product.priceSlabs.length > 0 && qtyInCart > 0 && activePrice !== product.sellingPrice && (
          <p className="text-xs text-orange-600 font-medium mt-0.5">
            Slab: ₹{fmtPrice(activePrice!)} for {fmtQty(qtyInCart)} {effUnit}
          </p>
        )}
        {/* Slab tiers when nothing in cart (only when price isn't overridden) */}
        {!override?.price && product.priceSlabs.length > 0 && qtyInCart === 0 && (
          <p className="text-xs text-orange-400 mt-0.5">
            {product.priceSlabs.map((s, i) => (
              <span key={i} className="mr-2">
                {fmtQty(s.minQty)}{s.maxQty != null ? `–${fmtQty(s.maxQty)}` : "+"}: ₹{fmtPrice(s.price)}
              </span>
            ))}
          </p>
        )}
        {(override?.category ?? product.category) && (
          <p className="text-xs text-orange-500 mt-0.5">{override?.category ?? product.category}</p>
        )}
        {override && !overrideIsAllDefault(override) && (
          <p className="text-xs text-orange-500 mt-0.5">✏ Edited for this bill</p>
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
            {gstPct > 0
              ? inclusive
                ? `${fmtRupees(lineTotal)} (tax incl.)`           // price already has GST
                : `${fmtRupees(billTotal)} incl. GST`             // price + GST added on top
              : fmtRupees(lineTotal)}
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
  item, index, onDecrease, onIncrease, onRemove, onQtyTapped, onPriceTapped, isOverridden,
}: {
  item: OrderItem; index: number;
  onDecrease: () => void; onIncrease: () => void;
  onRemove: () => void; onQtyTapped: () => void; onPriceTapped: () => void; isOverridden: boolean;
}) {
  const gstPct    = parseFloat(item.gst ?? "0") || 0;
  const inclusive = item.taxInclusive === true;
  // re-use the same breakdown logic
  const cbd       = gstPct > 0 ? gstBreakdown(item.price, gstPct, inclusive) : null;
  const gstAmt    = cbd ? round2(cbd.gstPerUnit * item.quantity) : 0;
  // billedLineTotal: for exclusive = price*qty + gst; for inclusive = price*qty (already contains gst)
  const billedLineTotal = cbd
    ? round2(cbd.billedPrice * item.quantity)
    : item.total;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 mb-2 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm text-gray-800 mb-1">
            <span className="text-gray-400 mr-1">{index + 1}.</span>
            {item.productName}
          </p>
          <p className="text-xs text-gray-400 cursor-pointer hover:text-orange-500" onClick={onPriceTapped}>
            ₹{fmtPrice(item.price)} × {fmtQty(item.quantity)} {item.unit}
            {" = "}
            {gstPct > 0 && !inclusive
              ? <><span className="line-through text-gray-300">₹{fmtPrice(item.total)}</span>{" "}₹{fmtPrice(billedLineTotal)}</>
              : <>₹{fmtPrice(billedLineTotal)}</>
            }
          </p>
          {isOverridden && (
            <p className="text-xs text-orange-500 mt-0.5">✏ Edited for this bill</p>
          )}
          {gstAmt > 0 && (
            <p className="text-xs text-gray-400 mt-0.5">
              {inclusive
                ? `GST ${gstPct}% incl. = ₹${fmtPrice(gstAmt)} (taxable base ₹${fmtPrice(round2(item.price / (1 + gstPct / 100) * item.quantity))})`
                : `+ GST ${gstPct}% = ₹${fmtPrice(gstAmt)}`}
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
  const [regions, setRegions]       = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading]       = useState(true);
  // True only after the products listener has delivered its first snapshot.
  // A fresh mount of this page (e.g. resuming a minimized bill from the
  // floating bubble on another screen) starts with `products = []` until
  // that first snapshot arrives — diffing a draft against an empty catalogue
  // would make every item look "removed", so anything that diffs a draft
  // against the live catalogue must wait for this flag first.
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [frequentIds, setFrequentIds] = useState<string[]>([]);

  // Customer region filter
  const [selectedRegion, setSelectedRegion] = useState<string>("");

  // Billing state
  const [customer, setCustomer]     = useState<Customer | null>(null);
  const [cartQty, setCartQty]       = useState<Record<string, number>>({});
  const [paidAmount, setPaidAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash"|"upi"|"bank"|"credit">("cash");
  const [notes, setNotes]           = useState("");
  const [message, setMessage]       = useState("");
  const [isSaving, setIsSaving]     = useState(false);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const [whatsappData, setWhatsappData] = useState<{
    phone: string; message: string;
  } | null>(null);

  // UI state
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [sortMode, setSortMode]                 = useState<"frequent"|"name">("frequent");
  const [qtyDialogProduct, setQtyDialogProduct] = useState<Product | null>(null);
  // Per-bill field overrides — productId → OrderItemOverride.
  // Persisted as part of the bill snapshot in useBillingDraftsStore so a
  // minimized/resumed bill keeps them; a diff-warning never touches a
  // field the agent has already overridden here.
  const [cartOverrides, setCartOverrides] = useState<Record<string, OrderItemOverride>>({});
  const [productEditTarget, setProductEditTarget] = useState<Product | null>(null);
  const [showBackDialog, setShowBackDialog]     = useState(false);
  const [showCloseDialog, setShowCloseDialog]   = useState(false);
  const [draftWarnings, setDraftWarnings]       = useState<string[]>([]);

  // ── Minimized-bill store bindings ─────────────────────────────────
  const drafts           = useBillingDraftsStore((s) => s.drafts);
  const saveDraft         = useBillingDraftsStore((s) => s.saveDraft);
  const removeDraftFromStore = useBillingDraftsStore((s) => s.removeDraft);
  const setActiveCustomerId = useBillingDraftsStore((s) => s.setActiveCustomerId);
  const setHasUnsavedActiveBill = useBillingDraftsStore((s) => s.setHasUnsavedActiveBill);
  const registerExitHandlers = useBillingDraftsStore((s) => s.registerExitHandlers);
  const resumeCustomerId  = useBillingDraftsStore((s) => s.resumeCustomerId);
  const resumeToken       = useBillingDraftsStore((s) => s.resumeToken);
  const clearResumeRequest = useBillingDraftsStore((s) => s.clearResumeRequest);

  const searchRef = useRef<HTMLInputElement>(null);

  // ── Tamil-aware search for customers ────────────────────────────────────
  // regionName + area included so typing a region/area name (English or Tamil) filters the list
  const { query: customerSearch, setQuery: setCustomerSearch, results: customerSearchResults } =
    useTamilSearch(customers as unknown as Record<string, unknown>[], ["shopName", "ownerName", "phone", "regionName", "area"]);

  // ── Tamil-aware search for products ─────────────────────────────────────
  const { query: searchQuery, setQuery: setSearchQuery, results: productSearchResults } =
    useTamilSearch(products as unknown as Record<string, unknown>[], ["name", "category", "barcode"]);

  // ── Load customers, products, frequent ids ──────────────────────
  useEffect(() => {
    let unsubProducts: (() => void) | null = null;

    const init = async () => {
      setLoading(true);
      try {
        const [custSnap, ordersSnap, regionSnap] = await Promise.all([
          getDocs(query(collection(db, "customers"), orderBy("shopName"))),
          getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"))),
          getDocs(query(collection(db, "regions"), orderBy("name"))),
        ]);

        setCustomers(custSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer)));

        // Deduplicate regions by name (same guard as Customers.tsx)
        const seen = new Set<string>();
        setRegions(
          regionSnap.docs
            .map((d) => ({ id: d.id, name: (d.data() as any).name as string }))
            .filter((r) => { const k = r.name.toLowerCase().trim(); if (seen.has(k)) return false; seen.add(k); return true; })
        );

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
      (snap) => {
        setProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Product)));
        setProductsLoaded(true);
      }
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
    // productSearchResults already filters by searchQuery (Tamil-aware).
    // When no search query, apply category filter; when searching, show all matches.
    let list = searchQuery.trim()
      ? (productSearchResults as unknown as Product[])
      : (selectedCategory !== "All"
          ? products.filter((p) => p.category === selectedCategory)
          : products);

    if (sortMode === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));

    // Frequent-first
    const freqSet = new Set(frequentIds);
    const freq = frequentIds.map((id) => list.find((p) => p.id === id)).filter(Boolean) as Product[];
    const rest = list.filter((p) => !freqSet.has(p.id!)).sort((a, b) => a.name.localeCompare(b.name));
    return [...freq, ...rest];
  }, [products, productSearchResults, searchQuery, selectedCategory, sortMode, frequentIds]);

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
        const qty       = cartQty[p.id!];
        const override  = cartOverrides[p.id!];
        // Bill-only override takes precedence over catalogue values
        const effName   = override?.name ?? p.name;
        const effUnit   = override?.unit ?? p.unit;
        const effGst    = override?.gst  ?? p.gst;
        // For price: if overridden use that flat price, else use slab logic
        const price     = override?.price ?? getSlabPrice(p, qty);
        const gstPct    = effGst === "none" || !effGst ? 0 : parseFloat(effGst);
        const inclusive = p.taxInclusive === true;
        const bd        = gstPct > 0 ? gstBreakdown(price, gstPct, inclusive) : null;

        // total = what the customer actually pays for this line
        //   inclusive: price * qty  (GST already inside)
        //   exclusive: (price + gstPerUnit) * qty
        const total     = bd ? round2(bd.billedPrice * qty) : round2(price * qty);

        const item: OrderItem = {
          productId:   p.id!,
          productName: effName,
          price,          // selling price per unit (pre-addition for exclusive; inclusive as-is)
          unit:        effUnit,
          quantity:    qty,
          total,          // billed line total (customer pays this)
        };
        if (effGst && effGst !== "none") item.gst        = effGst;
        if (p.hsn)                       item.hsn        = p.hsn;
        if (inclusive)                   item.taxInclusive = true;
        return item;
      });
  }, [cartQty, products, cartOverrides]);

  const overriddenProductIds = useMemo(() => new Set(Object.keys(cartOverrides)), [cartOverrides]);

  // itemsTotal = sum of pre-tax amounts (taxable base across all items)
  const itemsTotal = useMemo(() =>
    billItems.reduce((s, i) => {
      const gstPct    = parseFloat(i.gst ?? "0") || 0;
      const inclusive = i.taxInclusive === true;
      if (gstPct === 0 || !inclusive) {
        // exclusive: total already = price*qty (pre-tax); no-gst: same
        return s + round2(i.price * i.quantity);
      } else {
        // inclusive: extract taxable base from total
        return s + round2(i.price / (1 + gstPct / 100) * i.quantity);
      }
    }, 0),
    [billItems]
  );
  const gstTotal   = useMemo(() =>
    // Re-derive GST amounts correctly for both inclusive and exclusive
    billItems.reduce((s, i) => {
      const gstPct    = parseFloat(i.gst ?? "0") || 0;
      if (gstPct === 0) return s;
      const inclusive = i.taxInclusive === true;
      const bd        = gstBreakdown(i.price, gstPct, inclusive);
      return s + round2(bd.gstPerUnit * i.quantity);
    }, 0),
    [billItems]
  );
  // grandTotal = what customer actually pays = sum of all billedLineTotals
  const grandTotal = useMemo(() =>
    billItems.reduce((s, i) => s + i.total, 0),
    [billItems]
  );
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

  const applyBillOnlyOverride = useCallback((productId: string, override: OrderItemOverride) => {
    setCartOverrides((prev) => {
      const n = { ...prev };
      if (overrideIsAllDefault(override)) delete n[productId];
      else n[productId] = override;
      return n;
    });
    setProductEditTarget(null);
  }, []);

  const saveOverrideToCatalogue = useCallback(async (product: Product, override: OrderItemOverride) => {
    // Persist the changed fields back to the product doc
    const updates: Partial<Product> = {};
    if (override.name           !== undefined) updates.name           = override.name;
    if (override.price          !== undefined) updates.sellingPrice   = override.price;
    if (override.unit           !== undefined) updates.unit           = override.unit;
    if (override.gst            !== undefined) updates.gst            = override.gst;
    if (override.category       !== undefined) updates.category       = override.category;
    if (override.sellInFraction !== undefined) updates.sellInFraction = override.sellInFraction;
    updates.updatedAt = new Date().toISOString();

    try {
      await updateDoc(doc(db, "products", product.id!), { ...updates });
    } catch {
      setMessage("✕ Failed to update product — changes applied to this bill only");
    }
    // Also apply for this bill so the cart reflects the change immediately
    // (the products list will also refresh via the live onSnapshot listener)
    applyBillOnlyOverride(product.id!, override);
  }, [applyBillOnlyOverride]);

  // ── Save order to Firestore (transactional) ──────────────────────
  const handleSaveOrder = async () => {
    if (!customer || !user) return;
    if (billItems.length === 0) { setMessage("Add at least one product"); return; }

    // Payment is optional — treat empty/blank as ₹0 (pay on delivery)
    const rawPaid = paidAmount.trim();
    const paid    = rawPaid === "" ? 0 : parseFloat(rawPaid);
    if (isNaN(paid))             { setMessage("Enter a valid advance amount"); return; }
    if (paid < 0)                { setMessage("Advance amount cannot be negative"); return; }
    if (paid > totalOwed + 0.01) { setMessage("Advance exceeds total payable"); return; }

    // ── Credit limit enforcement ──────────────────────────────────
    // Check if placing this order would push the customer over their credit ceiling.
    if (customer.creditLimit && customer.creditLimit > 0) {
      const newOutstanding = round2(prevBalance + grandTotal - paid);
      if (newOutstanding > customer.creditLimit) {
        const over = round2(newOutstanding - customer.creditLimit);
        const proceed = window.confirm(
          `⚠️ Credit limit warning\n\n` +
          `${customer.shopName} has a credit limit of ₹${customer.creditLimit.toFixed(2)}.\n` +
          `This order will put them ₹${over.toFixed(2)} over their limit.\n\n` +
          `Do you want to proceed anyway?`
        );
        if (!proceed) { setIsSaving(false); return; }
      }
    }

    setIsSaving(true);
    setMessage("");

    try {
      let newOrderId = "";
      let newOrderNo = "";

      // Snapshot costPrice at order creation time using the currently loaded products.
      // costPrice is on the main product doc (readable by all roles).
      // Stored invisibly on each order item — never shown in cart UI.
      const prodIndex: Record<string, Product> = {};
      products.forEach((pr) => { if (pr.id) prodIndex[pr.id] = pr; });
      const costPriceMap: Record<string, number> = {};
      billItems.forEach((item) => {
        costPriceMap[item.productId] = prodIndex[item.productId]?.costPrice ?? 0;
      });

      await runTransaction(db, async (t) => {
        // ── READ PHASE: ALL reads must come before any writes ─────
        const productRefs  = billItems.map((item) => doc(db, "products", item.productId));
        const customerRef  = doc(db, "customers", customer.id!);

        // Read products AND customer atomically before any writes
        const [productSnaps, customerSnap] = await Promise.all([
          Promise.all(productRefs.map((ref) => t.get(ref))),
          t.get(customerRef),
        ]);

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
        // Reserve stock on each tracked product.
        // The availability check above ran inside the transaction (read phase),
        // so this write is atomic with that check — no race condition possible.
        productSnaps.forEach((snap, i) => {
          const data = snap.data() as Product;
          if (!data.trackInventory) return;
          const newReserved = (data.reservedStock ?? 0) + billItems[i].quantity;
          // ── Fix 9: never allow reservedStock to push available stock negative ──
          const newAvail = data.stock - newReserved - (
            data.safetyBuffer?.type === "fixed"
              ? (data.safetyBuffer?.value ?? 0)
              : ((data.safetyBuffer?.value ?? 0) / 100) * data.stock
          );
          if (newAvail < -0.01) {
            throw new Error(`"${billItems[i].productName}" stock would go negative — please refresh and try again.`);
          }
          t.update(productRefs[i], {
            reservedStock: Math.max(0, newReserved),
          });
        });

        // Strip undefined from bill items (hsn, gst, taxInclusive may be undefined)
        const cleanItems = billItems.map((item) => {
          const clean: Record<string, unknown> = {
            productId:   item.productId,
            productName: item.productName,
            price:       item.price,
            unit:        item.unit,
            quantity:    item.quantity,
            total:       item.total,
            // Snapshot costPrice at order creation time for accurate profit reports.
            // Invisible to field agents / packing staff in UI — admin-only in reports.
            costPrice:   costPriceMap[item.productId] ?? 0,
          };
          if (item.gst)          clean.gst          = item.gst;
          if (item.hsn)          clean.hsn          = item.hsn;
          if (item.taxInclusive) clean.taxInclusive = item.taxInclusive;
          return clean;
        });

        // Build order payload — never set a key to undefined in Firestore
        const orderPayload: Record<string, unknown> = {
          customerId:      customer.id!,
          customerName:    customer.shopName,
          customerAddress: customer.address ?? "",
          customerArea:    customer.area    ?? "",
          customerPhone:   customer.phone   ?? "",
          agentId:         user.uid,
          agentName:       user.name,
          regionId:        customer.regionId ?? "",
          regionName:      customer.regionName ?? "",
          items:           cleanItems,
          // totalAmount = order value only (without prevBalance, which is tracked separately)
          totalAmount:     round2(grandTotal),
          // advancePaid = what was collected at order creation (can be 0)
          advancePaid:     paid,
          // balanceDue = what still needs to be collected on delivery
          balanceDue:      round2(grandTotal - paid),
          // amountCollected is set by delivery agent on delivery; default to advance paid
          amountCollected: paid,
          paymentMode:     paid > 0 ? paymentMode : "pending",
          status:          "pending",
          createdAt:       new Date().toISOString(),
        };

        // Optional fields — only add if they have a real value (never undefined)
        if (customer.lat != null)            orderPayload.customerLat  = customer.lat;
        if (customer.lng != null)            orderPayload.customerLng  = customer.lng;
        if (notes.trim())                    orderPayload.notes        = notes.trim();
        if (customer.gstin)                  orderPayload.customerGstin = customer.gstin;

        const orderRef = doc(collection(db, "orders"));
        newOrderId     = orderRef.id;

        // Generate human-readable orderNo: yyMMddHHmmss + 3 random digits
        // Format matches field agent: yyMMddHHmmss3rand — consistent across all apps
        const now2      = new Date();
        const pad2      = (n: number) => String(n).padStart(2, "0");
        const yy        = String(now2.getFullYear()).slice(2);
        const MM        = pad2(now2.getMonth() + 1);
        const dd        = pad2(now2.getDate());
        const HH        = pad2(now2.getHours());
        const mm        = pad2(now2.getMinutes());
        const ss        = pad2(now2.getSeconds());
        const rand3     = String(Math.floor(Math.random() * 900) + 100);
        newOrderNo = `${yy}${MM}${dd}${HH}${mm}${ss}${rand3}`;
        orderPayload.orderNo = newOrderNo;

        t.set(orderRef, orderPayload);

        // Use the customerSnap already read in the READ PHASE above —
        // no additional t.get() here, which would violate read-before-write rule.
        const now     = new Date().toISOString();
        const liveDue = customerSnap.exists() ? (customerSnap.data().outstandingDue ?? 0) : prevBalance;
        const newDue  = round2(liveDue + grandTotal - paid);
        // FIX: also stamp lastOrderAt / lastOrderId / updatedAt on customer
        t.update(customerRef, {
          outstandingDue: newDue,
          lastOrderAt:    now,
          lastOrderId:    newOrderId,
          updatedAt:      now,
        });

        // Write ledger entries atomically with the order
        const ledgerCol = collection(db, "customers", customer.id!, "payments");

        // Debit: order placed (increases what customer owes)
        t.set(doc(ledgerCol), {
          type:          "order_placed",
          direction:     "debit",
          amount:        round2(grandTotal),
          orderId:       newOrderId,
          orderNo:       newOrderNo,
          orderAmount:   round2(grandTotal),
          note:          "Order #" + newOrderNo + " placed",
          createdBy:     user.uid,
          createdByName: user.name,
          createdAt:     now,
        });

        // FIX: unified type "advance_collected" (matches mobile) instead of "delivery_payment"
        if (paid > 0) {
          t.set(doc(ledgerCol), {
            type:          "advance_collected",
            direction:     "credit",
            amount:        round2(paid),
            orderId:       newOrderId,
            orderNo:       newOrderNo,
            paymentMode:   paymentMode,
            note:          "Advance collected at order #" + newOrderNo + " (" + paymentMode + ")",
            createdBy:     user.uid,
            createdByName: user.name,
            createdAt:     now,
          });
        }
      });

      // Success
      removeDraftFromStore(customer.id!);
      setLastOrderId(newOrderNo);  // show human-readable ref in success toast

      // ── Sync field agent cash ledger ──────────────────────────────
      // FIX: Always seed the summary doc (merge) so admin sees agent even on
      // zero-advance orders. Only write an entry row when cash changed hands.
      if (user) {
        try {
          const cashRef = doc(db, "agentCashLedger", user.uid);
          await runTransaction(db, async (t) => {
            const snap    = await t.get(cashRef);
            const current = snap.exists() ? (snap.data().cashInHand ?? 0) : 0;
            // Always upsert the summary doc (idempotent via merge)
            t.set(cashRef, {
              agentId:    user.uid,
              agentName:  user.name,
              agentRole:  user.role,
              cashInHand: round2(current + paid),  // +0 on zero-advance — value unchanged
            }, { merge: true });
            // Only write an entry row when cash actually changed hands
            if (paid > 0) {
              const entryRef = doc(collection(db, "agentCashLedger", user.uid, "entries"));
              t.set(entryRef, {
                agentId:       user.uid,
                agentName:     user.name,
                type:          "order_advance",
                orderId:       newOrderId,
                orderNo:       newOrderNo,
                amount:        paid,
                direction:     "in",
                note:          `Advance collected for order #${newOrderNo} (${customer.shopName})`,
                createdBy:     user.uid,
                createdByName: user.name,
                createdAt:     new Date().toISOString(),
              });
            }
          });
        } catch (e) {
          // Non-critical — don't block the order success
          console.warn("Cash ledger sync failed:", e);
        }
      }

      // ── WhatsApp notification if customer has a phone number ──
      if (customer.phone) {
        const biz = await import("../firebase/config").then(async () => {
          const { getDoc, doc: fsDoc } = await import("firebase/firestore");
          const snap = await getDoc(fsDoc(db, "settings", "business"));
          return snap.exists() ? (snap.data() as { businessName?: string }) : null;
        }).catch(() => null);

        const waMsg = buildWhatsAppMessage({
          businessName: biz?.businessName || "Our Store",
          orderId:      newOrderId,
          customerName: customer.shopName,
          items:        billItems,
          grandTotal:   round2(grandTotal),
          advancePaid:  paid,
          prevBalance,
        });
        setWhatsappData({ phone: customer.phone, message: waMsg });
      }

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
    setCartQty({});
    setCartOverrides({});
    setDraftWarnings([]);
    setActiveCustomerId(null);
    setHasUnsavedActiveBill(false);
    // selectedRegion intentionally NOT reset — agent stays on current region
    // between orders so they can bill all shops in one area without re-selecting
  };

  // Snapshot the catalogue values of everything currently in the cart —
  // compared against live catalogue data on resume to warn about drift.
  const buildProductSnapshot = useCallback((): BillDraft["productSnapshot"] => {
    const snap: BillDraft["productSnapshot"] = {};
    Object.keys(cartQty).forEach((pid) => {
      const p = products.find((x) => x.id === pid);
      if (p) snap[pid] = { name: p.name, price: p.sellingPrice, gst: p.gst, taxInclusive: p.taxInclusive };
    });
    return snap;
  }, [cartQty, products]);

  // Save the bill currently on screen into the persisted draft store — this
  // is what spawns/refreshes its floating bubble.
  const saveCurrentAsDraft = useCallback(() => {
    if (!customer?.id) return;
    saveDraft(customer.id, {
      customer,
      cartQty: { ...cartQty },
      cartOverrides: { ...cartOverrides },
      paidAmount,
      paymentMode,
      notes,
      selectedRegion,
      productSnapshot: buildProductSnapshot(),
      lastKnownTotal: grandTotal,
    });
  }, [customer, cartQty, cartOverrides, paidAmount, paymentMode, notes, selectedRegion, buildProductSnapshot, grandTotal, saveDraft]);

  // Restore a saved draft into local state — validates stock (as before) AND
  // now diffs price / GST / tax-mode against the live catalogue, skipping
  // any field the agent already overrode for this specific bill.
  const applyDraft = useCallback((draft: BillDraft) => {
    const warnings: string[] = [];
    const restoredQty: Record<string, number> = {};

    Object.entries(draft.cartQty).forEach(([pid, qty]) => {
      const p = products.find((x) => x.id === pid);
      if (!p) {
        // Name it using the snapshot taken when this bill was minimized —
        // the live product is gone, but we still know what it was called.
        const knownName = draft.productSnapshot?.[pid]?.name;
        warnings.push(
          knownName ? `⚠ "${knownName}" was removed from catalogue` : "⚠ A product was removed from catalogue"
        );
        return;
      }

      if (p.trackInventory) {
        const avail = availableQty(p);
        if (avail <= 0) { warnings.push(`⚠ "${p.name}" removed from draft — out of stock`); return; }
        if (qty > avail) {
          restoredQty[pid] = avail;
          warnings.push(`⚠ "${p.name}" qty reduced ${fmtQty(qty)}→${fmtQty(avail)} (stock limit)`);
        } else {
          restoredQty[pid] = qty;
        }
      } else {
        restoredQty[pid] = qty;
      }

      const override = draft.cartOverrides?.[pid];
      const before    = draft.productSnapshot?.[pid];
      if (before) {
        if (override?.price === undefined && before.price !== p.sellingPrice) {
          warnings.push(`💰 "${p.name}" price changed ₹${fmtPrice(before.price)} → ₹${fmtPrice(p.sellingPrice)} since you minimized this bill`);
        }
        if (override?.gst === undefined && before.gst !== p.gst) {
          warnings.push(`📋 "${p.name}" GST rate changed since you minimized this bill`);
        }
        if ((before.taxInclusive ?? false) !== (p.taxInclusive ?? false)) {
          warnings.push(`📋 "${p.name}" tax mode (inclusive/exclusive) changed since you minimized this bill`);
        }
      }
    });

    setCustomer(draft.customer);
    setCartQty(restoredQty);
    setCartOverrides(draft.cartOverrides ?? {});
    setPaidAmount(draft.paidAmount ?? "");
    setPaymentMode(draft.paymentMode ?? "cash");
    setNotes(draft.notes ?? "");
    setStep("billing");
    setView("products");
    setSearchQuery("");
    setSelectedCategory("All");
    setSortMode("frequent");
    setMessage("");
    setDraftWarnings(warnings);
    setActiveCustomerId(draft.customer.id ?? null);
  }, [products, setActiveCustomerId]);

  const handleBack = () => {
    if (Object.keys(cartQty).length === 0) {
      if (customer?.id) removeDraftFromStore(customer.id);
      resetBilling();
    } else {
      setShowBackDialog(true);
    }
  };

  const handleSaveDraft = () => {
    saveCurrentAsDraft();
    setShowBackDialog(false);
    resetBilling();
  };

  // Explicit "minimize" button (top-right of the billing header). Always
  // available — even an empty cart can be minimized, per product decision —
  // so the agent can hold a customer's slot open without committing to items yet.
  const handleMinimize = () => {
    if (customer) saveCurrentAsDraft();
    resetBilling();
  };

  // Explicit "close" button (top-right, ✕) — ends the billing after a
  // confirmation, discarding any draft for this customer.
  const handleConfirmClose = () => {
    if (customer?.id) removeDraftFromStore(customer.id);
    setShowCloseDialog(false);
    resetBilling();
  };

  const handleSelectCustomer = (c: Customer) => {
    // Save the current customer's bill as a draft before switching, so it
    // becomes a floating bubble instead of being silently lost.
    if (customer && customer.id !== c.id) {
      if (Object.keys(cartQty).length > 0) saveCurrentAsDraft();
      else if (customer.id) removeDraftFromStore(customer.id);
    }

    // Per product decision: picking a customer who already has a minimized
    // draft always resumes that exact draft — never starts a fresh cart.
    const existingDraft = drafts[c.id!];
    if (existingDraft) {
      applyDraft(existingDraft);
      return;
    }

    setCustomer(c);
    setCartQty({});
    setCartOverrides({});
    setStep("billing");
    setView("products");
    setSearchQuery("");
    setSelectedCategory("All");
    setSortMode("frequent");
    setPaidAmount("");
    setNotes("");
    setMessage("");
    setDraftWarnings([]);
    setActiveCustomerId(c.id ?? null);
  };

  // ── Resume a bill from a floating bubble ──────────────────────────
  // Bubble clicks (from anywhere in the app, via Layout) set resumeCustomerId;
  // this fires whether or not CreateOrderPage was already mounted/open.
  useEffect(() => {
    if (!resumeCustomerId) return;
    // Wait for the products listener's first snapshot before diffing the
    // draft against the catalogue — on a fresh mount (bubble clicked from
    // another screen) `products` starts empty, and diffing against an
    // empty list would make every cart item look "removed from catalogue"
    // even though nothing actually changed. Don't clear the resume request
    // yet either: once productsLoaded flips true, this effect re-runs and
    // picks the same pending request back up.
    if (!productsLoaded) return;
    const target = drafts[resumeCustomerId];
    if (target) {
      // If a different bill is currently open with items, save it first so
      // switching bubbles never silently loses work.
      if (customer && customer.id !== resumeCustomerId && Object.keys(cartQty).length > 0) {
        saveCurrentAsDraft();
      }
      applyDraft(target);
    }
    clearResumeRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeToken, productsLoaded]);

  // ── Keep the "has an unsaved bill open" flag in sync ───────────────
  // Layout uses this to decide whether to intercept sidebar navigation.
  useEffect(() => {
    setHasUnsavedActiveBill(step === "billing" && Object.keys(cartQty).length > 0);
  }, [step, cartQty, setHasUnsavedActiveBill]);

  // ── Register handlers Layout's "leave unsaved bill?" dialog calls ──
  useEffect(() => {
    registerExitHandlers({
      onDiscard: () => {
        if (customer?.id) removeDraftFromStore(customer.id);
        resetBilling();
      },
      onSaveAndMinimize: () => {
        saveCurrentAsDraft();
        resetBilling();
      },
    });
    return () => registerExitHandlers(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer, cartQty, cartOverrides, paidAmount, paymentMode, notes, selectedRegion]);

  // ── Safety net for exits we can't intercept (browser back/forward, tab
  // close) — silently save-and-minimize on unmount so nothing is lost even
  // without the confirmation dialog. Reads a ref so it always sees the
  // latest values, regardless of when React tears the component down.
  const latestBillRef = useRef({
    step, customer, cartQty, cartOverrides, paidAmount, paymentMode, notes, selectedRegion, grandTotal: 0 as number,
  });
  useEffect(() => {
    latestBillRef.current = { step, customer, cartQty, cartOverrides, paidAmount, paymentMode, notes, selectedRegion, grandTotal };
  });
  useEffect(() => {
    return () => {
      const s = latestBillRef.current;
      if (s.step === "billing" && s.customer?.id && Object.keys(s.cartQty).length > 0) {
        useBillingDraftsStore.getState().saveDraft(s.customer.id, {
          customer: s.customer,
          cartQty: { ...s.cartQty },
          cartOverrides: { ...s.cartOverrides },
          paidAmount: s.paidAmount,
          paymentMode: s.paymentMode,
          notes: s.notes,
          selectedRegion: s.selectedRegion,
          productSnapshot: {}, // best-effort on an implicit exit — diffed again fully on next explicit save
          lastKnownTotal: s.grandTotal,
        });
      }
      useBillingDraftsStore.getState().setActiveCustomerId(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // filteredCustomers: Tamil search results further narrowed by selected region chip
  const filteredCustomers = useMemo(() => {
    const searched = customerSearchResults as unknown as Customer[];
    if (!selectedRegion) return searched;
    return searched.filter((c) => c.regionId === selectedRegion);
  }, [customerSearchResults, selectedRegion]);

  // ─── CUSTOMER SELECTION SCREEN ────────────────────────────────────

  if (step === "select-customer") {
    return (
      <div className="p-3 md:p-6 max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
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

        {/* WhatsApp notification prompt */}
        {whatsappData && (
          <div className="flex items-center gap-3 bg-[#e9fbe5] border border-[#25d366]/40 rounded-xl px-4 py-3 mb-5">
            <span className="text-2xl flex-shrink-0">💬</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800">Send order details on WhatsApp?</p>
              <p className="text-xs text-gray-500 truncate">{whatsappData.phone}</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => { openWhatsApp(whatsappData.phone, whatsappData.message); setWhatsappData(null); }}
                className="bg-[#25d366] text-white text-xs font-semibold px-3 py-1.5 rounded-lg hover:bg-[#1ebe5d] transition-all"
              >
                Send
              </button>
              <button
                onClick={() => setWhatsappData(null)}
                className="border border-gray-300 text-gray-500 text-xs px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-all"
              >
                Skip
              </button>
            </div>
          </div>
        )}

        {/* Customer search */}
        <div className="mb-3">
          <TamilSearchInput
            value={customerSearch}
            onChange={setCustomerSearch}
            placeholder="Search by shop, owner, phone, region… (supports Tamil)"
          />
        </div>

        {/* Region filter chips — tap a region to show only its customers */}
        {!loading && regions.length > 0 && (
          <div className="flex gap-2 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
            <button
              onClick={() => setSelectedRegion("")}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-all flex-shrink-0 ${
                !selectedRegion
                  ? "bg-orange-500 text-white border-orange-500"
                  : "bg-white text-gray-500 border-gray-200 hover:border-orange-300"
              }`}
            >
              All Regions
            </button>
            {regions.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelectedRegion(selectedRegion === r.id ? "" : r.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border whitespace-nowrap transition-all flex-shrink-0 ${
                  selectedRegion === r.id
                    ? "bg-orange-500 text-white border-orange-500"
                    : "bg-white text-gray-500 border-gray-200 hover:border-orange-300"
                }`}
              >
                {r.name}
                {selectedRegion === r.id && (
                  <span className="ml-1 opacity-70">
                    ({filteredCustomers.length})
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

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
                    {drafts[c.id!] && Object.keys(drafts[c.id!].cartQty ?? {}).length > 0 && (
                      <p className="text-xs text-orange-500 mt-1">📋 Draft saved — tap to resume</p>
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

          {/* Minimize / Close — top-right, always available */}
          <button
            onClick={handleMinimize}
            title="Minimize this bill"
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 12h12" />
            </svg>
          </button>
          <button
            onClick={() => setShowCloseDialog(true)}
            title="Close this billing"
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-red-50 hover:text-red-600 flex-shrink-0"
          >
            ✕
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
        <div className="flex-1 flex flex-col overflow-hidden max-w-3xl mx-auto w-full min-w-0">
          {/* Search */}
          <div className="px-4 py-3">
            <TamilSearchInput
              value={searchQuery}
              onChange={(val) => { setSearchQuery(val); setSelectedCategory("All"); }}
              placeholder="Search product, category, barcode… (supports Tamil)"
            />
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
                  const override = cartOverrides[p.id!];
                  const effName  = override?.name ?? p.name;
                  const effPrice = override?.price ?? getSlabPrice(p, 1);
                  return (
                    <button key={p.id} onClick={() => addToCart(p)} disabled={disabled}
                      className="bg-white border border-gray-100 rounded-xl p-2.5 text-left min-w-[110px] hover:border-orange-200 shadow-sm disabled:opacity-40 flex-shrink-0">
                      <p className="text-xs font-medium text-gray-800 truncate max-w-[90px] sm:max-w-[120px]">{effName}</p>
                      <p className="text-xs text-gray-400">₹{fmtPrice(effPrice)}</p>
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
                  override={cartOverrides[p.id!]}
                  onAdd={() => addToCart(p)}
                  onRemove={() => removeFromCart(p)}
                  onQtyTapped={() => setQtyDialogProduct(p)}
                  onProductTapped={() => setProductEditTarget(p)}
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
                  onPriceTapped={() => {
                    const p = products.find((x) => x.id === item.productId);
                    if (p) setProductEditTarget(p);
                  }}
                  isOverridden={overriddenProductIds.has(item.productId)}
                />
              ))}

              {/* Summary card */}
              <div className="bg-white rounded-xl border border-gray-100 p-4 mb-3 shadow-sm">
                {/* Taxable base */}
                <div className="flex justify-between text-sm text-gray-500 mb-1.5">
                  <span>Taxable amount</span>
                  <span>₹{fmtPrice(itemsTotal)}</span>
                </div>
                {/* GST row — shown for both inclusive and exclusive */}
                {gstTotal > 0 && (
                  <div className="flex justify-between text-sm text-gray-400 mb-1.5">
                    <span>
                      GST
                      {/* if any item is inclusive, note it */}
                      {billItems.some(i => i.taxInclusive) && " (incl. in price)"}
                    </span>
                    <span>₹{fmtPrice(gstTotal)}</span>
                  </div>
                )}
                <div className="border-t border-gray-100 mt-2 pt-2 flex justify-between font-bold text-gray-800 text-base">
                  <span>Order total</span>
                  <span>₹{fmtPrice(grandTotal)}</span>
                </div>
                {prevBalance > 0 && (
                  <>
                    <div className="flex justify-between text-sm text-red-500 mt-2">
                      <span>Previous outstanding</span>
                      <span>₹{fmtPrice(prevBalance)}</span>
                    </div>
                    <div className="flex justify-between text-sm font-semibold text-red-600 mt-1 pt-1 border-t border-red-100">
                      <span>Total due (incl. outstanding)</span>
                      <span>₹{fmtPrice(totalOwed)}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Notes */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-500 mb-1.5">Notes (optional)</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Delivery instructions, special requests…"
                  rows={2}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-orange-300"
                />
              </div>

              {/* Advance payment section */}
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-4">
                <div className="flex items-start justify-between mb-3 gap-2 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold text-blue-800">Advance Payment</p>
                    <p className="text-xs text-blue-500 mt-0.5">Leave blank to collect full amount on delivery</p>
                  </div>
                  {paidAmount && parseFloat(paidAmount) > 0 && (
                    <div className="text-right">
                      <p className="text-xs text-blue-500">Balance on delivery</p>
                      <p className="text-sm font-bold text-orange-600">
                        ₹{fmtPrice(Math.max(0, round2(grandTotal - (parseFloat(paidAmount) || 0))))}
                      </p>
                    </div>
                  )}
                </div>

                <input
                  type="number" min="0" step="0.01"
                  value={paidAmount}
                  onChange={(e) => { setPaidAmount(e.target.value); setMessage(""); }}
                  placeholder="0.00 (optional — leave blank for pay on delivery)"
                  className="w-full border border-blue-200 rounded-xl px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-300 bg-white mb-2"
                />

                {/* Quick chips — only shown when amount > 0 */}
                {grandTotal > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={() => { setPaidAmount(""); setMessage(""); }}
                      className={"px-3 py-1.5 border rounded-lg text-xs transition-all " + (!paidAmount ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-500 border-gray-200 hover:border-blue-300")}
                    >
                      Pay on delivery
                    </button>
                    {paymentSuggestions.map((amt, i) => (
                      <button key={i}
                        onClick={() => { setPaidAmount(String(amt)); setMessage(""); }}
                        className={"px-3 py-1.5 border rounded-lg text-xs transition-all " + (parseFloat(paidAmount) === amt ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-500 border-gray-200 hover:border-blue-300")}>
                        {i === 0 ? `Full ₹${fmtPrice(amt)}` : `₹${fmtPrice(amt)}`}
                      </button>
                    ))}
                  </div>
                )}

                {/* Payment mode — only relevant when advance > 0 */}
                {paidAmount && parseFloat(paidAmount) > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-blue-600 font-medium mb-1.5">Payment method for advance</p>
                    <div className="flex gap-2 flex-wrap">
                      {(["cash", "upi", "bank", "credit"] as const).map((m) => (
                        <button key={m} onClick={() => setPaymentMode(m)}
                          className={`flex-1 py-1.5 rounded-lg text-xs font-medium border capitalize transition-all ${
                            paymentMode === m
                              ? "bg-orange-500 text-white border-orange-500"
                              : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                          }`}>
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
            if (customer.id) removeDraftFromStore(customer.id);
            setShowBackDialog(false);
            resetBilling();
          }}
          onCancel={() => setShowBackDialog(false)}
        />
      )}

      {/* ── Close-billing confirmation ── */}
      {showCloseDialog && customer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl p-6 w-80 shadow-2xl">
            <p className="font-semibold text-gray-800 mb-2">Close this billing?</p>
            <p className="text-sm text-gray-500 mb-5 leading-relaxed">
              This will end the bill for <strong>{customer.shopName}</strong> and discard everything
              in it — this can't be undone.
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={handleConfirmClose}
                className="w-full bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600">
                Yes, close &amp; discard
              </button>
              <button onClick={() => setShowCloseDialog(false)}
                className="w-full text-gray-400 py-2 text-sm hover:text-gray-600">
                Cancel
              </button>
            </div>
          </div>
        </div>
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

      {/* ── Product edit dialog ── */}
      {productEditTarget && (
        <ProductEditDialog
          product={productEditTarget}
          currentOverride={cartOverrides[productEditTarget.id!]}
          existingCategories={categories.filter((c) => c !== "All")}
          onSaveToCatalogue={(override) => saveOverrideToCatalogue(productEditTarget, override)}
          onBillOnly={(override) => applyBillOnlyOverride(productEditTarget.id!, override)}
          onDismiss={() => setProductEditTarget(null)}
        />
      )}
    </div>
  );
}