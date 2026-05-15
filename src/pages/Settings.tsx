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
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
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
          <div className="bg-gray-50 border border-dashed border-gray-300 rounded-xl p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-lg font-bold text-orange-500">
                  {form.businessName || "Your Business Name"}
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {form.address}
                  {form.city ? `, ${form.city}` : ""}
                  {form.state ? `, ${form.state}` : ""}
                  {form.pincode ? ` - ${form.pincode}` : ""}
                </p>
                {form.phone && (
                  <p className="text-sm text-gray-600">Ph: {form.phone}</p>
                )}
                {form.gstin && (
                  <p className="text-sm text-gray-600">GSTIN: {form.gstin}</p>
                )}
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-gray-700">TAX INVOICE</p>
                <p className="text-sm text-gray-500">
                  {form.invoicePrefix || "INV"}-2025-001
                </p>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-gray-200 text-xs text-gray-400 text-center italic">
              {form.invoiceFooter || "Thank you for your business!"}
            </div>
          </div>
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
      <div className="p-6">{children}</div>
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