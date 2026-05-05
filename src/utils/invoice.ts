import jsPDF from "jspdf";
import { Order } from "../types";

export function generateInvoicePDF(order: Order) {
  const pdf = new jsPDF();

  // Header
  pdf.setFontSize(20);
  pdf.setTextColor(234, 88, 12); // orange
  pdf.text("WHOLESALE DEALER", 105, 20, { align: "center" });

  pdf.setFontSize(11);
  pdf.setTextColor(100);
  pdf.text("INVOICE", 105, 28, { align: "center" });

  // Divider
  pdf.setDrawColor(234, 88, 12);
  pdf.setLineWidth(0.5);
  pdf.line(15, 33, 195, 33);

  // Order Info
  pdf.setFontSize(10);
  pdf.setTextColor(50);
  pdf.text(`Invoice Date: ${new Date(order.createdAt).toLocaleDateString("en-IN")}`, 15, 42);
  pdf.text(`Order ID: ${order.id?.slice(0, 8).toUpperCase()}`, 15, 50);

  // Customer Info
  pdf.setFontSize(11);
  pdf.setTextColor(30);
  pdf.text("Bill To:", 15, 62);
  pdf.setFontSize(10);
  pdf.setTextColor(60);
  pdf.text(order.customerName, 15, 70);
  pdf.text(order.customerAddress || "", 15, 77);

  // Agent Info
  pdf.text(`Field Agent: ${order.agentName}`, 130, 62);
  if (order.vehicleNumber) {
    pdf.text(`Vehicle No: ${order.vehicleNumber}`, 130, 70);
  }

  // Table Header
  pdf.setFillColor(249, 115, 22);
  pdf.rect(15, 88, 180, 8, "F");
  pdf.setTextColor(255);
  pdf.setFontSize(10);
  pdf.text("Product", 18, 94);
  pdf.text("Qty", 100, 94);
  pdf.text("Unit", 120, 94);
  pdf.text("Price", 145, 94);
  pdf.text("Total", 170, 94);

  // Table Rows
  let y = 106;
  pdf.setTextColor(40);
  order.items.forEach((item, i) => {
    if (i % 2 === 0) {
      pdf.setFillColor(249, 250, 251);
      pdf.rect(15, y - 5, 180, 8, "F");
    }
    pdf.text(item.productName, 18, y);
    pdf.text(String(item.quantity), 100, y);
    pdf.text(item.unit, 120, y);
    pdf.text(`Rs.${item.price}`, 145, y);
    pdf.text(`Rs.${item.total.toFixed(2)}`, 170, y);
    y += 10;
  });

  // Total
  pdf.setDrawColor(200);
  pdf.line(15, y + 2, 195, y + 2);
  pdf.setFontSize(12);
  pdf.setTextColor(234, 88, 12);
  pdf.text(`Total Amount: Rs.${order.totalAmount.toFixed(2)}`, 195, y + 12, { align: "right" });

  // Footer
  pdf.setFontSize(9);
  pdf.setTextColor(150);
  pdf.text("Thank you for your business!", 105, 280, { align: "center" });

  pdf.save(`invoice-${order.id?.slice(0, 8)}.pdf`);
}
