import { useEffect, useState, useCallback } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "../firebase/config";
import QRCode from "qrcode";

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
}

const EMPTY: BusinessSettings = {
  businessName: "",
  address: "",
  city: "",
  state: "Tamil Nadu",
  pincode: "",
  phone: "",
  alternatePhone: "",
  email: "",
  gstin: "",
  fssaiNumber: "",
  bankName: "",
  accountNumber: "",
  ifscCode: "",
  upiId: "",
  invoicePrefix: "INV",
  invoiceFooter: "Thank you for your business!",
  defaultInvoiceType: "estimate",
  defaultBillingMode: "without_due",
  defaultQrMode: "without_amount",
  defaultPaperSize: "a4",
};

const SETTINGS_DOC = "settings/business";

export async function getBusinessSettings(): Promise<BusinessSettings> {
  const snap = await getDoc(doc(db, "settings", "business"));
  if (snap.exists()) return snap.data() as BusinessSettings;
  return EMPTY;
}

export default function Settings() {
  const [form, setForm] = useState<BusinessSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // ── QR state ────────────────────────────────────────────────
  const [testQr, setTestQr]         = useState<string>("");   // ₹1 test QR
  const [standAloneQr, setStandAloneQr] = useState<string>(""); // no-amount QR


  const generateQRs = useCallback(async (upiId: string) => {
    if (!upiId.trim()) { setTestQr(""); setStandAloneQr(""); return; }
    try {
      const opts = { width: 160, margin: 1, color: { dark: "#000000", light: "#ffffff" } };
      const [testUrl, standUrl] = await Promise.all([
        QRCode.toDataURL(
          `upi://pay?pa=${encodeURIComponent(upiId)}&pn=Test&am=1.00&cu=INR`,
          opts
        ),
        QRCode.toDataURL(
          `upi://pay?pa=${encodeURIComponent(upiId)}&cu=INR`,
          opts
        ),
      ]);
      setTestQr(testUrl);
      setStandAloneQr(standUrl);
    } catch { setTestQr(""); setStandAloneQr(""); }
  }, []);

  useEffect(() => {
    getBusinessSettings().then((data) => {
      setForm(data);
      setLoading(false);
      if (data.upiId) generateQRs(data.upiId);
    });
  }, []);

  const set = (key: keyof BusinessSettings, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    // FIX: validate defaultInvoiceType is set so mobile orders always get a real type
    if (!form.businessName.trim()) {
      alert("Business name is required.");
      return;
    }
    if (!form.defaultInvoiceType) {
      alert("Please select a Default Invoice Type before saving. This is used when printing invoices for mobile orders.");
      return;
    }
    setSaving(true);
    setSaved(false);
    try {
      await setDoc(doc(db, "settings", "business"), form);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error(err);
      alert("Failed to save settings. Try again.");
    } finally {
      setSaving(false);
    }
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
          <p className="text-sm text-gray-400 mt-0.5">
            Business details used across all invoices and bills
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-all"
        >
          {saving ? "Saving..." : saved ? "✅ Saved!" : "Save Settings"}
        </button>
      </div>

      <div className="space-y-5">

        {/* Business Info */}
        <Section title="Business Information">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Business / Shop Name *" span={2}>
              <input
                value={form.businessName}
                onChange={(e) => set("businessName", e.target.value)}
                placeholder="e.g. Sri Murugan Wholesale Traders"
                className={inp}
              />
            </Field>
            <Field label="Address Line *" span={2}>
              <input
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
                placeholder="Door No., Street Name"
                className={inp}
              />
            </Field>
            <Field label="City *">
              <input
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
                placeholder="e.g. Chennai"
                className={inp}
              />
            </Field>
            <Field label="State">
              <input
                value={form.state}
                onChange={(e) => set("state", e.target.value)}
                placeholder="Tamil Nadu"
                className={inp}
              />
            </Field>
            <Field label="Pincode">
              <input
                value={form.pincode}
                onChange={(e) => set("pincode", e.target.value)}
                placeholder="600001"
                maxLength={6}
                className={inp}
              />
            </Field>
            <Field label="Email">
              <input
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="business@example.com"
                className={inp}
              />
            </Field>
            <Field label="Primary Phone *">
              <input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                placeholder="9876543210"
                maxLength={10}
                className={inp}
              />
            </Field>
            <Field label="Alternate Phone">
              <input
                value={form.alternatePhone}
                onChange={(e) => set("alternatePhone", e.target.value)}
                placeholder="9876543211"
                maxLength={10}
                className={inp}
              />
            </Field>
          </div>
        </Section>

        {/* Tax Info */}
        <Section title="Tax & Regulatory">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="GSTIN">
              <input
                value={form.gstin}
                onChange={(e) => set("gstin", e.target.value.toUpperCase())}
                placeholder="22AAAAA0000A1Z5"
                maxLength={15}
                className={inp}
              />
              <p className="text-xs text-gray-400 mt-1">
                Leave blank if not GST registered
              </p>
            </Field>
            <Field label="FSSAI Number">
              <input
                value={form.fssaiNumber}
                onChange={(e) => set("fssaiNumber", e.target.value)}
                placeholder="Food license number (if applicable)"
                className={inp}
              />
            </Field>
          </div>
        </Section>

        {/* Bank / Payment */}
        <Section title="Bank & Payment Details">
          <p className="text-xs text-gray-400 mb-3">
            Shown on GST invoices for bank transfer payments
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Bank Name">
              <input
                value={form.bankName}
                onChange={(e) => set("bankName", e.target.value)}
                placeholder="e.g. State Bank of India"
                className={inp}
              />
            </Field>
            <Field label="Account Number">
              <input
                value={form.accountNumber}
                onChange={(e) => set("accountNumber", e.target.value)}
                placeholder="Account number"
                className={inp}
              />
            </Field>
            <Field label="IFSC Code">
              <input
                value={form.ifscCode}
                onChange={(e) => set("ifscCode", e.target.value.toUpperCase())}
                placeholder="SBIN0001234"
                maxLength={11}
                className={inp}
              />
            </Field>
            <Field label="UPI ID">
              <input
                value={form.upiId}
                onChange={(e) => {
                  set("upiId", e.target.value);
                  generateQRs(e.target.value);
                }}
                placeholder="yourname@upi"
                className={inp}
              />
            </Field>
          </div>
        </Section>

        {/* UPI QR Codes */}
        {form.upiId && (
          <Section title="UPI QR Codes">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

              {/* ₹1 Test QR */}
              <div className="flex flex-col items-center bg-orange-50 border border-orange-100 rounded-xl p-5">
                <p className="text-sm font-semibold text-orange-700 mb-1">₹1 Test QR</p>
                <p className="text-xs text-orange-400 mb-3 text-center">
                  Scan this to verify your UPI ID is working correctly
                </p>
                {testQr ? (
                  <>
                    <img src={testQr} alt="Test QR" className="w-36 h-36 rounded-lg border border-orange-200" />
                    <p className="text-xs text-gray-400 mt-2 font-mono">{form.upiId}</p>
                    <span className="mt-2 text-xs bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full font-medium">
                      Amount: ₹1.00
                    </span>
                  </>
                ) : (
                  <div className="w-36 h-36 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-sm">
                    Generating...
                  </div>
                )}
              </div>

              {/* Standalone Payment QR */}
              <div className="flex flex-col items-center bg-green-50 border border-green-100 rounded-xl p-5">
                <p className="text-sm font-semibold text-green-700 mb-1">Payment QR</p>
                <p className="text-xs text-green-500 mb-3 text-center">
                  Show this to customers — they type the amount in their UPI app
                </p>
                {standAloneQr ? (
                  <>
                    <img src={standAloneQr} alt="Payment QR" className="w-36 h-36 rounded-lg border border-green-200" />
                    <p className="text-xs text-gray-400 mt-2 font-mono">{form.upiId}</p>
                    <a
                      href={standAloneQr}
                      download={`payment-qr-${form.upiId}.png`}
                      className="mt-2 text-xs bg-green-500 text-white px-3 py-1 rounded-full font-medium hover:bg-green-600 transition-all"
                    >
                      ⬇ Download QR
                    </a>
                  </>
                ) : (
                  <div className="w-36 h-36 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400 text-sm">
                    Generating...
                  </div>
                )}
              </div>

            </div>
          </Section>
        )}

        {/* Invoice Defaults */}
        <Section title="Invoice Defaults">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Invoice Number Prefix">
              <input
                value={form.invoicePrefix}
                onChange={(e) => set("invoicePrefix", e.target.value.toUpperCase())}
                placeholder="INV"
                maxLength={6}
                className={inp}
              />
              <p className="text-xs text-gray-400 mt-1">
                Bills will be numbered like {form.invoicePrefix || "INV"}-2025-001
              </p>
            </Field>
            <Field label="Default Invoice Type">
              <select
                value={form.defaultInvoiceType}
                onChange={(e) =>
                  set("defaultInvoiceType", e.target.value)
                }
                className={inp}
              >
                <option value="estimate">Estimate Bill (no GST)</option>
                <option value="gst">Tax Invoice (with GST)</option>
              </select>
            </Field>
            <Field label="Default Due Display">
              <select
                value={form.defaultBillingMode}
                onChange={(e) =>
                  set("defaultBillingMode", e.target.value)
                }
                className={inp}
              >
                <option value="without_due">Current bill only (hide due)</option>
                <option value="with_due">Show outstanding due on bill</option>
              </select>
            </Field>
            <Field label="Default QR Code Amount">
              <select
                value={form.defaultQrMode}
                onChange={(e) => set("defaultQrMode", e.target.value)}
                className={inp}
              >
                <option value="without_amount">No amount — customer enters manually (recommended for B2B)</option>
                <option value="with_amount">Pre-fill balance amount in QR</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">
                {form.defaultQrMode === "with_amount"
                  ? "QR will encode the exact balance due. Customer can still change it in their UPI app."
                  : "QR encodes only your UPI ID. Customer types the amount — safer for partial payments."}
              </p>
            </Field>
            <Field label="Default Paper Size">
              <div className="flex gap-2">
                {(["a4", "a5"] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    onClick={() => set("defaultPaperSize", size)}
                    className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all ${
                      (form.defaultPaperSize || "a4") === size
                        ? "border-orange-500 bg-orange-50 text-orange-700"
                        : "border-gray-200 text-gray-500 hover:border-gray-300"
                    }`}
                  >
                    {size.toUpperCase()}
                    <span className="block text-xs font-normal text-gray-400 mt-0.5">
                      {size === "a4" ? "210 × 297 mm" : "148 × 210 mm"}
                    </span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Used when printing invoices. Can be overridden per print in the invoice preview.
              </p>
            </Field>
            <Field label="Invoice Footer Message" span={2}>
              <input
                value={form.invoiceFooter}
                onChange={(e) => set("invoiceFooter", e.target.value)}
                placeholder="Thank you for your business!"
                maxLength={100}
                className={inp}
              />
            </Field>
          </div>
        </Section>

        {/* Preview */}
        <Section title="Invoice Header Preview">
          <div className="overflow-x-auto -mx-4 md:mx-0">
            <div className="min-w-[320px] bg-white border border-gray-200 rounded-xl overflow-hidden mx-4 md:mx-0" style={{fontFamily: "Arial, sans-serif", fontSize: "12px"}}>
              {/* Invoice header table */}
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
                              <div style={{fontSize:"10px", color:"#555"}}>Area: Anna Nagar</div>
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
              {/* Items table */}
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
              {/* Payment + QR row */}
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
              {/* Footer */}
              <div style={{borderTop:"1px solid #ccc", padding:"6px 10px", textAlign:"center", fontSize:"10px", color:"#666", fontStyle:"italic"}}>
                {form.invoiceFooter || "Thank you for your business!"}
              </div>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-3 text-center">↑ Live preview — updates as you type. Actual invoices are generated as PDF.</p>
        </Section>

      </div>

      {/* Save at bottom too */}
      <div className="mt-6 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-all"
        >
          {saving ? "Saving..." : saved ? "✅ Saved!" : "💾 Save Settings"}
        </button>
      </div>


    </div>
  );
}

function Section({
  title, children,
}: {
  title: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}

function Field({
  label, children, span,
}: {
  label: string; children: React.ReactNode; span?: number;
}) {
  return (
    <div className={span === 2 ? "sm:col-span-2" : ""}>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

const inp =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white";