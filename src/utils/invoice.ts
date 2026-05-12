import jsPDF from "jspdf";
import { doc, getDoc, runTransaction } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, Customer, InvoiceType, BillingMode } from "../types";
import { BusinessSettings } from "../pages/Settings";

export interface InvoiceOptions {
  invoiceType: InvoiceType;
  billingMode: BillingMode;
  customerDue?: number;
}

async function fetchBusinessSettings(): Promise<BusinessSettings | null> {
  try {
    const snap = await getDoc(doc(db, "settings", "business"));
    return snap.exists() ? (snap.data() as BusinessSettings) : null;
  } catch {
    return null;
  }
}

async function getNextInvoiceNumber(prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const counterRef = doc(db, "settings", "invoiceCounter");
  let serial = 1;
  try {
    await runTransaction(db, async (t) => {
      const snap = await t.get(counterRef);
      const current = snap.exists() ? (snap.data().lastSerial ?? 0) : 0;
      serial = current + 1;
      t.set(counterRef, { lastSerial: serial }, { merge: true });
    });
  } catch {
    serial = Date.now();
  }
  return `${prefix}-${year}-${String(serial).padStart(3, "0")}`;
}

export async function buildInvoicePDF(
  order: Order,
  customer?: Partial<Customer>,
  options?: Partial<InvoiceOptions>
) {
  const biz = await fetchBusinessSettings();
  const invoiceType: InvoiceType =
    options?.invoiceType ?? biz?.defaultInvoiceType ?? "estimate";
  const billingMode: BillingMode =
    options?.billingMode ?? biz?.defaultBillingMode ?? "without_due";
  const due = options?.customerDue ?? (customer as any)?.outstandingDue ?? 0;
  const isGST = invoiceType === "gst";
  const showDue = billingMode === "with_due";
  const prefix = biz?.invoicePrefix || "INV";

  const invoiceNumber =
    order.invoiceNumber || (await getNextInvoiceNumber(prefix));

  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 14;

  // ── Header band ─────────────────────────────────────────────
  pdf.setFillColor(234, 88, 12);
  pdf.rect(0, 0, W, 30, "F");

  pdf.setFontSize(17);
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold");
  pdf.text(biz?.businessName || "WHOLESALE DEALER", M, 11);

  pdf.setFontSize(8);
  pdf.setFont("helvetica", "normal");
  const addressLine = [biz?.address, biz?.city, biz?.state, biz?.pincode]
    .filter(Boolean)
    .join(", ");
  if (addressLine) pdf.text(addressLine, M, 17);
  const contactLine = [
    biz?.phone ? `Ph: ${biz.phone}` : null,
    biz?.email || null,
  ]
    .filter(Boolean)
    .join("  |  ");
  if (contactLine) pdf.text(contactLine, M, 22);
  if (isGST) {
    if (biz?.gstin) {
      pdf.setFont("helvetica", "bold");
      pdf.text(`GSTIN: ${biz.gstin}`, M, 27);
      pdf.setFont("helvetica", "normal");
    } else {
      pdf.setTextColor(200, 80, 80);
      pdf.setFont("helvetica", "italic");
      pdf.text("GSTIN: Not set — add in Settings", M, 27);
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(255, 255, 255);
    }
  }

  pdf.setFontSize(11);
  pdf.setFont("helvetica", "bold");
  pdf.text(isGST ? "TAX INVOICE" : "ESTIMATE", W - M, 11, { align: "right" });
  pdf.setFontSize(8);
  pdf.setFont("helvetica", "normal");
  pdf.text(invoiceNumber, W - M, 17, { align: "right" });
  pdf.text(
    new Date(order.createdAt).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    }),
    W - M,
    22,
    { align: "right" }
  );

  // ── Bill to box ──────────────────────────────────────────────
  let y = 38;
  pdf.setFillColor(249, 249, 249);
  pdf.roundedRect(M, y, 90, isGST ? 36 : 30, 2, 2, "F");
  pdf.setFontSize(8);
  pdf.setTextColor(150);
  pdf.setFont("helvetica", "bold");
  pdf.text("BILL TO", M + 3, y + 6);
  pdf.setFontSize(10);
  pdf.setTextColor(20);
  pdf.setFont("helvetica", "bold");
  pdf.text(order.customerName, M + 3, y + 13);
  pdf.setFontSize(8);
  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(70);
  const addrLines = pdf.splitTextToSize(order.customerAddress || "", 82);
  pdf.text(addrLines.slice(0, 2), M + 3, y + 19);
  if (order.customerPhone) pdf.text(`Ph: ${order.customerPhone}`, M + 3, y + 27);
  if (isGST && customer?.gstin)
    pdf.text(`GSTIN: ${customer.gstin}`, M + 3, y + 31);

  // order meta right side
  pdf.setFontSize(8.5);
  pdf.setTextColor(60);
  pdf.setFont("helvetica", "normal");
  const metaX = 120;
  pdf.text(`Agent: ${order.agentName}`, metaX, y + 6);
  if (order.vehicleNumber)
    pdf.text(`Vehicle: ${order.vehicleNumber}`, metaX, y + 12);

  // ── Items table ───────────────────────────────────────────────
  y = 76;
  const col = {
    no:    M,
    name:  M + 8,
    qty:   isGST ? 110 : 128,
    unit:  isGST ? 124 : 142,
    rate:  isGST ? 138 : 158,
    cgst:  isGST ? 152 : 0,
    sgst:  isGST ? 164 : 0,
    total: W - M,
  };

  pdf.setFillColor(234, 88, 12);
  pdf.rect(M, y, W - M * 2, 8, "F");
  pdf.setFontSize(8);
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "bold");
  pdf.text("#",       col.no + 1,  y + 5.5);
  pdf.text("Product", col.name,    y + 5.5);
  pdf.text("Qty",     col.qty,     y + 5.5, { align: "right" });
  pdf.text("Unit",    col.unit,    y + 5.5);
  pdf.text("Rate",    col.rate,    y + 5.5, { align: "right" });
  if (isGST) {
    pdf.text("CGST", col.cgst, y + 5.5, { align: "right" });
    pdf.text("SGST", col.sgst, y + 5.5, { align: "right" });
  }
  pdf.text("Amount", col.total, y + 5.5, { align: "right" });

  y += 10;
  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(30);

  let subtotal = 0, totalCGST = 0, totalSGST = 0;

  order.items.forEach((item, i) => {
    if (i % 2 === 0) {
      pdf.setFillColor(250, 250, 250);
      pdf.rect(M, y - 3, W - M * 2, 8, "F");
    }
    const gstRate = parseFloat((item as any).gst ?? "0") || 0;
    const cgstRate = gstRate / 2;
    const base = isGST && gstRate > 0 ? item.price / (1 + gstRate / 100) : item.price;
    const lineBase = base * item.quantity;
    const lineCGST = isGST ? (lineBase * cgstRate) / 100 : 0;
    const lineSGST = lineCGST;
    subtotal   += lineBase;
    totalCGST  += lineCGST;
    totalSGST  += lineSGST;

    pdf.setFontSize(8);
    pdf.text(String(i + 1),   col.no + 1, y + 2);
    pdf.text(
      pdf.splitTextToSize(item.productName, 65)[0],
      col.name, y + 2
    );
    pdf.text(String(item.quantity), col.qty,   y + 2, { align: "right" });
    pdf.text(item.unit,             col.unit,  y + 2);
    pdf.text(item.price.toFixed(2), col.rate,  y + 2, { align: "right" });
    if (isGST) {
      pdf.text(lineCGST > 0 ? lineCGST.toFixed(2) : "-", col.cgst, y + 2, { align: "right" });
      pdf.text(lineSGST > 0 ? lineSGST.toFixed(2) : "-", col.sgst, y + 2, { align: "right" });
    }
    pdf.text(item.total.toFixed(2), col.total, y + 2, { align: "right" });
    y += 8;
  });

  // ── Totals ────────────────────────────────────────────────────
  pdf.setDrawColor(220);
  pdf.line(M, y + 2, W - M, y + 2);
  y += 7;

  const tX = 130, vX = W - M;

  const addRow = (label: string, value: string, bold = false, rgb?: [number, number, number]) => {
    pdf.setFontSize(9);
    pdf.setFont("helvetica", bold ? "bold" : "normal");
    pdf.setTextColor(...(rgb ?? [60, 60, 60]));
    pdf.text(label, tX, y);
    pdf.text(value, vX, y, { align: "right" });
    y += 6;
  };

  if (isGST) {
    addRow("Taxable Amount:", `Rs.${subtotal.toFixed(2)}`);
    addRow("CGST:",           `Rs.${totalCGST.toFixed(2)}`);
    addRow("SGST:",           `Rs.${totalSGST.toFixed(2)}`);
    pdf.setDrawColor(200);
    pdf.line(tX, y, vX, y);
    y += 4;
  }
  addRow("Current Bill Total:", `Rs.${order.totalAmount.toFixed(2)}`, true, [20, 20, 20]);

  if (showDue && due > 0) {
    y += 2;
    addRow("Previous Due:", `Rs.${due.toFixed(2)}`, false, [180, 50, 20]);
    pdf.setDrawColor(200);
    pdf.line(tX, y, vX, y);
    y += 4;
    addRow("Grand Total Payable:", `Rs.${(order.totalAmount + due).toFixed(2)}`, true, [180, 50, 20]);
  }

  if (order.amountCollected !== undefined) {
    y += 2;
    addRow("Amount Collected:", `Rs.${order.amountCollected.toFixed(2)}`, false, [20, 130, 60]);
    const bal = order.totalAmount - order.amountCollected + (showDue ? due : 0);
    if (bal > 0) {
      addRow("Balance Due:", `Rs.${bal.toFixed(2)}`, true, [180, 50, 20]);
    }
  }

  // ── Bank details (GST invoices) ───────────────────────────────
  if (isGST && (biz?.bankName || biz?.upiId)) {
    y += 6;
    pdf.setFontSize(8);
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(80);
    pdf.text("Payment Details:", M, y);
    y += 5;
    pdf.setFont("helvetica", "normal");
    if (biz?.bankName)      pdf.text(`Bank: ${biz.bankName}  |  A/C: ${biz.accountNumber}  |  IFSC: ${biz.ifscCode}`, M, y), (y += 5);
    if (biz?.upiId)         pdf.text(`UPI: ${biz.upiId}`, M, y), (y += 5);
  }

  // ── Signature lines ───────────────────────────────────────────
  if (y < 248) {
    y = Math.max(y + 8, 248);
    pdf.setDrawColor(180);
    pdf.line(M, y, M + 60, y);
    pdf.line(W - M - 60, y, W - M, y);
    pdf.setFontSize(8);
    pdf.setTextColor(130);
    pdf.text("Customer Signature", M, y + 5);
    pdf.text("Authorized Signatory", W - M - 60, y + 5);
  }

  // ── Footer ─────────────────────────────────────────────────────
  pdf.setFontSize(8);
  pdf.setTextColor(160);
  pdf.setFont("helvetica", "italic");
  if (!isGST) pdf.text("* This is an estimate only — not a tax invoice.", M, 285);
  else        pdf.text("* Subject to jurisdiction of local courts.", M, 285);
  pdf.text(biz?.invoiceFooter || "Thank you for your business!", W / 2, 290, { align: "center" });

  return pdf;
}

export async function generateInvoicePDF(
  order: Order,
  customer?: Partial<Customer>,
  options?: Partial<InvoiceOptions>
) {
  const isGST = (options?.invoiceType ?? "estimate") === "gst";
  const prefix = isGST ? "invoice" : "estimate";
  const pdf = await buildInvoicePDF(order, customer, options);
  pdf.save(`${prefix}-${(order.id ?? "order").slice(0, 8)}.pdf`);
}

export const generateGSTInvoice = (
  order: Order, customer?: Partial<Customer>, opts?: Partial<InvoiceOptions>
) => generateInvoicePDF(order, customer, { ...opts, invoiceType: "gst" });

export const generateEstimateInvoice = (
  order: Order, customer?: Partial<Customer>, opts?: Partial<InvoiceOptions>
) => generateInvoicePDF(order, customer, { ...opts, invoiceType: "estimate" });