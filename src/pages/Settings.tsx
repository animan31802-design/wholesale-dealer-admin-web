import { useEffect, useState, useCallback } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { WorkCalendar, DEFAULT_CALENDAR } from "./StaffAttendance";
import { db } from "../firebase/config";
import QRCode from "qrcode";
import { ChargeDiscountType } from "../types";

export interface BusinessSettings {
  businessName: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  alternatePhone: string;
  email: string;
  gstin: string;
  fssaiNumber: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  upiId: string;
  invoicePrefix: string;
  invoiceFooter: string;
  defaultInvoiceType: "gst" | "estimate";
  defaultBillingMode: "with_due" | "without_due";
  defaultQrMode: "with_amount" | "without_amount";
  defaultPaperSize: "a4" | "a5";
  chargeDiscountTypes?: ChargeDiscountType[];
  // Hours a minimized/floating billing draft is kept before it's considered
  // stale (greyed out) and eventually auto-discarded. Configurable per business.
  draftBillExpiryHours?: number;
}

const EMPTY: BusinessSettings = {
  businessName: "", address: "", city: "", state: "Tamil Nadu",
  pincode: "", phone: "", alternatePhone: "", email: "",
  gstin: "", fssaiNumber: "", bankName: "", accountNumber: "",
  ifscCode: "", upiId: "", invoicePrefix: "INV",
  invoiceFooter: "Thank you for your business!",
  defaultInvoiceType: "estimate", defaultBillingMode: "without_due",
  defaultQrMode: "without_amount", defaultPaperSize: "a4",
  chargeDiscountTypes: [],
  draftBillExpiryHours: 3,
};

export async function getBusinessSettings(): Promise<BusinessSettings> {
  const snap = await getDoc(doc(db, "settings", "business"));
  if (snap.exists()) return snap.data() as BusinessSettings;
  return EMPTY;
}

export default function Settings() {
  const [form, setForm]               = useState<BusinessSettings>(EMPTY);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [saved, setSaved]             = useState(false);
  const [testQr, setTestQr]           = useState<string>("");
  const [standAloneQr, setStandAloneQr] = useState<string>("");
  const [calendar, setCalendar]       = useState<WorkCalendar>(DEFAULT_CALENDAR);
  const [calSaving, setCalSaving]     = useState(false);
  const [calSaved, setCalSaved]       = useState(false);
  const [newHolidayDate, setNewHolidayDate]   = useState("");
  const [newHolidayLabel, setNewHolidayLabel] = useState("");

  const generateQRs = useCallback(async (upiId: string) => {
    if (!upiId.trim()) { setTestQr(""); setStandAloneQr(""); return; }
    try {
      const opts = { width: 160, margin: 1, color: { dark: "#000000", light: "#ffffff" } };
      const [testUrl, standUrl] = await Promise.all([
        QRCode.toDataURL(`upi://pay?pa=${encodeURIComponent(upiId)}&pn=Test&am=1.00&cu=INR`, opts),
        QRCode.toDataURL(`upi://pay?pa=${encodeURIComponent(upiId)}&cu=INR`, opts),
      ]);
      setTestQr(testUrl); setStandAloneQr(standUrl);
    } catch { setTestQr(""); setStandAloneQr(""); }
  }, []);

  useEffect(() => {
    Promise.all([
      getBusinessSettings(),
      getDoc(doc(db, "settings", "workCalendar")),
    ]).then(([data, calSnap]) => {
      setForm({
        ...data,
        chargeDiscountTypes: data.chargeDiscountTypes ?? [],
        draftBillExpiryHours: data.draftBillExpiryHours ?? 3,
      });
      if (calSnap.exists()) setCalendar(calSnap.data() as WorkCalendar);
      setLoading(false);
      if (data.upiId) generateQRs(data.upiId);
    });
  }, []);

  const set = (key: keyof BusinessSettings, value: string) =>
    setForm(f => ({ ...f, [key]: value }));

  // ── Charges & Discounts management ────────────────────────────────────────
  const cdTypes = form.chargeDiscountTypes ?? [];

  const addChargeDiscountType = () => {
    const id = `cd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setForm(f => ({
      ...f,
      chargeDiscountTypes: [
        ...(f.chargeDiscountTypes ?? []),
        { id, name: "", kind: "charge", mode: "flat", defaultValue: 0, active: true },
      ],
    }));
  };

  const updateChargeDiscountType = (id: string, patch: Partial<ChargeDiscountType>) => {
    setForm(f => ({
      ...f,
      chargeDiscountTypes: (f.chargeDiscountTypes ?? []).map(c =>
        c.id === id ? { ...c, ...patch } : c
      ),
    }));
  };

  const removeChargeDiscountType = (id: string) => {
    setForm(f => ({
      ...f,
      chargeDiscountTypes: (f.chargeDiscountTypes ?? []).filter(c => c.id !== id),
    }));
  };

  const handleSave = async () => {
    if (!form.businessName.trim()) { alert("Business name is required."); return; }
    if (!form.defaultInvoiceType) { alert("Please select a Default Invoice Type."); return; }
    if ((form.chargeDiscountTypes ?? []).some(c => !c.name.trim())) {
      alert("Every Charge/Discount must have a name (or delete the empty row).");
      return;
    }
    setSaving(true); setSaved(false);
    try {
      await setDoc(doc(db, "settings", "business"), form);
      setSaved(true); setTimeout(() => setSaved(false), 3000);
    } catch (err) { alert("Failed to save settings. Try again."); }
    finally { setSaving(false); }
  };

  const handleSaveCalendar = async () => {
    setCalSaving(true); setCalSaved(false);
    await setDoc(doc(db, "settings", "workCalendar"), calendar);
    setCalSaving(false); setCalSaved(true);
    setTimeout(() => setCalSaved(false), 3000);
  };

  const addHoliday = () => {
    if (!newHolidayDate) return;
    const label = newHolidayLabel.trim() || "Holiday";
    if (calendar.holidays.some(h => h.date === newHolidayDate)) return;
    setCalendar(c => ({
      ...c,
      holidays: [...c.holidays, { date: newHolidayDate, label }]
        .sort((a, b) => a.date.localeCompare(b.date)),
    }));
    setNewHolidayDate(""); setNewHolidayLabel(""); setCalSaved(false);
  };

  const removeHoliday = (date: string) => {
    setCalendar(c => ({ ...c, holidays: c.holidays.filter(h => h.date !== date) }));
    setCalSaved(false);
  };

  const toggleWeeklyOff = (day: number) => {
    setCalendar(c => ({
      ...c,
      weeklyOff: c.weeklyOff.includes(day)
        ? c.weeklyOff.filter(d => d !== day)
        : [...c.weeklyOff, day].sort(),
    }));
    setCalSaved(false);
  };

  if (loading) return (
    <div className="p-8 flex items-center gap-3 text-gray-400">
      <span className="animate-spin text-xl">⏳</span> Loading settings...
    </div>
  );

  return (
    <div className="p-3 md:p-6 max-w-3xl mx-auto">
      <div className="flex items-start justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Settings</h2>
          <p className="text-sm text-gray-400 mt-0.5">Business details used across all invoices and bills</p>
        </div>
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all">
          {saving ? "Saving..." : saved ? "✅ Saved!" : "Save Settings"}
        </button>
      </div>

      <div className="space-y-5">

        {/* Business Info */}
        <Section title="Business Information">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Business / Shop Name *" span={2}>
              <input value={form.businessName} onChange={e => set("businessName", e.target.value)}
                placeholder="e.g. Sri Murugan Wholesale Traders" className={inp} />
            </Field>
            <Field label="Address Line *" span={2}>
              <input value={form.address} onChange={e => set("address", e.target.value)}
                placeholder="Door No., Street Name" className={inp} />
            </Field>
            <Field label="City *">
              <input value={form.city} onChange={e => set("city", e.target.value)}
                placeholder="e.g. Chennai" className={inp} />
            </Field>
            <Field label="State">
              <input value={form.state} onChange={e => set("state", e.target.value)}
                placeholder="Tamil Nadu" className={inp} />
            </Field>
            <Field label="Pincode">
              <input value={form.pincode} onChange={e => set("pincode", e.target.value)}
                placeholder="600001" maxLength={6} className={inp} />
            </Field>
            <Field label="Email">
              <input value={form.email} onChange={e => set("email", e.target.value)}
                placeholder="business@example.com" className={inp} />
            </Field>
            <Field label="Primary Phone *">
              <input value={form.phone} onChange={e => set("phone", e.target.value)}
                placeholder="9876543210" maxLength={10} className={inp} />
            </Field>
            <Field label="Alternate Phone">
              <input value={form.alternatePhone} onChange={e => set("alternatePhone", e.target.value)}
                placeholder="9876543211" maxLength={10} className={inp} />
            </Field>
          </div>
        </Section>

        {/* Tax Info */}
        <Section title="Tax & Regulatory">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="GSTIN">
              <input value={form.gstin} onChange={e => set("gstin", e.target.value.toUpperCase())}
                placeholder="22AAAAA0000A1Z5" maxLength={15} className={inp} />
              <p className="text-xs text-gray-400 mt-1">Leave blank if not GST registered</p>
            </Field>
            <Field label="FSSAI Number">
              <input value={form.fssaiNumber} onChange={e => set("fssaiNumber", e.target.value)}
                placeholder="Food license number (if applicable)" className={inp} />
            </Field>
          </div>
        </Section>

        {/* Bank */}
        <Section title="Bank & Payment Details">
          <p className="text-xs text-gray-400 mb-3">Shown on GST invoices for bank transfer payments</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Bank Name">
              <input value={form.bankName} onChange={e => set("bankName", e.target.value)}
                placeholder="e.g. State Bank of India" className={inp} />
            </Field>
            <Field label="Account Number">
              <input value={form.accountNumber} onChange={e => set("accountNumber", e.target.value)}
                placeholder="Account number" className={inp} />
            </Field>
            <Field label="IFSC Code">
              <input value={form.ifscCode} onChange={e => set("ifscCode", e.target.value.toUpperCase())}
                placeholder="SBIN0001234" maxLength={11} className={inp} />
            </Field>
            <Field label="UPI ID">
              <input value={form.upiId} onChange={e => { set("upiId", e.target.value); generateQRs(e.target.value); }}
                placeholder="yourname@upi" className={inp} />
            </Field>
          </div>
        </Section>

        {/* UPI QR */}
        {form.upiId && (
          <Section title="UPI QR Codes">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="flex flex-col items-center bg-orange-50 border border-orange-100 rounded-xl p-5">
                <p className="text-sm font-semibold text-orange-700 mb-1">₹1 Test QR</p>
                <p className="text-xs text-orange-400 mb-3 text-center">Scan this to verify your UPI ID is working correctly</p>
                {testQr ? (
                  <>
                    <img src={testQr} alt="Test QR" className="w-36 h-36 rounded-lg border border-orange-200" />
                    <p className="text-xs text-gray-400 mt-2 font-mono">{form.upiId}</p>
                    <span className="mt-2 text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full font-medium">Amount: ₹1.00</span>
                  </>
                ) : <div className="w-36 h-36 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-sm">Generating...</div>}
              </div>
              <div className="flex flex-col items-center bg-green-50 border border-green-100 rounded-xl p-5">
                <p className="text-sm font-semibold text-green-700 mb-1">Payment QR</p>
                <p className="text-xs text-green-500 mb-3 text-center">Show this to customers — they type the amount in their UPI app</p>
                {standAloneQr ? (
                  <>
                    <img src={standAloneQr} alt="Payment QR" className="w-36 h-36 rounded-lg border border-green-200" />
                    <p className="text-xs text-gray-400 mt-2 font-mono">{form.upiId}</p>
                    <a href={standAloneQr} download={`payment-qr-${form.upiId}.png`}
                      className="mt-2 text-xs bg-green-500 text-white px-3 py-1 rounded-full font-medium hover:bg-green-600 transition-all">
                      ⬇ Download QR
                    </a>
                  </>
                ) : <div className="w-36 h-36 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-sm">Generating...</div>}
              </div>
            </div>
          </Section>
        )}

        {/* Invoice Defaults */}
        <Section title="Invoice Defaults">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Invoice Number Prefix">
              <input value={form.invoicePrefix} onChange={e => set("invoicePrefix", e.target.value.toUpperCase())}
                placeholder="INV" maxLength={6} className={inp} />
              <p className="text-xs text-gray-400 mt-1">Bills will be numbered like {form.invoicePrefix || "INV"}-2025-001</p>
            </Field>
            <Field label="Default Invoice Type">
              <select value={form.defaultInvoiceType} onChange={e => set("defaultInvoiceType", e.target.value)} className={inp}>
                <option value="estimate">Estimate Bill (no GST)</option>
                <option value="gst">Tax Invoice (with GST)</option>
              </select>
            </Field>
            <Field label="Default Due Display">
              <select value={form.defaultBillingMode} onChange={e => set("defaultBillingMode", e.target.value)} className={inp}>
                <option value="without_due">Current bill only (hide due)</option>
                <option value="with_due">Show outstanding due on bill</option>
              </select>
            </Field>
            <Field label="Default QR Code Amount">
              <select value={form.defaultQrMode} onChange={e => set("defaultQrMode", e.target.value)} className={inp}>
                <option value="without_amount">No amount — customer enters manually (recommended for B2B)</option>
                <option value="with_amount">Pre-fill balance amount in QR</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {form.defaultQrMode === "with_amount"
                  ? "QR will encode the exact balance due."
                  : "QR encodes only your UPI ID — safer for partial payments."}
              </p>
            </Field>
            <Field label="Default Paper Size">
              <div className="flex gap-2">
                {(["a4", "a5"] as const).map(size => (
                  <button key={size} type="button" onClick={() => set("defaultPaperSize", size)}
                    className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                      (form.defaultPaperSize || "a4") === size
                        ? "border-orange-500 bg-orange-50 text-orange-700"
                        : "border-gray-200 text-gray-500 hover:border-gray-300"
                    }`}>
                    {size.toUpperCase()}
                    <span className="block text-xs font-normal text-gray-400 mt-0.5">
                      {size === "a4" ? "210 × 297 mm" : "148 × 210 mm"}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">Can be overridden per print in the invoice preview.</p>
            </Field>
            <Field label="Invoice Footer Message" span={2}>
              <input value={form.invoiceFooter} onChange={e => set("invoiceFooter", e.target.value)}
                placeholder="Thank you for your business!" maxLength={100} className={inp} />
            </Field>
          </div>
        </Section>

        {/* ── Minimized Billing Drafts ─────────────────────────────────── */}
        <Section title="Minimized Billing Drafts">
          <p className="text-xs text-gray-400 mb-4">
            When an agent minimizes an in-progress bill (the floating bubble on the Create Order
            screen), it's kept for this long before it's considered stale and eventually discarded.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Keep minimized drafts for (hours)">
              <input
                type="number"
                min={1}
                max={72}
                value={form.draftBillExpiryHours ?? 3}
                onChange={e => {
                  const n = parseInt(e.target.value, 10);
                  setForm(f => ({ ...f, draftBillExpiryHours: isNaN(n) ? 3 : Math.max(1, Math.min(72, n)) }));
                }}
                className={inp}
              />
              <p className="text-xs text-gray-400 mt-1">Default is 3 hours. Applies to all agents.</p>
            </Field>
          </div>
        </Section>

        {/* ── Charges & Discounts ───────────────────────────────────────── */}
        <Section title="Charges & Discounts">
          <p className="text-xs text-gray-400 mb-4">
            Define named charges (e.g. Loading Charge, Transport Fee) or discounts (e.g. Festival Discount) that
            packing staff or admin can apply to an invoice while generating it. Only <strong>active</strong> items
            show up in the invoice generation screen.
          </p>

          {cdTypes.length === 0 ? (
            <p className="text-sm text-gray-400 italic mb-4">No charges or discounts configured yet.</p>
          ) : (
            <div className="space-y-3 mb-4">
              {cdTypes.map((cd) => (
                <div key={cd.id} className="border border-gray-200 rounded-xl p-3 flex flex-wrap items-end gap-3">
                  <Field label="Name">
                    <input value={cd.name} onChange={e => updateChargeDiscountType(cd.id, { name: e.target.value })}
                      placeholder="e.g. Loading Charge" className={inp + " w-44"} />
                  </Field>
                  <Field label="Type">
                    <select value={cd.kind} onChange={e => updateChargeDiscountType(cd.id, { kind: e.target.value as any })}
                      className={inp + " w-32"}>
                      <option value="charge">Charge (+)</option>
                      <option value="discount">Discount (−)</option>
                    </select>
                  </Field>
                  <Field label="Mode">
                    <select value={cd.mode} onChange={e => updateChargeDiscountType(cd.id, { mode: e.target.value as any })}
                      className={inp + " w-28"}>
                      <option value="flat">Flat ₹</option>
                      <option value="percentage">% of bill</option>
                    </select>
                  </Field>
                  <Field label={cd.mode === "percentage" ? "Default %" : "Default ₹"}>
                    <input type="number" min="0" step="0.01" value={cd.defaultValue ?? 0}
                      onChange={e => updateChargeDiscountType(cd.id, { defaultValue: parseFloat(e.target.value) || 0 })}
                      className={inp + " w-24"} />
                  </Field>
                  <label className="flex items-center gap-2 text-sm text-gray-600 pb-2.5">
                    <input type="checkbox" checked={cd.active}
                      onChange={e => updateChargeDiscountType(cd.id, { active: e.target.checked })}
                      className="rounded border-gray-300" />
                    Active
                  </label>
                  <button type="button" onClick={() => removeChargeDiscountType(cd.id)}
                    className="text-red-400 hover:text-red-600 text-sm font-medium pb-2.5 ml-auto">
                    Delete
                  </button>
                </div>
              ))}
            </div>
          )}

          <button type="button" onClick={addChargeDiscountType}
            className="bg-orange-50 text-orange-700 border border-orange-200 px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-100">
            + Add Charge / Discount
          </button>
        </Section>

        {/* Invoice Header Preview */}
        <Section title="Invoice Header Preview">
          <div className="overflow-x-auto -mx-4 md:mx-0">
            <div className="min-w-[320px] bg-white border border-gray-200 rounded-xl overflow-hidden mx-4 md:mx-0" style={{ fontFamily: "Arial, sans-serif", fontSize: "12px" }}>
              <table style={{width:"100%", borderCollapse:"collapse", border:"2px solid #333"}}>
                <tbody>
                  <tr>
                    <td style={{width:"25%", border:"1px solid #999", padding:"8px", verticalAlign:"top"}}>
                      <div style={{fontSize:"10px", color:"#555"}}>GSTIN:</div>
                      <div style={{fontWeight:"bold", fontSize:"11px"}}>{form.gstin || "—"}</div>
                      {form.fssaiNumber && <div style={{fontSize:"10px", color:"#555", marginTop:"4px"}}>FSSAI: {form.fssaiNumber}</div>}
                    </td>
                    <td style={{width:"50%", border:"1px solid #999", padding:"8px", textAlign:"center", verticalAlign:"middle"}}>
                      <div style={{display:"flex", alignItems:"center", justifyContent:"center", gap:"8px"}}>
                        <img src="/ptm_logo.jpeg" style={{width:"36px", height:"36px", objectFit:"contain"}} alt="logo" />
                        <div style={{fontSize:"16px", fontWeight:"bold"}}>{form.businessName || "Your Business Name"}</div>
                      </div>
                      <div style={{fontSize:"10px", color:"#444", marginTop:"4px"}}>
                        {[form.address, form.city, form.state, form.pincode ? `- ${form.pincode}` : ""].filter(Boolean).join(", ")}
                      </div>
                      {form.phone && <div style={{fontSize:"10px"}}>Ph: {form.phone}{form.alternatePhone ? ` / ${form.alternatePhone}` : ""}</div>}
                    </td>
                    <td style={{width:"25%", border:"1px solid #999", padding:"8px", textAlign:"center", verticalAlign:"middle"}}>
                      <div style={{fontSize:"14px", fontWeight:"bold", color:"#1a1a1a"}}>TAX INVOICE</div>
                      <div style={{fontSize:"10px", color:"#666", marginTop:"4px"}}>{form.invoicePrefix || "INV"}-2025-001</div>
                      <div style={{fontSize:"10px", color:"#888", marginTop:"2px"}}>Date: {new Date().toLocaleDateString("en-IN")}</div>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3} style={{border:"1px solid #999", padding:"8px"}}>
                      <table style={{width:"100%"}}>
                        <tbody>
                          <tr>
                            <td style={{width:"50%", verticalAlign:"top"}}>
                              <div style={{fontSize:"10px", color:"#555", fontWeight:"bold"}}>CONSIGNEE:</div>
                              <div style={{fontWeight:"bold", fontSize:"12px", marginTop:"2px"}}>Sample Customer</div>
                              <div style={{fontSize:"10px", color:"#555"}}>123 Example Street, Chennai</div>
                              <div style={{fontSize:"10px", color:"#555"}}>Anna Nagar</div>
                              <div style={{fontSize:"10px", color:"#555"}}>Ph: 9876543210</div>
                            </td>
                            <td style={{width:"50%", verticalAlign:"top", paddingLeft:"12px", borderLeft:"1px solid #e5e7eb"}}>
                              <div style={{fontSize:"10px", color:"#555", fontWeight:"bold"}}>ORDER INFO:</div>
                              <div style={{fontSize:"10px", marginTop:"2px"}}>Order: #PREVIEW001</div>
                              <div style={{fontSize:"10px"}}>Agent: Field Agent</div>
                              <div style={{fontSize:"10px"}}>Payment: Cash</div>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </tbody>
              </table>
              <table style={{width:"100%", borderCollapse:"collapse", border:"1px solid #999", borderTop:"none"}}>
                <thead>
                  <tr style={{background:"#f3f4f6"}}>
                    <th style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"left", fontSize:"10px"}}>#</th>
                    <th style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"left", fontSize:"10px"}}>Product</th>
                    <th style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"center", fontSize:"10px"}}>Qty</th>
                    <th style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"right", fontSize:"10px"}}>Rate</th>
                    <th style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"right", fontSize:"10px"}}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{border:"1px solid #eee", padding:"5px 8px", fontSize:"10px"}}>1</td>
                    <td style={{border:"1px solid #eee", padding:"5px 8px", fontSize:"10px"}}>Sample Product</td>
                    <td style={{border:"1px solid #eee", padding:"5px 8px", textAlign:"center", fontSize:"10px"}}>10 KG</td>
                    <td style={{border:"1px solid #eee", padding:"5px 8px", textAlign:"right", fontSize:"10px"}}>₹100.00</td>
                    <td style={{border:"1px solid #eee", padding:"5px 8px", textAlign:"right", fontSize:"10px"}}>₹1,000.00</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"right", fontWeight:"bold", fontSize:"11px"}}>Total:</td>
                    <td style={{border:"1px solid #ccc", padding:"5px 8px", textAlign:"right", fontWeight:"bold", fontSize:"11px"}}>₹1,000.00</td>
                  </tr>
                </tfoot>
              </table>
              {(form.bankName || form.accountNumber || standAloneQr) && (
                <table style={{width:"100%", borderCollapse:"collapse", border:"1px solid #999", borderTop:"none"}}>
                  <tbody>
                    <tr>
                      {(form.bankName || form.accountNumber) && (
                        <td style={{border:"1px solid #ccc", padding:"8px", verticalAlign:"top", width: standAloneQr ? "70%" : "100%"}}>
                          <div style={{fontSize:"10px", fontWeight:"bold", color:"#333", marginBottom:"4px"}}>BANK DETAILS:</div>
                          {form.bankName && <div style={{fontSize:"10px"}}>{form.bankName}</div>}
                          {form.accountNumber && <div style={{fontSize:"10px"}}>A/C: {form.accountNumber}</div>}
                          {form.ifscCode && <div style={{fontSize:"10px"}}>IFSC: {form.ifscCode}</div>}
                          {form.upiId && <div style={{fontSize:"10px"}}>UPI: {form.upiId}</div>}
                        </td>
                      )}
                      {standAloneQr && (
                        <td style={{border:"1px solid #ccc", padding:"8px", textAlign:"center", verticalAlign:"middle", width:"30%"}}>
                          <div style={{fontSize:"10px", fontWeight:"bold", color:"#333", marginBottom:"4px"}}>SCAN TO PAY</div>
                          <img src={standAloneQr} alt="UPI QR" style={{width:"80px", height:"80px", margin:"0 auto", display:"block"}} />
                          <div style={{fontSize:"9px", color:"#666", marginTop:"2px"}}>{form.upiId}</div>
                        </td>
                      )}
                    </tr>
                  </tbody>
                </table>
              )}
              <div style={{borderTop:"1px solid #ccc", padding:"6px 10px", textAlign:"center", fontSize:"10px", color:"#666", fontStyle:"italic"}}>
                {form.invoiceFooter || "Thank you for your business!"}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3 text-center">↑ Live preview — updates as you type.</p>
        </Section>

        {/* ── Work Calendar ─────────────────────────────────────────────── */}
        <Section title="Work Calendar">
          <div className="space-y-5">
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Weekly Off Days</p>
              <p className="text-xs text-gray-400 mb-3">Selected days are treated as non-working days in attendance reports.</p>
              <div className="flex gap-2 flex-wrap">
                {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => (
                  <button key={i} type="button" onClick={() => toggleWeeklyOff(i)}
                    className={`px-3 py-2 rounded-xl text-sm font-semibold border-2 transition-all ${
                      calendar.weeklyOff.includes(i)
                        ? "bg-orange-500 text-white border-orange-500"
                        : "border-gray-200 text-gray-500 hover:border-orange-300"
                    }`}>
                    {d}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Company Holidays</p>
              <p className="text-xs text-gray-400 mb-3">Add specific dates as holidays. These show as a banner on the attendance page.</p>
              <div className="flex gap-2 mb-3 flex-wrap">
                <input type="date" value={newHolidayDate} onChange={e => setNewHolidayDate(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
                <input type="text" value={newHolidayLabel} onChange={e => setNewHolidayLabel(e.target.value)}
                  placeholder="Holiday name (e.g. Pongal)"
                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 min-w-[180px]" />
                <button type="button" onClick={addHoliday} disabled={!newHolidayDate}
                  className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-orange-600 disabled:opacity-50">
                  + Add
                </button>
              </div>
              {calendar.holidays.length === 0 ? (
                <p className="text-xs text-gray-400 italic">No holidays added yet.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {calendar.holidays.map(h => (
                    <div key={h.date} className="flex items-center justify-between bg-amber-50 border border-amber-100 rounded-xl px-4 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-gray-800">{h.label}</p>
                        <p className="text-xs text-gray-400">
                          {new Date(h.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
                        </p>
                      </div>
                      <button onClick={() => removeHoliday(h.date)}
                        className="text-red-400 hover:text-red-600 text-lg font-bold ml-4">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button type="button" onClick={handleSaveCalendar} disabled={calSaving}
              className="bg-orange-500 text-white px-6 py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-50">
              {calSaving ? "Saving…" : calSaved ? "✅ Saved!" : "💾 Save Work Calendar"}
            </button>
          </div>
        </Section>

      </div>

      {/* Save at bottom */}
      <div className="mt-6 flex justify-end">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-all">
          {saving ? "Saving..." : saved ? "✅ Saved!" : "💾 Save Settings"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}

function Field({ label, children, span }: { label: string; children: React.ReactNode; span?: number }) {
  return (
    <div className={span === 2 ? "sm:col-span-2" : ""}>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

const inp = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white";