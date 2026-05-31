import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import QRCode from "qrcode";
import { doc, getDoc, runTransaction, collection, getDocs } from "firebase/firestore";
import { db } from "../firebase/config";
import { Order, Customer, InvoiceType, BillingMode, OrderItem, Product } from "../types";
import { BusinessSettings } from "../pages/Settings";
import { NOTO_TAMIL_REGULAR_B64, NOTO_TAMIL_BOLD_B64 } from "./invoiceFonts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceOptions {
  invoiceType: InvoiceType;
  billingMode: BillingMode;
  customerDue?: number;
  qrMode?: "with_amount" | "without_amount";
}

// ─── Firestore helpers ────────────────────────────────────────────────────────

async function enrichItemsFromProducts(items: OrderItem[]): Promise<OrderItem[]> {
  try {
    const snap = await getDocs(collection(db, "products"));
    const productMap = new Map<string, Product>();
    snap.docs.forEach((d) => productMap.set(d.id, { id: d.id, ...d.data() } as Product));
    return items.map((item) => {
      const product = productMap.get(item.productId);
      if (!product) return item;
      return {
        ...item,
        hsn:          item.hsn          || product.hsn          || "",
        gst:          item.gst          || (product.gst !== "none" ? product.gst : "0"),
        taxInclusive: item.taxInclusive ?? product.taxInclusive ?? false,
      };
    });
  } catch {
    return items;
  }
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
  const year = new Date().getFullYear().toString().slice(-2);
  const counterRef = doc(db, "settings", "invoiceCounter");
  let serial = 1;
  try {
    await runTransaction(db, async (t) => {
      const snap = await t.get(counterRef);
      const current = snap.exists() ? (snap.data().lastSerial ?? 0) : 0;
      serial = current + 1;
      t.set(counterRef, { lastSerial: serial }, { merge: true });
    });
  } catch (err: any) {
    // Firestore permission error = packing staff cannot write invoiceCounter.
    // Surface the error clearly so it can be fixed (add invoiceCounter rule or
    // move to a Cloud Function) rather than silently colliding on serial 1.
    const isPermission = err?.code === "permission-denied" || (err?.message ?? "").includes("Missing or insufficient permissions");
    if (isPermission) {
      console.error(
        "INVOICE COUNTER: packing_staff lacks write permission on settings/invoiceCounter. " +
        "Add a Firestore rule or move getNextInvoiceNumber to a callable Cloud Function."
      );
      // Fall back to a timestamp-based unique suffix to avoid collision
      serial = Date.now();
    } else {
      serial = 1;
    }
  }
  return `${prefix}/${year}/${String(serial).padStart(5, "0")}`;
}

// ─── Exported: mint the next invoice number atomically ───────────────────────
// Call this ONCE per invoice. Pass the result into buildInvoicePDF via
// order.invoiceNumber. buildInvoicePDF will skip the counter if the order
// already has an invoiceNumber set.
export async function mintInvoiceNumber(prefix: string): Promise<string> {
  return getNextInvoiceNumber(prefix);
}

// ─── XSS safety: escape all user-controlled strings before HTML injection ────
// All Firestore-sourced text (names, addresses, notes, product names) must be
// escaped before being written into innerHTML.
function esc(text: unknown): string {
  if (text == null) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + "…";
}

function numberToWords(amount: number): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
    "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen",
    "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty",
    "Sixty", "Seventy", "Eighty", "Ninety"];
  const n = Math.round(amount);
  if (n === 0) return "Zero Rupees";
  const inWords = (num: number): string => {
    if (num < 20)       return ones[num];
    if (num < 100)      return tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "");
    if (num < 1000)     return ones[Math.floor(num / 100)] + " Hundred" + (num % 100 ? " " + inWords(num % 100) : "");
    if (num < 100000)   return inWords(Math.floor(num / 1000)) + " Thousand" + (num % 1000 ? " " + inWords(num % 1000) : "");
    if (num < 10000000) return inWords(Math.floor(num / 100000)) + " Lakh" + (num % 100000 ? " " + inWords(num % 100000) : "");
    return inWords(Math.floor(num / 10000000)) + " Crore" + (num % 10000000 ? " " + inWords(num % 10000000) : "");
  };
  return "Rupees " + inWords(n);
}

function computeLineAmounts(item: OrderItem, isGST: boolean) {
  const gstPct      = parseFloat(item.gst ?? "0") || 0;
  const cgstRate    = gstPct / 2;
  const isInclusive = item.taxInclusive === true;

  if (isGST && gstPct > 0) {
    const rawTotal     = isInclusive ? round3(item.price * item.quantity) : 0;
    const taxableValue = isInclusive
      ? round3(rawTotal / (1 + gstPct / 100))
      : round3(item.price * item.quantity);
    const lineCGST = round3(taxableValue * cgstRate / 100);
    const lineSGST = lineCGST;
    const lineTotal = round2(taxableValue + lineCGST + lineSGST);
    return { taxableValue, lineCGST, lineSGST, lineTotal, gstPct };
  }

  const taxableValue = round3(item.price * item.quantity);
  return { taxableValue, lineCGST: 0, lineSGST: 0, lineTotal: taxableValue, gstPct: 0 };
}

// ─── UPI QR generator ─────────────────────────────────────────────────────────

async function generateUpiQrDataUrl(
  upiId: string,
  businessName: string,
  amount: number,
  withAmount: boolean,
): Promise<string> {
  try {
    let upiString = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(businessName)}&cu=INR`;
    if (withAmount && amount > 0) {
      upiString += `&am=${amount.toFixed(2)}`;
    }
    return await QRCode.toDataURL(upiString, {
      width: 140,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });
  } catch {
    return "";
  }
}


// ─── Shared page styles (used by both page 1 and continuation pages) ──────────

function buildPageStyles(scale: number, fs: (n: number) => string, bodyWidth: number, wrapperWidth: number): string {
  return `
  @font-face {
    font-family: 'NotoTamil';
    src: url('data:font/truetype;base64,${NOTO_TAMIL_REGULAR_B64}') format('truetype');
    font-weight: normal;
    font-display: block;
  }
  @font-face {
    font-family: 'NotoTamil';
    src: url('data:font/truetype;base64,${NOTO_TAMIL_BOLD_B64}') format('truetype');
    font-weight: bold;
    font-display: block;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{
    font-family:'NotoTamil',Arial,sans-serif;
    background:#fff; color:#000;
    width:${bodyWidth}px;
    padding:8px 10px;
  }
  .invoice-wrapper{ width:${wrapperWidth}px; margin:4px auto 0 auto; }
  table{ width:100%; border-collapse:collapse; table-layout:fixed; }
  td,th{ vertical-align:middle !important; }
  .title{ font-size:${fs(15)}; font-weight:700; text-align:center; padding:${Math.round(12*scale)}px 0; height:${Math.round(50*scale)}px }
  .header-row td{ height:${Math.round(95*scale)}px; }
  .center{ text-align:center; }
  .right{ text-align:right; }
  .bold{ font-weight:700; }
  .small{ font-size:${fs(10)}; }
  .big{ font-size:${fs(18)}; font-weight:700; }
  .item-head{ background:#f2f2f2; font-weight:700; text-align:center; }
  .item-row td{
    border-left:1px solid #000; border-right:1px solid #000;
    border-top:none; border-bottom:none;
    padding:${Math.round(8*scale)}px ${Math.round(6*scale)}px;
    font-size:${fs(11)}; vertical-align:middle;
  }
  .item-last td{ border-bottom:1px solid #000 !important; }
  .summary td{ padding:${Math.round(5*scale)}px ${Math.round(8*scale)}px; font-size:${fs(11)}; }
  .signature td{
    height:${Math.round(80*scale)}px; vertical-align:bottom !important;
    padding-bottom:${Math.round(10*scale)}px;
    font-size:${fs(11)}; font-weight:700; text-align:center;
  }
  .cont-header{
    font-size:${fs(10)}; text-align:right; padding:4px 6px;
    border:1px solid #000; font-weight:600; color:#333;
    margin-bottom:2px;
  }
  `;
}

// ─── Continuation page builder ────────────────────────────────────────────────

function buildContinuationHTML(params: {
  pageNum: number;
  totalPages: number;
  invoiceNumber: string;
  isGST: boolean;
  itemRows: string;        // pre-built <tr> strings for this page's items
  isLastPage: boolean;
  summaryBlock: string;    // totals+summary+signature+footer HTML (only on last page)
  colspan: number;
  c: string;               // cell style
  scale: number;
  fs: (n: number) => string;
  bodyWidth: number;
  wrapperWidth: number;
}): string {
  const { pageNum, totalPages, invoiceNumber, isGST, itemRows, isLastPage, summaryBlock, colspan, c, scale, fs, bodyWidth, wrapperWidth } = params;
  const B  = "border:1px solid #000;";
  const P  = "padding:6px 7px;";
  const F  = `font-size:${fs(11)};`;
  const V  = "vertical-align:middle;";
  const cb = `${B}${P}${F}${V}`;

  const colgroup = isGST ? `
  <colgroup>
    <col style="width:4%">
    <col style="width:12%">
    <col style="width:12%">
    <col style="width:8%">
    <col style="width:6%">
    <col style="width:6%">
    <col style="width:12%">
    <col style="width:7%">
    <col style="width:8%">
    <col style="width:7%">
    <col style="width:8%">
    <col style="width:12%">
  </colgroup>` : `
  <colgroup>
    <col style="width:6%">
    <col style="width:15%">
    <col style="width:40%">
    <col style="width:12%">
    <col style="width:12%">
    <col style="width:15%">
  </colgroup>`;

  const colHeaders = isGST ? `
  <tr class="item-head">
    <td style="${cb}">SL</td>
    <td colspan="2" style="${cb}">DESCRIPTION</td>
    <td style="${cb}">HSN</td>
    <td style="${cb}">QTY</td>
    <td style="${cb}">UOM</td>
    <td style="${cb}">TAXABLE VALUE</td>
    <td style="${cb}">CGST%</td>
    <td style="${cb}">CGST</td>
    <td style="${cb}">SGST%</td>
    <td style="${cb}">SGST</td>
    <td style="${cb}">TOTAL Rs.</td>
  </tr>` : `
  <tr class="item-head">
    <td style="${cb}">SL</td>
    <td style="${cb}">UNIT PRICE</td>
    <td style="${cb}">DESCRIPTION</td>
    <td style="${cb}">QTY</td>
    <td style="${cb}">UOM</td>
    <td style="${cb}">TOTAL Rs.</td>
  </tr>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>${buildPageStyles(scale, fs, bodyWidth, wrapperWidth)}</style>
</head>
<body>
<div class="invoice-wrapper">

  <!-- CONTINUATION HEADER -->
  <div class="cont-header">
    TAX INVOICE &nbsp;|&nbsp; Invoice No: ${invoiceNumber} &nbsp;|&nbsp; Page ${pageNum} of ${totalPages}
  </div>

  <table>
  ${colgroup}

  ${colHeaders}

  ${itemRows}

  ${isLastPage ? summaryBlock : `
  <tr class="item-row item-last">
    <td colspan="${colspan}" style="text-align:center;font-style:italic;font-size:${fs(9)};color:#666;">...continued on next page</td>
  </tr>`}

  </table>
</div>
</body>
</html>`;
}

// ─── HTML invoice builder ─────────────────────────────────────────────────────

function buildInvoiceHTML(params: {
  order: Order;
  customer?: Partial<Customer>;
  biz: BusinessSettings | null;
  invoiceNumber: string;
  isGST: boolean;
  showDue: boolean;
  historicalDue: number;
  advancePaid: number;
  qrDataUrl?: string;
  paperSize?: "a4" | "a5";
  suppressSummary?: boolean;  // true on page 1 when there are continuation pages
}): string {
  const { order, customer, biz, invoiceNumber, isGST, showDue, historicalDue, advancePaid, qrDataUrl, paperSize = "a4", suppressSummary = false } = params;

  // Paper dimensions at 96dpi: A4=794px wide, A5=559px wide
  // Content area = body width minus padding (18px each side)
  const bodyWidth    = paperSize === "a5" ? 559 : 794;
  const wrapperWidth = bodyWidth - 54;  // 27px margin each side
  // Scale factor for font sizes (A5 = 559/794 ≈ 0.704)
  const scale        = paperSize === "a5" ? 0.82 : 1;
  const fs = (px: number) => `${Math.round(px * scale)}px`;

  const lineAmounts   = order.items.map((item) => computeLineAmounts(item, isGST));
  const totalTaxable  = round3(lineAmounts.reduce((s, a) => s + a.taxableValue, 0));
  const totalCGST     = round3(lineAmounts.reduce((s, a) => s + a.lineCGST,    0));
  const totalSGST     = round3(lineAmounts.reduce((s, a) => s + a.lineSGST,    0));
  const computedTotal = round2(lineAmounts.reduce((s, a) => s + a.lineTotal,   0));
  const totalPayable  = computedTotal + (showDue ? historicalDue : 0);
  const balanceOnDelivery = Math.max(0, round2(totalPayable - advancePaid));

  const addrParts = [biz?.address, biz?.city, biz?.state, biz?.pincode].filter(Boolean).join(", ");
  const invoiceDateRaw = order.invoicedAt ?? order.createdAt;
  const invoiceDateObj = new Date(invoiceDateRaw);
  const dateStr = invoiceDateObj.toLocaleDateString("en-IN", {
    day: "2-digit", month: "2-digit", year: "numeric",
  }) + " " + invoiceDateObj.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  // Words line shows the actual amount still owed — mirrors QR amount logic
  const amountForWords = balanceOnDelivery > 0 ? balanceOnDelivery : totalPayable;

  // GST: 11 cols (1+2+1+1+1+1+1+1+1+1), Bill: 8 cols (1+3+1+1+1+1)
  const colspan = isGST ? 12 : 6;

  // ── shared cell base style (inline so html2canvas picks it up) ──
  const B  = "border:1px solid #000;";
  const BV = "border-left:1px solid #000;border-right:1px solid #000;";
  const P  = "padding:6px 7px;";
  const F  = `font-size:${fs(11)};`;
  const V  = "vertical-align:middle;";

  const c  = `${B}${P}${F}${V}`;
  const cv = `${BV}${P}${F}${V}`;

  // ── GST item rows ──
  const gstItemRows = order.items.map((item, i) => {
    const { taxableValue, lineCGST, lineSGST, lineTotal, gstPct } = lineAmounts[i];
    const cgstRate = gstPct / 2;
    return `<tr>
      <td style="${cv}text-align:center">${i + 1}</td>
      <td style="${cv}">${esc(item.productName)}</td>
      <td style="${cv}text-align:center">${esc(item.hsn) || ""}</td>
      <td style="${cv}text-align:center">${item.quantity}</td>
      <td style="${cv}text-align:center">${esc(item.unit)}</td>
      <td style="${cv}text-align:right">${taxableValue.toFixed(3)}</td>
      <td style="${cv}text-align:center">${gstPct > 0 ? `${cgstRate}%` : "0.0%"}</td>
      <td style="${cv}text-align:right">${gstPct > 0 ? lineCGST.toFixed(3) : "0.000"}</td>
      <td style="${cv}text-align:center">${gstPct > 0 ? `${cgstRate}%` : "0.0%"}</td>
      <td style="${cv}text-align:right">${gstPct > 0 ? lineSGST.toFixed(3) : "0.000"}</td>
      <td style="${cv}text-align:right;font-weight:600">${lineTotal.toFixed(2)}</td>
    </tr>`;
  }).join("");

  // ── Bill-of-supply item rows ──
  const billItemRows = order.items.map((item, i) => {
    const { lineTotal } = lineAmounts[i];
    return `<tr>
      <td style="${cv}text-align:center">${i + 1}</td>
      <td style="${cv}">${esc(item.productName)}</td>
      <td style="${cv}text-align:center">${item.quantity}</td>
      <td style="${cv}text-align:center">${esc(item.unit)}</td>
      <td style="${cv}text-align:right">${item.price.toFixed(2)}</td>
      <td style="${cv}text-align:right;font-weight:600">${lineTotal.toFixed(2)}</td>
    </tr>`;
  }).join("");

  // ── GST totals row ──
  const gstTotalsRow = isGST ? `
    <tr style="font-weight:700;background:#f5f5f5">
      <td style="${c}"></td>
      <td style="${c}">TOTALS</td>
      <td style="${c}"></td><td style="${c}"></td><td style="${c}"></td>
      <td style="${c}text-align:right">${totalTaxable.toFixed(3)}</td>
      <td style="${c}"></td>
      <td style="${c}text-align:right">${totalCGST.toFixed(3)}</td>
      <td style="${c}"></td>
      <td style="${c}text-align:right">${totalSGST.toFixed(3)}</td>
      <td style="${c}text-align:right">${computedTotal.toFixed(2)}</td>
    </tr>` : "";

  // Summary rows: last physical column is always colspan=1 (the value column)
  const VALUE_COL_SPAN = 1;
  const LABEL_COL_SPAN = colspan - VALUE_COL_SPAN;
  const sigLeft  = Math.floor(colspan / 2);
  const sigRight = colspan - sigLeft;

  // ── summary row helper ──
  const summaryRow = (label: string, value: string, bold = false) => {
    const s = bold ? "font-weight:700;" : "";
    return `<tr>
      <td colspan="${LABEL_COL_SPAN}" style="${c}text-align:right;${s}">${label}</td>
      <td colspan="${VALUE_COL_SPAN}" style="${c}text-align:right;${s}">${value}</td>
    </tr>`;
  };

  const dueRows = showDue && historicalDue > 0 ? `
    ${summaryRow("Previous Due", historicalDue.toFixed(2))}
    ${summaryRow("Total Payable", (computedTotal + historicalDue).toFixed(2), true)}
  ` : "";

  const advanceRow = advancePaid > 0
    ? summaryRow("Advance Paid", `- ${advancePaid.toFixed(2)}`)
    : "";

  // The final amount the customer still owes — this is what the QR encodes too
  const finalPayable = balanceOnDelivery;

  const balanceRow = advancePaid > 0
    ? summaryRow("Balance to Pay", finalPayable > 0 ? finalPayable.toFixed(2) : "NIL", true)
    : "";

  const bankDetails = isGST && (biz?.bankName || biz?.upiId) ? `
    <tr>
      <td colspan="${colspan}" style="${c}font-size:10px">
        <strong>Payment Details:</strong>&nbsp;
        ${[
          biz?.bankName      ? `Bank: ${esc(biz.bankName)}` : "",
          biz?.accountNumber ? `A/C: ${esc(biz.accountNumber)}` : "",
          biz?.ifscCode      ? `IFSC: ${esc(biz.ifscCode)}` : "",
          biz?.upiId         ? `UPI: ${esc(biz.upiId)}` : "",
        ].filter(Boolean).join("  |  ")}
      </td>
    </tr>` : "";

  // One single table for the entire invoice — no gaps between sections
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>

<style>
  @font-face {
    font-family: 'NotoTamil';
    src: url('data:font/truetype;base64,${NOTO_TAMIL_REGULAR_B64}') format('truetype');
    font-weight: normal;
    font-display: block;
  }

  @font-face {
    font-family: 'NotoTamil';
    src: url('data:font/truetype;base64,${NOTO_TAMIL_BOLD_B64}') format('truetype');
    font-weight: bold;
    font-display: block;
  }

  *{
    box-sizing:border-box;
    margin:0;
    padding:0;
  }

  body{
    font-family:'NotoTamil',Arial,sans-serif;
    background:#fff;
    color:#000;
    width:${bodyWidth}px;
    padding:8px 10px;
  }

  .invoice-wrapper{
    width:${wrapperWidth}px;
    margin:4px auto 0 auto;
  }

  table{
    width:100%;
    border-collapse:collapse;
    table-layout:fixed;
  }

  td,th{
    vertical-align:middle !important;
  }

  .title{
    font-size:${fs(15)};
    font-weight:700;
    text-align:center;
    padding:${Math.round(12*scale)}px 0;
    height: ${Math.round(50*scale)}px
  }

  .header-row td{
    height:${Math.round(95*scale)}px;
  }

  .center{
    text-align:center;
  }

  .right{
    text-align:right;
  }

  .bold{
    font-weight:700;
  }

  .small{
    font-size:${fs(10)};
  }

  .big{
    font-size:${fs(18)};
    font-weight:700;
  }

  .item-head{
    background:#f2f2f2;
    font-weight:700;
    text-align:center;
  }

  .item-row td{
    border-left:1px solid #000;
    border-right:1px solid #000;
    border-top:none;
    border-bottom:none;
    padding:${Math.round(8*scale)}px ${Math.round(6*scale)}px;
    font-size:${fs(11)};
    vertical-align:middle;
  }

  .item-last td{
    border-bottom:1px solid #000 !important;
  }

  .summary td{
    padding:${Math.round(5*scale)}px ${Math.round(8*scale)}px;
    font-size:${fs(11)};
  }

  .signature td{
    height:${Math.round(80*scale)}px;
    vertical-align:bottom !important;
    padding-bottom:${Math.round(10*scale)}px;
    font-size:${fs(11)};
    font-weight:700;
    text-align:center;
  }

</style>
</head>

<body>

<div class="invoice-wrapper">

<table>
  ${isGST ? `
  <colgroup>
    <col style="width:4%">
    <col style="width:12%">
    <col style="width:12%">
    <col style="width:8%">
    <col style="width:6%">
    <col style="width:6%">
    <col style="width:12%">
    <col style="width:7%">
    <col style="width:8%">
    <col style="width:7%">
    <col style="width:8%">
    <col style="width:12%">
  </colgroup>
  ` : `
  <colgroup>
    <col style="width:6%">   <!-- SL -->
    <col style="width:15%">  <!-- UNIT PRICE -->
    <col style="width:40%">  <!-- DESCRIPTION -->
    <col style="width:12%">  <!-- QTY -->
    <col style="width:12%">  <!-- UOM -->
    <col style="width:15%">  <!-- TOTAL -->
  </colgroup>
  `}

  <!-- TITLE -->

  <tr>
    <td colspan="${colspan}" style="${c}" class="title">
      ${isGST ? "TAX INVOICE" : "ESTIMATE"}
    </td>
  </tr>

  <!-- HEADER -->

  <tr class="header-row">

    ${
    isGST
      ? `
      <td colspan="3" style="${c};text-align:left;padding-left:14px;">
        ${biz?.gstin ? `<div style="font-size:${fs(12)};font-weight:700;">GST No.: ${esc(biz.gstin)}</div>` : ""}
        ${biz?.phone ? `<div class="small" style="margin-top:8px;"><b>MOBILE:</b> ${esc(biz.phone)}</div>` : ""}
        ${biz?.email ? `<div class="small" style="margin-top:8px;"><b>EMAIL:</b> ${esc(biz.email)}</div>` : ""}
      </td>

      <td colspan="6" style="${c}" class="center">
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;">
          <img src="/ptm_logo.jpeg" style="width:${Math.round(48*scale)}px;height:${Math.round(48*scale)}px;object-fit:contain;" />
          <div class="big">${esc(biz?.businessName) || "PTM MILL"}</div>
        </div>

        <div style="margin-top:8px;font-size:${fs(10)};">
          ${esc(addrParts)}
        </div>
      </td>

      <td colspan="3" style="${c};text-align:left;padding-left:14px;">
        <div class="small"><b>S NO:</b> ${esc(invoiceNumber)}</div>

        <div class="small" style="margin-top:8px;">
          <b>DATE:</b> ${dateStr}
        </div>

        <div class="small" style="margin-top:8px;">
          <b>VEHICLE NO:</b> ${esc(order.vehicleNumber) || ""}
        </div>
      </td>
    `
      : `
      <td colspan="2" style="${c};text-align:left;padding-left:14px;">
        ${biz?.phone ? `<div class="small" style="margin-top:8px;"><b>MOBILE:</b> ${esc(biz.phone)}</div>` : ""}
        ${biz?.email ? `<div class="small" style="margin-top:8px;"><b>EMAIL:</b> ${esc(biz.email)}</div>` : ""}
      </td>

      <td colspan="2" style="${c}" class="center">
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;">
          <img src="/ptm_logo.jpeg" style="width:${Math.round(48*scale)}px;height:${Math.round(48*scale)}px;object-fit:contain;" />
          <div class="big">${esc(biz?.businessName) || "PTM MILL"}</div>
        </div>

        <div style="margin-top:8px;font-size:${fs(10)};">
          ${esc(addrParts)}
        </div>
      </td>

      <td colspan="2" style="${c};text-align:left;padding-left:14px;">
        <div class="small"><b>S NO:</b> ${esc(invoiceNumber)}</div>

        <div class="small" style="margin-top:8px;">
          <b>DATE:</b> ${dateStr}
        </div>

        <div class="small" style="margin-top:8px;">
          <b>VEHICLE NO:</b> ${esc(order.vehicleNumber) || ""}
        </div>
      </td> 
      `
    }


  </tr>

  <!-- CONSIGNEE -->

  <tr>
${
isGST
? `
    <td colspan="3" style="${c};text-align:left;padding:10px 12px;">

      <div class="small bold">CONSIGNOR</div>

      <div style="margin-top:18px;font-size:${fs(14)};font-weight:700;">
        ${esc(biz?.businessName) || ""}
      </div>

      <div style="margin-top:6px;">
        ${esc(biz?.city) || ""}
      </div>

    </td>

    <td colspan="6" style="${c};text-align:left;padding:10px 12px;">

      <div class="small bold">CONSIGNEE</div>

      <div style="margin-top:12px;font-size:${fs(16)};font-weight:700;">
        ${esc(order.customerName)}
      </div>

      <div style="margin-top:5px;">
        ${esc(order.customerAddress) || ""}
      </div>

      ${
        order.customerArea
          ? `<div style="margin-top:4px;font-size:${fs(11)};color:#444;">${esc(order.customerArea)}</div>`
          : ""
      }

      ${
        customer?.gstin
          ? `<div style="margin-top:6px;font-size:${fs(12)};font-weight:700;">GST No.: ${esc(customer.gstin)}</div>`
          : ""
      }

    </td>

    <!-- QR -->

    <td colspan="3" style="${c};padding:0;">

      <div style="
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
      ">

        ${qrDataUrl ? `
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px;">
          <img src="${qrDataUrl}" style="width:${Math.round(70*scale)}px;height:${Math.round(70*scale)}px;display:block;" />
          <div style="font-size:${fs(7)};color:#555;text-align:center;">Scan to Pay</div>
        </div>
        ` : `
        <div style="
          width:${Math.round(70*scale)}px;
          height:${Math.round(70*scale)}px;
          background:#f2f2f2;
          display:flex;
          align-items:center;
          justify-content:center;
          color:#888;
          font-size:${fs(11)};
        ">
          QR
        </div>
        `}

      </div>

    </td>

    `
: `
<td colspan="2" style="${c};text-align:left;padding:10px 12px;">

      <div class="small bold">CONSIGNOR</div>

      <div style="margin-top:18px;font-size:${fs(14)};font-weight:700;">
        ${biz?.businessName || ""}
      </div>

      <div style="margin-top:6px;">
        ${biz?.city || ""}
      </div>

    </td>

    <td colspan="2" style="${c};text-align:left;padding:10px 12px;">

      <div class="small bold">CONSIGNEE</div>

      <div style="margin-top:12px;font-size:${fs(16)};font-weight:700;">
        ${esc(order.customerName)}
      </div>

      <div style="margin-top:5px;">
        ${esc(order.customerAddress) || ""}
      </div>

      ${
        order.customerArea
          ? `<div style="margin-top:4px;font-size:${fs(11)};color:#444;">${esc(order.customerArea)}</div>`
          : ""
      }

      ${
        order.customerPhone
          ? `<div style="margin-top:5px;">Ph: ${esc(order.customerPhone)}</div>`
          : ""
      }

    </td>

    <!-- QR -->

    <td colspan="2" style="${c};padding:0;">

      <div style="
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
      ">

        ${qrDataUrl ? `
        <div style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px;">
          <img src="${qrDataUrl}" style="width:${Math.round(70*scale)}px;height:${Math.round(70*scale)}px;display:block;" />
          <div style="font-size:${fs(7)};color:#555;text-align:center;">Scan to Pay</div>
        </div>
        ` : `
        <div style="
          width:${Math.round(70*scale)}px;
          height:${Math.round(70*scale)}px;
          background:#f2f2f2;
          display:flex;
          align-items:center;
          justify-content:center;
          color:#888;
          font-size:${fs(11)};
        ">
          QR
        </div>
        `}

      </div>

    </td>
    `
}

  </tr>

  <!-- TABLE HEADER -->

  ${isGST ? `
  <tr class="item-head">
    <td style="${c}">SL</td>
    <td colspan="2" style="${c}">DESCRIPTION</td>
    <td style="${c}">HSN</td>
    <td style="${c}">QTY</td>
    <td style="${c}">UOM</td>
    <td style="${c}">TAXABLE VALUE</td>
    <td style="${c}">CGST%</td>
    <td style="${c}">CGST</td>
    <td style="${c}">SGST%</td>
    <td style="${c}">SGST</td>
    <td style="${c}">TOTAL Rs.</td>
  </tr>
  ` : `
  <tr class="item-head">
    <td style="${c}">SL</td>
    <td style="${c}">UNIT PRICE</td>
    <td style="${c}">DESCRIPTION</td>
    <td style="${c}">QTY</td>
    <td style="${c}">UOM</td>
    <td style="${c}">TOTAL Rs.</td>
  </tr>
  `}

  <!-- ITEMS -->

  ${isGST ? order.items.map((item, i) => {

    const {
      taxableValue,
      lineCGST,
      lineSGST,
      lineTotal,
      gstPct
    } = lineAmounts[i];

    const cgstRate = gstPct / 2;

    return `
    <tr class="item-row">

      <td>${i + 1}</td>

      <td colspan="2" style="text-align:left;padding-left:10px;">
        <div>${item.productName}</div>
        <div style="font-size:${fs(9)};color:#555;margin-top:2px;">₹${item.price.toFixed(2)} / ${item.unit}</div>
      </td>

      <td>${item.hsn || ""}</td>

      <td>${item.quantity}</td>

      <td>${item.unit}</td>

      <td class="right">
        ${taxableValue.toFixed(3)}
      </td>

      <td>
        ${gstPct > 0 ? `${cgstRate}%` : "0.0%"}
      </td>

      <td class="right">
        ${gstPct > 0 ? lineCGST.toFixed(3) : "0.000"}
      </td>

      <td>
        ${gstPct > 0 ? `${cgstRate}%` : "0.0%"}
      </td>

      <td class="right">
        ${gstPct > 0 ? lineSGST.toFixed(3) : "0.000"}
      </td>

      <td class="right bold">
        ${lineTotal.toFixed(2)}
      </td>

    </tr>
    `;
  }).join("") : order.items.map((item, i) => {

    const { lineTotal } = lineAmounts[i];

    return `
    <tr class="item-row">

      <td>${i + 1}</td>

      <td class="right">
        ${item.price.toFixed(2)}
      </td>

      <td style="text-align:left;padding-left:10px;">
        ${item.productName}
      </td>

      <td>${item.quantity}</td>

      <td>${item.unit}</td>

      <td class="right bold">
        ${lineTotal.toFixed(2)}
      </td>

    </tr>
    `;
  }).join("")}

  <!-- EMPTY ROWS -->

  ${isGST ? `
  <tr class="item-row">
    <td>&nbsp;</td>
    <td colspan="2"></td>
    <td></td><td></td><td></td>
    <td></td><td></td><td></td>
    <td></td><td></td><td></td>
  </tr>

  <tr class="item-row item-last">
    <td>&nbsp;</td>
    <td colspan="2"></td>
    <td></td><td></td><td></td>
    <td></td><td></td><td></td>
    <td></td><td></td><td></td>
  </tr>
  ` : `
  <tr class="item-row">
    <td>&nbsp;</td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>

  <tr class="item-row item-last">
    <td>&nbsp;</td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
  </tr>
  `}

  <!-- TOTALS + SUMMARY (suppressed on page 1 when continuation pages follow) -->

  ${!suppressSummary ? `

  ${isGST ? `
  <tr>
    <td style="${c}"></td>
    <td colspan="2" style="${c};font-weight:700;">TOTALS</td>
    <td style="${c}"></td><td style="${c}"></td><td style="${c}"></td>
    <td style="${c};text-align:right;font-weight:700;">${totalTaxable.toFixed(3)}</td>
    <td style="${c}"></td>
    <td style="${c};text-align:right;font-weight:700;">${totalCGST.toFixed(3)}</td>
    <td style="${c}"></td>
    <td style="${c};text-align:right;font-weight:700;">${totalSGST.toFixed(3)}</td>
    <td style="${c};text-align:right;font-weight:700;font-size:${fs(14)};">${computedTotal.toFixed(2)}</td>
  </tr>` : `
  <tr>
    <td style="${c}"></td>
    <td colspan="4" style="${c};font-weight:700;">TOTALS</td>
    <td style="${c};text-align:right;font-weight:700;font-size:${fs(14)};">${computedTotal.toFixed(2)}</td>
  </tr>`}

  ${dueRows}
  ${advanceRow}
  ${balanceRow}

  <tr>
    <td colspan="${colspan - 1}" style="${c};text-align:right;font-weight:700;">CASH COLLECTION</td>
    <td style="${c}"></td>
  </tr>

  <tr>
    <td colspan="${colspan}" style="${c};text-align:center;">
      ${numberToWords(amountForWords)} Only
    </td>
  </tr>

  <tr class="signature">
    <td colspan="${Math.floor(colspan / 2)}" style="${c}">Proprietor Signature</td>
    <td colspan="${colspan - Math.floor(colspan / 2)}" style="${c}">Receiver Signature</td>
  </tr>

  <tr>
    <td colspan="${colspan}" style="${c};text-align:center;">
      <div>${(biz as any)?.invoiceFooterLine1 || "This Is Computer Based Invoice"}</div>
      <div style="margin-top:4px;">${biz?.invoiceFooter || "Thank you! Visit Again"}</div>
    </td>
  </tr>

  ` : `
  <tr class="item-row item-last">
    <td colspan="${colspan}" style="text-align:center;font-style:italic;font-size:${fs(9)};color:#666;border:1px solid #000;">
      ...continued on next page
    </td>
  </tr>
  `}

</table>

</div>

</body>
</html>`;
}

// ─── Core: HTML → canvas → PDF ───────────────────────────────────────────────

export async function buildInvoicePDF(
  order: Order,
  customer?: Partial<Customer>,
  options?: Partial<InvoiceOptions>,
  paperSize: "a4" | "a5" = "a4",
) {
  const [enrichedItems, biz] = await Promise.all([
    enrichItemsFromProducts(order.items),
    fetchBusinessSettings(),
  ]);
  const enrichedOrder = { ...order, items: enrichedItems };

  const invoiceType: InvoiceType = options?.invoiceType ?? biz?.defaultInvoiceType ?? "estimate";
  const billingMode: BillingMode = options?.billingMode ?? biz?.defaultBillingMode ?? "without_due";
  const qrMode = options?.qrMode ?? biz?.defaultQrMode ?? "without_amount";
  const isGST   = invoiceType === "gst";
  const showDue = billingMode === "with_due";
  const prefix  = biz?.invoicePrefix || "INV";

  const historicalDue: number = (() => {
    if (options?.customerDue !== undefined) return options.customerDue;
    const currentDue   = (customer as any)?.outstandingDue ?? 0;
    const orderBalance = (order as any).balanceDue ?? 0;
    return Math.max(0, round2(currentDue - orderBalance));
  })();

  // advancePaid: prefer the explicit field; fall back to amountCollected only
  // for already-delivered orders. For pending orders both may be 0 — that's correct,
  // the QR then encodes the full balance due.
  const advancePaid: number = (() => {
    if ((order as any).advancePaid !== undefined) return (order as any).advancePaid as number;
    if (order.status === "delivered" && order.amountCollected !== undefined) return order.amountCollected;
    return 0;
  })();

  // Invoice number — use what's already saved; never mint a new one here.
  // Minting is done exclusively in InvoiceModal.handleGenerate().
  const invoiceNumber = order.invoiceNumber || "";
  if (!invoiceNumber) {
    // Defensive: shouldn't reach here with the new modal flow, but keeps
    // backward compatibility for any direct calls during testing.
    console.warn("[invoice] buildInvoicePDF called without invoiceNumber — counter NOT incremented, PDF will show blank number.");
  }

  // ── Compute amounts for QR ────────────────────────────────────
  const computedTotal = round2(enrichedOrder.items.reduce((s, item) => {
    const { lineTotal } = computeLineAmounts(item, isGST);
    return s + lineTotal;
  }, 0));
  const totalPayable      = computedTotal + (showDue ? historicalDue : 0);
  const balanceOnDelivery = Math.max(0, round2(totalPayable - advancePaid));
  // QR encodes what the customer still owes. If nothing is owed (fully pre-paid), skip QR.
  const qrAmount = balanceOnDelivery;

  // ── Generate UPI QR if UPI ID is configured ──────────────────
  // withAmount=true  → QR pre-fills the balance due (customer can still change it)
  // withAmount=false → QR encodes only UPI ID, customer types amount (safer for B2B)
  const upiId = (biz?.upiId || "").trim();
  const withAmount = qrMode === "with_amount";
  const qrDataUrl = upiId && (withAmount ? qrAmount > 0 : true)
    ? await generateUpiQrDataUrl(upiId, (biz?.businessName || "Payment").trim(), qrAmount, withAmount)
    : "";

  // ── Shared layout constants (mirrored from buildInvoiceHTML) ───────────────
  const paperW      = paperSize === "a5" ? 559 : 794;
  const paperH      = paperSize === "a5" ? 794 : 1123;
  const bodyWidth   = paperW;
  const wrapperWidth = bodyWidth - 54;
  const scale       = paperSize === "a5" ? 0.82 : 1;
  const fs          = (px: number) => `${Math.round(px * scale)}px`;
  const colspan     = isGST ? 12 : 6;
  const B  = "border:1px solid #000;";
  const BV = "border-left:1px solid #000;border-right:1px solid #000;";
  const P  = "padding:6px 7px;";
  const F  = `font-size:${fs(11)};`;
  const V  = "vertical-align:middle;";
  const c  = `${B}${P}${F}${V}`;
  const cv = `${BV}${P}${F}${V}`;

  // ── Build page-1 HTML ────────────────────────────────────────────────────────
  const html = buildInvoiceHTML({
    order: enrichedOrder, customer, biz, invoiceNumber,
    isGST, showDue, historicalDue, advancePaid, qrDataUrl,
    paperSize,
  });

  // ── Helper: render one HTML page to a canvas, returns dataURL ───────────────
  async function renderPageToDataUrl(pageHtml: string): Promise<{ dataUrl: string; canvasW: number; canvasH: number }> {
    const iframe = document.createElement("iframe");
    iframe.style.cssText = [
      "position:fixed", "left:-9999px", "top:-9999px",
      `width:${paperW}px`, `height:${paperH}px`,
      "border:none", "opacity:0", "pointer-events:none", "z-index:-9999",
    ].join(";");
    document.body.appendChild(iframe);
    try {
      const iframeDoc = iframe.contentDocument!;
      iframeDoc.open(); iframeDoc.write(pageHtml); iframeDoc.close();
      await new Promise<void>((resolve) => {
        if (iframe.contentDocument?.readyState === "complete") resolve();
        else iframe.onload = () => resolve();
      });
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      await (iframe.contentDocument as any).fonts?.ready;
      const images = Array.from(iframe.contentDocument!.querySelectorAll("img"));
      await Promise.all(images.map((img) =>
        img.complete
          ? (img as any).decode?.().catch(() => {}) ?? Promise.resolve()
          : new Promise<void>((resolve) => { img.onload = () => resolve(); img.onerror = () => resolve(); })
      ));
      const body = iframe.contentDocument!.body;
      const actualH = Math.max(body.scrollHeight, body.offsetHeight, iframe.contentDocument!.documentElement.scrollHeight);
      iframe.style.height = `${actualH}px`;
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const canvas = await html2canvas(body, {
        scale: 2, useCORS: true, allowTaint: true, backgroundColor: "#ffffff",
        logging: false, imageTimeout: 15000,
        width: paperW, height: actualH, windowWidth: paperW, windowHeight: actualH,
      } as any);
      if (canvas.width === 0 || canvas.height === 0) throw new Error("Empty canvas");
      return { dataUrl: canvas.toDataURL("image/jpeg", 0.95), canvasW: canvas.width, canvasH: canvas.height };
    } finally {
      if (iframe.parentNode) document.body.removeChild(iframe);
    }
  }

  // ── Measure: how many items fit on page 1 and on continuation pages ──────────
  // We render page 1 with 0 items to measure the "fixed overhead" height (header,
  // consignee, col-header, totals, signature, footer). Then measure one item row.
  // From those two numbers we compute items-per-page for page 1 and for cont pages.

  const totalItems = enrichedOrder.items.length;

  // Render page 1 with NO items (just structure) to measure overhead
  const probeOrder0 = { ...enrichedOrder, items: [] as any[] };
  const probeHtml0 = buildInvoiceHTML({
    order: probeOrder0 as any, customer, biz, invoiceNumber,
    isGST, showDue, historicalDue, advancePaid, qrDataUrl,
    paperSize,
  });

  // Render page 1 with ONE item to measure one item row height
  const probeOrder1 = { ...enrichedOrder, items: enrichedOrder.items.slice(0, 1) };
  const probeHtml1 = buildInvoiceHTML({
    order: probeOrder1 as any, customer, biz, invoiceNumber,
    isGST, showDue, historicalDue, advancePaid, qrDataUrl,
    paperSize,
  });

  // Render both probes in parallel
  const [probe0, probe1] = await Promise.all([
    renderPageToDataUrl(probeHtml0),
    renderPageToDataUrl(probeHtml1),
  ]);

  // Heights in canvas pixels (scale:2 so divide by 2 for CSS pixels)
  const overheadH   = probe0.canvasH / 2;    // page 1 with 0 items
  const oneItemH    = (probe1.canvasH - probe0.canvasH) / 2;  // delta = one row height
  const page1BodyH  = paperH;                // available CSS px on page 1

  // Continuation page overhead: just cont-header (≈24px) + col-headers (≈28px)
  const contOverhead = Math.round(52 * scale);
  const contBodyH    = paperH;

  // Items that fit on page 1 (leave 8px breathing room)
  const itemsOnPage1 = oneItemH > 0
    ? Math.max(1, Math.floor((page1BodyH - overheadH - 8) / oneItemH))
    : totalItems;

  // Items per continuation page
  const itemsPerContPage = oneItemH > 0
    ? Math.max(1, Math.floor((contBodyH - contOverhead - 8) / oneItemH))
    : totalItems;

  // If everything fits on page 1 — classic single-page render
  if (totalItems <= itemsOnPage1) {
    const { dataUrl, canvasW, canvasH } = await renderPageToDataUrl(html);
    const pdf  = new jsPDF({ unit: "mm", format: paperSize === "a5" ? "a5" : "a4", orientation: "portrait" });
    const pdfW = pdf.internal.pageSize.getWidth();
    const pdfH = pdf.internal.pageSize.getHeight();
    const dataUrlFinal = dataUrl;
    const ratio = pdfW / canvasW;
    const imgH  = canvasH * ratio;
    let heightLeft = imgH;
    let position   = 0;
    pdf.addImage(dataUrlFinal, "JPEG", 0, position, pdfW, imgH);
    heightLeft -= pdfH;
    while (heightLeft > 0.5) {
      position -= pdfH; pdf.addPage();
      pdf.addImage(dataUrlFinal, "JPEG", 0, position, pdfW, imgH);
      heightLeft -= pdfH;
    }
    return { pdf, html };
  }

  // ── Multi-page: split items into batches ─────────────────────────────────────
  const batches: typeof enrichedOrder.items[] = [];
  batches.push(enrichedOrder.items.slice(0, itemsOnPage1));
  let offset = itemsOnPage1;
  while (offset < totalItems) {
    batches.push(enrichedOrder.items.slice(offset, offset + itemsPerContPage));
    offset += itemsPerContPage;
  }
  const totalPages = batches.length;

  // ── Pre-build the summary/totals/signature/footer block for the last page ────
  // We reuse the same summary row helpers from buildInvoiceHTML by duplicating the logic here
  const lineAmounts    = enrichedOrder.items.map((item) => computeLineAmounts(item, isGST));
  const totalTaxable   = round3(lineAmounts.reduce((s, a) => s + a.taxableValue, 0));
  const totalCGST      = round3(lineAmounts.reduce((s, a) => s + a.lineCGST,    0));
  const totalSGST      = round3(lineAmounts.reduce((s, a) => s + a.lineSGST,    0));
  const totalComputed  = round2(lineAmounts.reduce((s, a) => s + a.lineTotal,   0));
  const totalPayable2  = totalComputed + (showDue ? historicalDue : 0);
  const balance2       = Math.max(0, round2(totalPayable2 - advancePaid));
  const amountForWords2 = balance2 > 0 ? balance2 : totalPayable2;

  const VALUE_COL_SPAN = 1;
  const LABEL_COL_SPAN = colspan - VALUE_COL_SPAN;
  const summaryRowHtml = (label: string, value: string, bold = false) => {
    const s = bold ? "font-weight:700;" : "";
    return `<tr>
      <td colspan="${LABEL_COL_SPAN}" style="${c}text-align:right;${s}">${label}</td>
      <td colspan="${VALUE_COL_SPAN}" style="${c}text-align:right;${s}">${value}</td>
    </tr>`;
  };
  const dueRows2 = showDue && historicalDue > 0 ? `
    ${summaryRowHtml("Previous Due", historicalDue.toFixed(2))}
    ${summaryRowHtml("Total Payable", (totalComputed + historicalDue).toFixed(2), true)}
  ` : "";
  const advanceRow2 = advancePaid > 0 ? summaryRowHtml("Advance Paid", `- ${advancePaid.toFixed(2)}`) : "";
  const balanceRow2 = advancePaid > 0 ? summaryRowHtml("Balance to Pay", balance2 > 0 ? balance2.toFixed(2) : "NIL", true) : "";

  const bankDetails2 = isGST && (biz?.bankName || biz?.upiId) ? `
    <tr>
      <td colspan="${colspan}" style="${c}font-size:${fs(10)}">
        <strong>Payment Details:</strong>&nbsp;
        ${[
          biz?.bankName      ? `Bank: ${biz.bankName}` : "",
          biz?.accountNumber ? `A/C: ${biz.accountNumber}` : "",
          biz?.ifscCode      ? `IFSC: ${biz.ifscCode}` : "",
          biz?.upiId         ? `UPI: ${biz.upiId}` : "",
        ].filter(Boolean).join("  |  ")}
      </td>
    </tr>` : "";

  const sigLeft  = Math.floor(colspan / 2);
  const sigRight = colspan - sigLeft;

  const lastPageTotalsRow = isGST ? `
  <tr>
    <td style="${c}"></td>
    <td colspan="2" style="${c};font-weight:700;">TOTALS</td>
    <td style="${c}"></td><td style="${c}"></td><td style="${c}"></td>
    <td style="${c};text-align:right;font-weight:700;">${totalTaxable.toFixed(3)}</td>
    <td style="${c}"></td>
    <td style="${c};text-align:right;font-weight:700;">${totalCGST.toFixed(3)}</td>
    <td style="${c}"></td>
    <td style="${c};text-align:right;font-weight:700;">${totalSGST.toFixed(3)}</td>
    <td style="${c};text-align:right;font-weight:700;font-size:${fs(14)};">${totalComputed.toFixed(2)}</td>
  </tr>` : `
  <tr>
    <td style="${c}"></td>
    <td colspan="4" style="${c};font-weight:700;">TOTALS</td>
    <td style="${c};text-align:right;font-weight:700;font-size:${fs(14)};">${totalComputed.toFixed(2)}</td>
  </tr>`;

  const summaryBlock = `
  ${lastPageTotalsRow}
  ${dueRows2}
  ${advanceRow2}
  ${balanceRow2}
  ${bankDetails2}
  <tr>
    <td colspan="${colspan - 1}" style="${c};text-align:right;font-weight:700;">CASH COLLECTION</td>
    <td style="${c}"></td>
  </tr>
  <tr>
    <td colspan="${colspan}" style="${c};text-align:center;">
      ${numberToWords(amountForWords2)} Only
    </td>
  </tr>
  <tr class="signature">
    <td colspan="${sigLeft}" style="${c}">Proprietor Signature</td>
    <td colspan="${sigRight}" style="${c}">Receiver Signature</td>
  </tr>
  <tr>
    <td colspan="${colspan}" style="${c};text-align:center;">
      <div>${(biz as any)?.invoiceFooterLine1 || "This Is Computer Based Invoice"}</div>
      <div style="margin-top:4px;">${biz?.invoiceFooter || "Thank you! Visit Again"}</div>
    </td>
  </tr>`;

  // ── Build and render each page ───────────────────────────────────────────────
  const pdf = new jsPDF({ unit: "mm", format: paperSize === "a5" ? "a5" : "a4", orientation: "portrait" });
  const pdfW = pdf.internal.pageSize.getWidth();
  const pdfH = pdf.internal.pageSize.getHeight();
  let firstPage = true;

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const isLastPage = pageIdx === totalPages - 1;
    const pageItems  = batches[pageIdx];

    let pageHtml: string;

    if (pageIdx === 0) {
      // Page 1: full invoice but with only the first batch of items
      const p1Order = { ...enrichedOrder, items: pageItems };
      pageHtml = buildInvoiceHTML({
        order: p1Order as any, customer, biz, invoiceNumber,
        isGST, showDue: isLastPage ? showDue : false,
        historicalDue: isLastPage ? historicalDue : 0,
        advancePaid:   isLastPage ? advancePaid : 0,
        qrDataUrl:     isLastPage ? qrDataUrl : "",
        paperSize,
        // Override: suppress totals/summary on page 1 if not last page
        suppressSummary: !isLastPage,
      } as any);
    } else {
      // Build item rows for this continuation page
      const itemRowsHtml = pageItems.map((item, localIdx) => {
        const globalIdx = batches.slice(0, pageIdx).reduce((s, b) => s + b.length, 0) + localIdx;
        const la = lineAmounts[globalIdx];
        const { taxableValue, lineCGST, lineSGST, lineTotal, gstPct } = la;
        const cgstRate = gstPct / 2;
        const isLastItem = localIdx === pageItems.length - 1 && !isLastPage;

        if (isGST) {
          return `<tr class="item-row${isLastItem ? " item-last" : ""}">
            <td>${globalIdx + 1}</td>
            <td colspan="2" style="text-align:left;padding-left:10px;">
              <div>${item.productName}</div>
              <div style="font-size:${fs(9)};color:#555;margin-top:2px;">₹${item.price.toFixed(2)} / ${item.unit}</div>
            </td>
            <td>${item.hsn || ""}</td>
            <td>${item.quantity}</td>
            <td>${item.unit}</td>
            <td class="right">${taxableValue.toFixed(3)}</td>
            <td>${gstPct > 0 ? `${cgstRate}%` : "0.0%"}</td>
            <td class="right">${gstPct > 0 ? lineCGST.toFixed(3) : "0.000"}</td>
            <td>${gstPct > 0 ? `${cgstRate}%` : "0.0%"}</td>
            <td class="right">${gstPct > 0 ? lineSGST.toFixed(3) : "0.000"}</td>
            <td class="right bold">${lineTotal.toFixed(2)}</td>
          </tr>`;
        } else {
          return `<tr class="item-row${isLastItem ? " item-last" : ""}">
            <td>${globalIdx + 1}</td>
            <td class="right">${item.price.toFixed(2)}</td>
            <td style="text-align:left;padding-left:10px;">${item.productName}</td>
            <td>${item.quantity}</td>
            <td>${item.unit}</td>
            <td class="right bold">${lineTotal.toFixed(2)}</td>
          </tr>`;
        }
      }).join("");

      pageHtml = buildContinuationHTML({
        pageNum: pageIdx + 1,
        totalPages,
        invoiceNumber,
        isGST,
        itemRows: itemRowsHtml,
        isLastPage,
        summaryBlock: isLastPage ? summaryBlock : "",
        colspan,
        c,
        scale,
        fs,
        bodyWidth,
        wrapperWidth,
      });
    }

    const { dataUrl, canvasW, canvasH } = await renderPageToDataUrl(pageHtml);
    const ratio = pdfW / canvasW;
    const imgH  = canvasH * ratio;

    if (!firstPage) pdf.addPage();
    firstPage = false;

    // Add image — if it somehow overflows one PDF page, slice it
    let heightLeft = imgH;
    let position   = 0;
    pdf.addImage(dataUrl, "JPEG", 0, position, pdfW, imgH);
    heightLeft -= pdfH;
    while (heightLeft > 0.5) {
      position -= pdfH; pdf.addPage();
      pdf.addImage(dataUrl, "JPEG", 0, position, pdfW, imgH);
      heightLeft -= pdfH;
    }
  }

  return { pdf, html };
}

// ─── Public exports (same API as before — no callers need to change) ──────────

export async function generateInvoicePDF(
  order: Order,
  customer?: Partial<Customer>,
  options?: Partial<InvoiceOptions>,
  paperSize: "a4" | "a5" = "a4",
) {
  const isGST  = (options?.invoiceType ?? "estimate") === "gst";
  const prefix = isGST ? "invoice" : "estimate";
  const { pdf } = await buildInvoicePDF(order, customer, options, paperSize);
  pdf.save(`${prefix}-${(order.id ?? "order").slice(0, 8)}.pdf`);
}

export const generateGSTInvoice = (
  order: Order, customer?: Partial<Customer>, opts?: Partial<InvoiceOptions>
) => generateInvoicePDF(order, customer, { ...opts, invoiceType: "gst" });

export const generateEstimateInvoice = (
  order: Order, customer?: Partial<Customer>, opts?: Partial<InvoiceOptions>
) => generateInvoicePDF(order, customer, { ...opts, invoiceType: "estimate" });