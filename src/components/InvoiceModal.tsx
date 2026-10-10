import { useEffect, useState } from "react";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import { useAuthStore } from "../store/authStore";
import { buildInvoicePDF } from "../utils/invoice";
import {
  Order, InvoiceType, BillingMode, ChargeDiscountType, AppliedChargeDiscount,
} from "../types";

// ── Invoice Modal ──────────────────────────────────────────────────
// States:
//   "setup"      — order has no invoice yet; user chooses type + due, then generates
//   "view"       — order already has an invoice; PDF renders immediately
//   "regenerate" — admin-only confirmation before voiding old number + minting new
//   "preview"    — PDF is ready to view / download / share
export default function InvoiceModal({ order, onClose, isAdmin, closeOnEscape = false, onChanged }: {
  order: Order; onClose: () => void; isAdmin: boolean;
  /** Close on Esc and stop the key reaching parent modals (used when opened over another modal). */
  closeOnEscape?: boolean;
  /** Fired after an invoice is generated / regenerated so the caller can refresh its order list. */
  onChanged?: () => void;
}) {
  const hasInvoice = !!order.invoiceNumber;

  // UI state machine
  type ModalState = "setup" | "view" | "regenerate" | "preview";
  const [modalState, setModalState] = useState<ModalState>(hasInvoice ? "view" : "setup");

  // Invoice options — pre-filled from saved data if already invoiced
  const [invoiceType, setInvoiceType] = useState<InvoiceType>(order.invoiceType ?? "estimate");
  const [billingMode, setBillingMode] = useState<BillingMode>(order.billingMode ?? "without_due");
  const [qrMode, setQrMode] = useState<"with_amount" | "without_amount">(
    hasInvoice ? ((order as any).invoicedQrMode ?? "without_amount") : "without_amount"
  );
  const [paperSize, setPaperSize] = useState<"a4" | "a5">(
    hasInvoice ? ((order as any).invoicedPaperSize ?? "a4") : "a4"
  );
  const [customerDue, setCustomerDue] = useState(
    hasInvoice && order.billingMode === "with_due" ? String((order as any).invoicedDue ?? 0) : ""
  );
  const [loadingDefaults, setLoadingDefaults] = useState(!hasInvoice); // only wait on first-time generation

  // Charges & Discounts — admin-configured types loaded from settings, and the
  // subset the user has actually chosen to apply on this invoice (with values).
  const [chargeDiscountTypes, setChargeDiscountTypes] = useState<ChargeDiscountType[]>([]);
  const [selectedCharges, setSelectedCharges] = useState<Record<string, AppliedChargeDiscount>>(
    () => {
      const initial: Record<string, AppliedChargeDiscount> = {};
      (order.appliedCharges ?? []).forEach((cd) => { initial[cd.id] = cd; });
      return initial;
    }
  );

  // Working invoice number — locked once minted, never changes except on regen
  const [invoiceNumber, setInvoiceNumber] = useState<string>(order.invoiceNumber || "");

  const [customerData, setCustomerData] = useState<any>(null);
  const [pdfUrl, setPdfUrl]             = useState<string | null>(null);
  const [invoiceHtml, setInvoiceHtml]   = useState<string | null>(null);
  const [loadingDue, setLoadingDue]     = useState(false);
  const [generating, setGenerating]     = useState(false);
  const [regenReason, setRegenReason]   = useState("");

  // Flattened, order-stable list of charges/discounts the user has switched on.
  // `.amount` here is the raw entered value for flat mode, or left as the % for
  // percentage mode — buildInvoicePDF resolves percentage against totalPayable.
  const selectedChargesArray: AppliedChargeDiscount[] = chargeDiscountTypes
    .filter((t) => selectedCharges[t.id])
    .map((t) => {
      const sel = selectedCharges[t.id];
      return {
        id: t.id, name: t.name, kind: t.kind, mode: t.mode,
        value: sel.value, amount: sel.value,
      };
    });

  const toggleCharge = (type: ChargeDiscountType) => {
    setSelectedCharges((prev) => {
      const next = { ...prev };
      if (next[type.id]) {
        delete next[type.id];
      } else {
        next[type.id] = {
          id: type.id, name: type.name, kind: type.kind, mode: type.mode,
          value: type.defaultValue ?? 0, amount: type.defaultValue ?? 0,
        };
      }
      return next;
    });
  };

  const updateChargeValue = (id: string, value: number) => {
    setSelectedCharges((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], value, amount: value } } : prev);
  };

  // Load customer data once
  useEffect(() => {
    if (!order.customerId) return;
    setLoadingDue(true);
    getDoc(doc(db, "customers", order.customerId)).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setCustomerData(data);
        if (!hasInvoice) {
          const currentDue    = data.outstandingDue ?? 0;
          const orderBalance  = (order as any).balanceDue ?? 0;
          const historicalDue = Math.max(0, Math.round((currentDue - orderBalance) * 100) / 100);
          if (historicalDue > 0) {
            setCustomerDue(String(historicalDue));
            setBillingMode("with_due");
          }
        }
      }
      setLoadingDue(false);
    }).catch(() => setLoadingDue(false));

    // Also load biz settings to get default QR mode
    getDoc(doc(db, "settings", "business")).then((snap) => {
      if (snap.exists()) {
        const biz = snap.data();
        if (!hasInvoice) {
          if (biz.defaultInvoiceType) setInvoiceType(biz.defaultInvoiceType);
          if (biz.defaultBillingMode) setBillingMode(biz.defaultBillingMode);
          setQrMode(biz.defaultQrMode ?? "without_amount");
          setPaperSize((biz as any).defaultPaperSize ?? "a4");
        }
        setChargeDiscountTypes((biz as any).chargeDiscountTypes ?? []);
      }
      setLoadingDefaults(false);
    }).catch(() => setLoadingDefaults(false));
  }, [order.customerId]);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); };
  }, [pdfUrl]);

  // Auto-render PDF when entering "view" state — wait for customerData to be ready
  useEffect(() => {
    if (modalState === "view" && !pdfUrl && !generating && !loadingDue) {
      const t = setTimeout(() => {
        renderPdf(order.invoiceNumber!, order.invoiceType ?? "estimate", order.billingMode ?? "without_due", qrMode, undefined, customerData, order.appliedCharges ?? []);
      }, 50);
      return () => clearTimeout(t);
    }
  }, [modalState, loadingDue, customerData]);

  // ── Core render — NEVER touches the invoice counter ──────────────
  const renderPdf = async (
    invNum: string,
    invType: InvoiceType,
    billMode: BillingMode,
    qrModeVal: "with_amount" | "without_amount" = qrMode,
    paperSizeOverride?: "a4" | "a5",
    customerOverride?: any,
    appliedChargesOverride?: AppliedChargeDiscount[],
  ) => {
    setGenerating(true);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    const custData = customerOverride !== undefined ? customerOverride : customerData;
    const charges  = appliedChargesOverride !== undefined ? appliedChargesOverride : selectedChargesArray;
    try {
      const orderWithMeta = { ...order, invoiceNumber: invNum, invoiceType: invType, billingMode: billMode, appliedCharges: charges };
      const { pdf, html } = await buildInvoicePDF(orderWithMeta as any, custData || undefined, {
        invoiceType: invType,
        billingMode: billMode,
        customerDue: billMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
        qrMode: qrModeVal,
        appliedCharges: charges,
      }, paperSizeOverride ?? paperSize);
      setInvoiceHtml(html);
      setPdfUrl(URL.createObjectURL(pdf.output("blob")));
      setModalState("preview");
    } finally {
      setGenerating(false);
    }
  };

  // ── GENERATE (first time) ─────────────────────────────────────────
  // Mint number → save to Firestore → render PDF. Counter increments exactly once.
  const handleGenerate = async () => {
    setGenerating(true);
    try {
      // 1. Fetch business settings to get prefix
      const bizSnap = await getDoc(doc(db, "settings", "business"));
      const prefix  = bizSnap.exists() ? (bizSnap.data().invoicePrefix || "INV") : "INV";

      // 2. Mint invoice number atomically (counter increments here, exactly once)
      const { mintInvoiceNumber } = await import("../utils/invoice");
      const minted = await mintInvoiceNumber(prefix);

      // 3. Persist everything to the order doc BEFORE rendering.
      // appliedCharges is saved as-entered; buildInvoicePDF resolves percentage
      // values to a frozen ₹ amount at render time, so re-viewing this invoice
      // later (via "view" state) reproduces the exact same figures.
      await updateDoc(doc(db, "orders", order.id!), {
        invoiceNumber: minted,
        invoiceType,
        billingMode,
        invoicedDue: billingMode === "with_due" ? (parseFloat(customerDue) || 0) : 0,
        invoicedQrMode: qrMode,
        invoicedPaperSize: paperSize,
        invoicedAt: new Date().toISOString(),
        appliedCharges: selectedChargesArray,
      });

      setInvoiceNumber(minted);
      onChanged?.();

      // 4. Render PDF with the locked number
      await renderPdf(minted, invoiceType, billingMode, qrMode, undefined, undefined, selectedChargesArray);
    } catch (e: any) {
      alert("Failed to generate invoice: " + e.message);
      setGenerating(false);
    }
  };

  // ── REGENERATE (admin only) ───────────────────────────────────────
  // Void old number (save to voidedInvoices[]) → mint new → save → render.
  const handleRegenerate = async () => {
    if (!regenReason.trim()) return;
    setGenerating(true);
    try {
      const { user: authUser } = useAuthStore.getState();

      const bizSnap = await getDoc(doc(db, "settings", "business"));
      const prefix  = bizSnap.exists() ? (bizSnap.data().invoicePrefix || "INV") : "INV";

      const { mintInvoiceNumber } = await import("../utils/invoice");
      const minted = await mintInvoiceNumber(prefix);

      // Record the voided invoice
      const voidedEntry = {
        invoiceNumber: order.invoiceNumber!,
        voidedAt:      new Date().toISOString(),
        voidedBy:      authUser!.uid,
        voidedByName:  authUser!.name,
        reason:        regenReason.trim(),
      };
      const existingVoided = (order as any).voidedInvoices ?? [];

      await updateDoc(doc(db, "orders", order.id!), {
        invoiceNumber:   minted,
        invoiceType,
        billingMode,
        invoicedDue:     billingMode === "with_due" ? (parseFloat(customerDue) || 0) : 0,
        invoicedQrMode:     qrMode,
        invoicedPaperSize:  paperSize,
        invoicedAt:      new Date().toISOString(),
        voidedInvoices:  [...existingVoided, voidedEntry],
        appliedCharges:  selectedChargesArray,
      });

      setInvoiceNumber(minted);
      onChanged?.();
      setRegenReason("");
      await renderPdf(minted, invoiceType, billingMode, qrMode, undefined, undefined, selectedChargesArray);
    } catch (e: any) {
      alert("Failed to regenerate invoice: " + e.message);
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    const prefix = invoiceType === "gst" ? "invoice" : "estimate";
    const orderWithMeta = { ...order, invoiceNumber, invoiceType, billingMode, appliedCharges: selectedChargesArray };
    const { pdf } = await buildInvoicePDF(orderWithMeta as any, customerData || undefined, {
      invoiceType,
      billingMode,
      customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
      qrMode,
      appliedCharges: selectedChargesArray,
    }, paperSize);
    pdf.save(`${prefix}-${invoiceNumber}.pdf`);
  };

  const handleShare = async () => {
    try {
      const prefix = invoiceType === "gst" ? "invoice" : "estimate";
      const orderWithMeta = { ...order, invoiceNumber, invoiceType, billingMode, appliedCharges: selectedChargesArray };
      const { pdf } = await buildInvoicePDF(orderWithMeta as any, customerData || undefined, {
        invoiceType,
        billingMode,
        customerDue: billingMode === "with_due" ? parseFloat(customerDue) || 0 : 0,
        qrMode,
        appliedCharges: selectedChargesArray,
      }, paperSize);
      const blob = pdf.output("blob");
      const file = new File([blob], `${prefix}-${invoiceNumber}.pdf`, { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Invoice - ${order.customerName}`, text: `Invoice ₹${order.totalAmount.toFixed(2)}` });
      } else {
        const rawPhone = (order.customerPhone || "").replace(/[^\d]/g, "");
        const phone10  = rawPhone.slice(-10);
        if (phone10.length < 10) { alert("No valid phone for this customer."); return; }
        const msg = encodeURIComponent(`Dear ${order.customerName},\nYour invoice for ₹${order.totalAmount.toFixed(2)} is ready.\nInvoice No: ${invoiceNumber}\nThank you!`);
        window.open(`https://wa.me/91${phone10}?text=${msg}`, "_blank");
      }
    } catch (err: any) {
      if (err.name !== "AbortError") alert("Could not share: " + err.message);
    }
  };

  const isWide = modalState === "preview";

  // When stacked over another modal (e.g. the customer ledger), Esc must close
  // only this modal. Capture phase + stopImmediatePropagation keeps the key
  // from reaching the parent modal's own Esc handler.
  useEffect(() => {
    if (!closeOnEscape) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!generating) onClose();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [closeOnEscape, generating, onClose]);

  return (
    <div className={`fixed inset-0 bg-black/60 flex items-center justify-center ${closeOnEscape ? "z-[60]" : "z-50"} p-0 md:p-4`}>
      {/* Modal is ALWAYS full size — never resizes, preventing page reflow glitch */}
      <div className="relative bg-white rounded-none md:rounded-2xl shadow-2xl flex flex-col w-full max-w-4xl h-screen md:h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">
              {modalState === "setup" ? "Generate Invoice" :
               modalState === "regenerate" ? "Regenerate Invoice" : "Invoice"}
            </h3>
            <p className="text-sm text-gray-500 flex items-center gap-2 flex-wrap">
              <span>{order.customerName} · ₹{order.totalAmount.toFixed(2)}</span>
              {invoiceNumber && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-mono font-semibold">
                  #{invoiceNumber}
                </span>
              )}
              {invoiceType === "gst" && invoiceNumber && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Tax Invoice</span>
              )}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl p-1">✕</button>
        </div>

        {/* ── GENERATING OVERLAY — shown during PDF render ── */}
        {generating && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center rounded-2xl z-10">
            <div className="flex flex-col items-center gap-4">
              <div className="w-12 h-12 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
              <p className="text-sm font-medium text-gray-600">Building invoice…</p>
              <p className="text-xs text-gray-400">This takes a few seconds</p>
            </div>
          </div>
        )}

        {/* ── SETUP STATE — first-time generation ── */}
        {modalState === "setup" && (
          <div className="flex-1 overflow-y-auto flex items-start justify-center">
            {loadingDefaults ? (
              <div className="flex flex-col items-center justify-center gap-4 h-full py-24">
                <div className="w-10 h-10 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
                <p className="text-sm text-gray-500 font-medium">Loading invoice defaults…</p>
              </div>
            ) : (
            <div className="w-full max-w-md p-6 space-y-5">
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
                ⚠️ Choose carefully — once generated, the invoice number is <strong>permanently locked</strong> to this order. Only admins can regenerate with a new number.
              </div>

              {/* Invoice type */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Invoice Type *</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["gst", "estimate"] as InvoiceType[]).map((t) => (
                    <button key={t} onClick={() => setInvoiceType(t)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        invoiceType === t ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{t === "gst" ? "🧾 Tax Invoice" : "📄 Estimate"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{t === "gst" ? "CGST + SGST, for GST filing" : "No GST breakdown, not for IT filing"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Billing mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Outstanding Due on Bill</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["without_due", "with_due"] as BillingMode[]).map((m) => (
                    <button key={m} onClick={() => setBillingMode(m)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        billingMode === m ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{m === "without_due" ? "Current bill only" : "Include previous due"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{m === "without_due" ? "Due tracked internally" : "Shows grand total on bill"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {billingMode === "with_due" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Previous Outstanding before this order (₹)
                    {loadingDue && <span className="text-xs text-gray-400 ml-2">calculating…</span>}
                  </label>
                  <input type="number" min="0" step="0.01" value={customerDue}
                    onChange={(e) => setCustomerDue(e.target.value)} placeholder="0.00"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              )}

              {/* QR mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">UPI QR Code</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ["without_amount", "📷 QR only", "Customer types amount (B2B recommended)"],
                    ["with_amount",    "💰 QR + Amount", "Pre-fills balance due in UPI app"],
                  ] as const).map(([val, label, desc]) => (
                    <button key={val} onClick={() => setQrMode(val)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        qrMode === val ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Paper size */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Paper Size</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["a4", "a5"] as const).map((size) => (
                    <button key={size} type="button" onClick={() => setPaperSize(size)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        paperSize === size ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{size.toUpperCase()}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{size === "a4" ? "210 × 297 mm" : "148 × 210 mm"}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1">Can still be switched after generating, from the preview screen.</p>
              </div>

              {/* Charges & Discounts */}
              <ChargesDiscountsPicker
                chargeDiscountTypes={chargeDiscountTypes}
                selectedCharges={selectedCharges}
                onToggle={toggleCharge}
                onValueChange={updateChargeValue}
              />

              <div className="flex gap-3 pt-1">
                <button onClick={onClose}
                  className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleGenerate} disabled={generating}
                  className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-50">
                  {generating ? "Generating…" : "🧾 Generate Invoice"}
                </button>
              </div>
            </div>
            )}
          </div>
        )}

        {/* ── VIEW STATE — loading existing invoice ── */}
        {modalState === "view" && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-400">
              <div className="text-3xl mb-3 animate-spin">⏳</div>
              <p className="text-sm">Loading invoice #{invoiceNumber}…</p>
            </div>
          </div>
        )}

        {/* ── REGENERATE STATE — admin confirmation ── */}
        {modalState === "regenerate" && (
          <div className="flex-1 overflow-y-auto flex items-start justify-center">
            <div className="w-full max-w-md p-6 space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-4 text-sm text-red-700 space-y-1">
                <p className="font-semibold">⚠️ This will void the current invoice</p>
                <p>Invoice <span className="font-mono font-bold">#{order.invoiceNumber}</span> will be marked as cancelled in the GST report.</p>
                <p>A new invoice number will be permanently assigned to this order.</p>
              </div>

              {/* Invoice type */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">New Invoice Type</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["gst", "estimate"] as InvoiceType[]).map((t) => (
                    <button key={t} onClick={() => setInvoiceType(t)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        invoiceType === t ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{t === "gst" ? "🧾 Tax Invoice" : "📄 Estimate"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{t === "gst" ? "CGST + SGST, for GST filing" : "No GST breakdown"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Billing mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Outstanding Due on Bill</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["without_due", "with_due"] as BillingMode[]).map((m) => (
                    <button key={m} onClick={() => setBillingMode(m)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        billingMode === m ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{m === "without_due" ? "Current bill only" : "Include previous due"}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{m === "without_due" ? "Due tracked internally" : "Shows grand total on bill"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {billingMode === "with_due" && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Previous Outstanding (₹)</label>
                  <input type="number" min="0" step="0.01" value={customerDue}
                    onChange={(e) => setCustomerDue(e.target.value)} placeholder="0.00"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                </div>
              )}

              {/* QR mode */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">UPI QR Code</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ["without_amount", "📷 QR only", "Customer types amount"],
                    ["with_amount",    "💰 QR + Amount", "Pre-fills balance due"],
                  ] as const).map(([val, label, desc]) => (
                    <button key={val} onClick={() => setQrMode(val)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        qrMode === val ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Paper size */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">Paper Size</label>
                <div className="grid grid-cols-2 gap-3">
                  {(["a4", "a5"] as const).map((size) => (
                    <button key={size} type="button" onClick={() => setPaperSize(size)}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        paperSize === size ? "border-orange-500 bg-orange-50" : "border-gray-200 hover:border-gray-300"
                      }`}>
                      <p className="font-semibold text-sm">{size.toUpperCase()}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{size === "a4" ? "210 × 297 mm" : "148 × 210 mm"}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* Charges & Discounts */}
              <ChargesDiscountsPicker
                chargeDiscountTypes={chargeDiscountTypes}
                selectedCharges={selectedCharges}
                onToggle={toggleCharge}
                onValueChange={updateChargeValue}
              />

              {/* Reason */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">Reason for regeneration *</label>
                <input value={regenReason} onChange={(e) => setRegenReason(e.target.value)}
                  placeholder="e.g. Wrong customer details, GST number correction…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300" />
              </div>

              {(order as any).voidedInvoices?.length > 0 && (
                <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-500">
                  Previously voided: {(order as any).voidedInvoices.map((v: any) => (
                    <span key={v.invoiceNumber} className="font-mono mr-2 line-through text-red-400">#{v.invoiceNumber}</span>
                  ))}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button onClick={() => setModalState("preview")}
                  className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                  ← Cancel
                </button>
                <button onClick={handleRegenerate} disabled={generating || !regenReason.trim()}
                  className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50">
                  {generating ? "Regenerating…" : "🔄 Void & Regenerate"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── PREVIEW STATE — PDF ready ── */}
        {modalState === "preview" && (pdfUrl || invoiceHtml) && (
          <>
            <div className="flex-1 overflow-hidden">
              {/* Mobile: render HTML directly via srcdoc — blob PDF URLs don't work on iOS/Android */}
              {invoiceHtml && (
                <iframe
                  srcDoc={invoiceHtml}
                  className="w-full h-full border-0 md:hidden"
                  title="Invoice Preview"
                  sandbox="allow-same-origin"
                />
              )}
              {/* Desktop: use blob PDF URL for proper PDF rendering */}
              {pdfUrl && (
                <iframe
                  src={pdfUrl}
                  className="w-full h-full border-0 hidden md:block"
                  title="Invoice Preview"
                />
              )}
            </div>
            <div className="flex gap-2 p-4 border-t border-gray-100 flex-shrink-0 flex-wrap">
              {/* Paper size toggle — changing it re-renders the PDF AND persists
                  the choice back to the order, so reopening this invoice later
                  remembers it instead of reverting to whatever was saved at
                  generation time. */}
              <div className="w-full flex items-center gap-2">
                <span className="text-xs text-gray-500 font-medium">Paper:</span>
                {(["a4", "a5"] as const).map((size) => (
                  <button
                    key={size}
                    onClick={async () => {
                      setPaperSize(size);
                      await renderPdf(invoiceNumber, invoiceType, billingMode, qrMode, size);
                      if (order.id) {
                        updateDoc(doc(db, "orders", order.id), { invoicedPaperSize: size }).catch(() => {});
                      }
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-semibold border transition-all ${
                      paperSize === size
                        ? "bg-orange-500 text-white border-orange-500"
                        : "border-gray-300 text-gray-500 hover:border-orange-300"
                    }`}
                  >
                    {size.toUpperCase()}
                  </button>
                ))}
                <span className="text-xs text-gray-400 ml-1">
                  {paperSize === "a5" ? "148 × 210 mm" : "210 × 297 mm"}
                </span>
              </div>
              <button onClick={onClose}
                className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
                Close
              </button>
              <button onClick={handleDownload}
                className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600">
                ⬇️ Download
              </button>
              <button onClick={handleShare}
                className="flex-1 bg-green-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-green-600">
                📱 Share
              </button>
              {isAdmin && (
                <button onClick={() => setModalState("regenerate")}
                  className="w-full border border-red-200 text-red-600 py-2 rounded-xl text-xs hover:bg-red-50 mt-1">
                  🔄 Regenerate Invoice (Admin)
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Charges & Discounts picker (used in both setup and regenerate screens) ──
function ChargesDiscountsPicker({
  chargeDiscountTypes,
  selectedCharges,
  onToggle,
  onValueChange,
}: {
  chargeDiscountTypes: ChargeDiscountType[];
  selectedCharges: Record<string, AppliedChargeDiscount>;
  onToggle: (type: ChargeDiscountType) => void;
  onValueChange: (id: string, value: number) => void;
}) {
  const activeTypes = chargeDiscountTypes.filter((t) => t.active);
  if (activeTypes.length === 0) return null;

  const charges = activeTypes.filter((t) => t.kind === "charge");
  const discounts = activeTypes.filter((t) => t.kind === "discount");

  const renderRow = (type: ChargeDiscountType) => {
    const sel = selectedCharges[type.id];
    const isSelected = !!sel;
    return (
      <div key={type.id} className={`rounded-xl border-2 transition-all ${
        isSelected ? (type.kind === "discount" ? "border-green-400 bg-green-50" : "border-orange-400 bg-orange-50") : "border-gray-200"
      }`}>
        <button type="button" onClick={() => onToggle(type)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-left">
          <span className="flex items-center gap-2">
            <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${
              isSelected ? (type.kind === "discount" ? "bg-green-500 border-green-500 text-white" : "bg-orange-500 border-orange-500 text-white") : "border-gray-300"
            }`}>
              {isSelected ? "✓" : ""}
            </span>
            <span className="font-medium text-sm text-gray-700">{type.name}</span>
          </span>
          <span className="text-xs text-gray-400">{type.mode === "percentage" ? "%" : "₹ flat"}</span>
        </button>
        {isSelected && (
          <div className="px-3 pb-3 flex items-center gap-2">
            <input
              type="number" min="0" step="0.01"
              value={sel.value}
              onChange={(e) => onValueChange(type.id, parseFloat(e.target.value) || 0)}
              className="w-28 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
            <span className="text-xs text-gray-400">{type.mode === "percentage" ? "% of bill" : "₹"}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <label className="block text-sm font-semibold text-gray-700 mb-2">Charges & Discounts (optional)</label>
      <div className="space-y-2">
        {charges.map(renderRow)}
        {discounts.map(renderRow)}
      </div>
    </div>
  );
}

