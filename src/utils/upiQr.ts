import QRCode from "qrcode";

// Standard UPI deep link (GPay / PhonePe / Paytm all understand it).
export function buildUpiUri(opts: { vpa: string; payeeName: string; amount?: number; note?: string }): string {
  const params = new URLSearchParams({ pa: opts.vpa, pn: opts.payeeName, cu: "INR" });
  if (opts.amount && opts.amount > 0) params.set("am", opts.amount.toFixed(2));
  if (opts.note) params.set("tn", opts.note);
  return `upi://pay?${params.toString()}`;
}

export async function generateUpiQrDataUrl(opts: { vpa: string; payeeName: string; amount?: number; note?: string }): Promise<string> {
  return QRCode.toDataURL(buildUpiUri(opts), { margin: 4, errorCorrectionLevel: "Q", width: 320 });
}
