import type { PaymentRequest, PlatformPublicConfig } from '../types/subscription'
import { formatDate, formatDateTime, formatRupees } from '../lib/subscription'

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

// Simple printable receipt for an approved subscription payment. Opens
// in a new window and triggers the browser's print dialog — "Save as
// PDF" there gives the shop a PDF copy.
export function printSubscriptionReceipt(req: PaymentRequest, config: PlatformPublicConfig): void {
  const issuer = config.receiptIssuerName || config.payeeName || 'Subscription'
  const details = (config.receiptIssuerDetails ?? '').trim()
  const rows: [string, string][] = [
    ['Receipt no.', req.receiptNo ?? '—'],
    ['Date', formatDateTime(req.decidedAt ?? req.submittedAt)],
    ['Business', req.tenantName],
    ['Plan', `${req.planName} (${req.months} month${req.months === 1 ? '' : 's'})`],
    ['Period', `${formatDate(req.periodStart)} – ${formatDate(req.periodEnd)}`],
    ['Paid via', 'UPI'],
    ['UTR / reference', req.utr ?? '—'],
  ]
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${esc(req.receiptNo ?? '')}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:0;padding:32px}
  .box{max-width:520px;margin:0 auto;border:1px solid #cbd5e1;border-radius:12px;padding:28px}
  h1{font-size:18px;margin:0 0 4px} .muted{color:#64748b;font-size:12px;white-space:pre-line}
  h2{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#334155;margin:24px 0 12px}
  table{width:100%;border-collapse:collapse;font-size:13px} td{padding:7px 0;border-bottom:1px solid #e2e8f0;vertical-align:top}
  td:first-child{color:#64748b;width:42%}
  .total{display:flex;justify-content:space-between;margin-top:18px;font-size:16px;font-weight:700}
  .foot{margin-top:24px;font-size:11px;color:#94a3b8;text-align:center}
  @media print{body{padding:0}.box{border:none}}
</style></head><body><div class="box">
  <h1>${esc(issuer)}</h1>${details ? `<div class="muted">${esc(details)}</div>` : ''}
  <h2>Payment receipt</h2>
  <table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
  <div class="total"><span>Amount received</span><span>${esc(formatRupees(req.amount))}</span></div>
  <div class="foot">Computer-generated subscription receipt.</div>
</div><script>window.onload=function(){setTimeout(function(){window.print()},200)}</script></body></html>`
  const w = window.open('', '_blank')
  if (!w) return
  w.document.open()
  w.document.write(html)
  w.document.close()
}
