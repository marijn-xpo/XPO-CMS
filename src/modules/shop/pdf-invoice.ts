// Minimale, dependency-vrije PDF-generator voor BTW-facturen (één pagina, Helvetica).
// Voor rijkere lay-outs kun je in productie pdfkit/puppeteer toevoegen; deze werkt zonder extra deps.
function pdfEscape(s: string): string { return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }

export type InvoiceData = {
  invoiceNo: string; orderRef: string; date: string;
  seller: { name: string; line2?: string; vatId?: string };
  customer: { name: string; email: string; country?: string };
  currency: string;
  lines: { desc: string; qty: number; unit: string; total: string }[];
  subtotal: string; shipping: string; vat: string; vatRate: number; total: string;
};

export function renderInvoicePdf(d: InvoiceData): Buffer {
  const L: { x: number; y: number; size: number; text: string; bold?: boolean }[] = [];
  let y = 800;
  const line = (text: string, size = 10, x = 50, bold = false) => { L.push({ x, y, size, text, bold }); y -= size + 6; };
  line(d.seller.name, 18, 50, true);
  if (d.seller.line2) line(d.seller.line2, 9);
  if (d.seller.vatId) line("BTW: " + d.seller.vatId, 9);
  y -= 8;
  line("FACTUUR", 16, 50, true);
  line("Factuurnummer: " + d.invoiceNo, 10);
  line("Order: " + d.orderRef + "   Datum: " + d.date, 10);
  y -= 6;
  line("Aan: " + d.customer.name + " (" + d.customer.email + ")", 10);
  if (d.customer.country) line("Land: " + d.customer.country, 9);
  y -= 10;
  line("Omschrijving                              Aantal      Stuk        Totaal", 10, 50, true);
  for (const it of d.lines) {
    const desc = (it.desc || "").slice(0, 38).padEnd(38);
    const qty = String(it.qty).padStart(5);
    line(desc + " " + qty + "   " + it.unit.padStart(9) + "   " + it.total.padStart(10), 10);
  }
  y -= 8;
  line("Subtotaal: " + d.subtotal, 10, 330);
  line("Verzending: " + d.shipping, 10, 330);
  line("BTW (" + d.vatRate + "%): " + d.vat, 10, 330);
  line("TOTAAL: " + d.total, 12, 330, true);

  // bouw content-stream
  let stream = "BT\n";
  for (const t of L) stream += `/F${t.bold ? 2 : 1} ${t.size} Tf\n1 0 0 1 ${t.x} ${t.y} Tm\n(${pdfEscape(t.text)}) Tj\n`;
  stream += "ET";
  const sBuf = Buffer.from(stream, "latin1");

  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>";
  objs[4] = `<< /Length ${sBuf.length} >>\nstream\n${stream}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[6] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i <= 6; i++) { offsets[i] = Buffer.byteLength(pdf, "latin1"); pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
