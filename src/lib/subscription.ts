import type { PlanCatalog, PlatformTenant, Tenant, TenantPricing } from '../types/subscription'

// Pure subscription logic — no Firestore here, so the tenant UI, the
// platform panel and the lock in authStore all agree on the same rules.
// firestore.rules mirrors isSubscriptionLocked() server-side (see
// subscriptionOk() there) — keep the two in step.

export const DAY_MS = 24 * 60 * 60 * 1000

export type SubscriptionStatus =
  | 'not_enforced' // subscriptions not started for this tenant — never locked
  | 'pending' // enforced, but never activated/paid yet — locked
  | 'active'
  | 'expiring' // active, within the reminder window
  | 'grace' // past the end date, still writable until accessUntil
  | 'expired' // read-only

export interface SubscriptionInfo {
  status: SubscriptionStatus
  locked: boolean
  endsAt: number | null
  accessUntil: number | null
  // Whole days until the end date (active/expiring), or until read-only (grace).
  daysLeft: number | null
}

export function isSubscriptionLocked(tenant: Tenant | null | undefined, now: number): boolean {
  if (!tenant || tenant.subscriptionRequired !== true) return false
  const accessUntil = tenant.subscriptionAccessUntil
  return !(typeof accessUntil === 'number' && now < accessUntil)
}

export function getSubscriptionInfo(tenant: Tenant | null | undefined, now: number, reminderDays: number): SubscriptionInfo {
  if (!tenant || tenant.subscriptionRequired !== true) {
    return { status: 'not_enforced', locked: false, endsAt: null, accessUntil: null, daysLeft: null }
  }
  const endsAt = typeof tenant.subscriptionEndsAt === 'number' ? tenant.subscriptionEndsAt : null
  const accessUntil = typeof tenant.subscriptionAccessUntil === 'number' ? tenant.subscriptionAccessUntil : null
  if (endsAt === null || accessUntil === null) {
    return { status: 'pending', locked: true, endsAt, accessUntil, daysLeft: null }
  }
  if (now < endsAt) {
    const daysLeft = Math.ceil((endsAt - now) / DAY_MS)
    return { status: daysLeft <= reminderDays ? 'expiring' : 'active', locked: false, endsAt, accessUntil, daysLeft }
  }
  if (now < accessUntil) {
    return { status: 'grace', locked: false, endsAt, accessUntil, daysLeft: Math.ceil((accessUntil - now) / DAY_MS) }
  }
  return { status: 'expired', locked: true, endsAt, accessUntil, daysLeft: 0 }
}

// ---------- dates ----------

export function endOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

// 31 Jan + 1 month = 28/29 Feb (not 3 Mar, which is what plain
// Date.setMonth does).
export function addMonthsClamped(ms: number, months: number): number {
  const d = new Date(ms)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDay))
  return d.getTime()
}

// Agreed renewal rule: an early renewal is added on top of the current
// end date (no days lost); a late one (grace/expired/pending) starts
// from the approval moment.
export function computeRenewal(currentEndsAt: number | null | undefined, now: number, months: number): { start: number; end: number } {
  const start = typeof currentEndsAt === 'number' && currentEndsAt > now ? currentEndsAt : now
  return { start, end: endOfDay(addMonthsClamped(start, months)) }
}

export function accessUntilFor(endsAt: number, graceDays: number): number {
  return endsAt + Math.max(0, Math.floor(graceDays)) * DAY_MS
}

export function formatDate(ms: number | null | undefined): string {
  if (typeof ms !== 'number') return '—'
  return new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number') return '—'
  return new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatRupees(amount: number): string {
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

// yyyy-mm-dd for <input type="date"> (local time)
export function toDateInputValue(ms: number | null | undefined): string {
  if (typeof ms !== 'number') return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fromDateInputValue(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  return endOfDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime())
}

// ---------- pricing ----------

function validPrice(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

export type PriceSource = 'tenant' | 'category' | 'default'

// Custom price for this tenant > its category's price > global default.
// null = no price anywhere, so the plan isn't offered to this tenant.
export function resolvePrice(
  catalog: PlanCatalog,
  tenantCfg: PlatformTenant | null | undefined,
  planId: string
): { price: number; source: PriceSource } | null {
  const override = tenantCfg?.priceOverrides?.[planId]
  if (validPrice(override)) return { price: override, source: 'tenant' }
  const catId = tenantCfg?.categoryId
  if (catId) {
    const catPrice = catalog.categoryPrices?.[catId]?.[planId]
    if (validPrice(catPrice)) return { price: catPrice, source: 'category' }
  }
  const def = catalog.defaultPrices?.[planId]
  if (validPrice(def)) return { price: def, source: 'default' }
  return null
}

export function buildTenantPricing(catalog: PlanCatalog, tenantCfg: PlatformTenant | null | undefined, now: number): TenantPricing {
  const plans: TenantPricing['plans'] = {}
  for (const plan of catalog.plans) {
    if (!plan.active) continue
    const resolved = resolvePrice(catalog, tenantCfg, plan.id)
    if (!resolved) continue
    plans[plan.id] = { name: plan.name, months: plan.months, price: resolved.price, sort: plan.sort }
  }
  return { plans, updatedAt: now }
}

export function sortedPublishedPlans(pricing: TenantPricing | null | undefined) {
  if (!pricing) return []
  return Object.entries(pricing.plans)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => a.sort - b.sort || a.months - b.months)
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ---------- WhatsApp / UPI helpers ----------

export function normalizeWhatsappNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 10 ? `91${digits}` : digits
}

export function whatsappLink(number: string, text: string): string {
  return `https://wa.me/${normalizeWhatsappNumber(number)}?text=${encodeURIComponent(text)}`
}

export function tenantPaymentNote(tenantId: string, months: number): string {
  return `WDA-${tenantId.slice(0, 6).toUpperCase()}-${months}M`
}

// UTR is optional. When given: letters/digits only, 6–30 chars (UPI
// UTRs are 12 digits; bank transfer references can be longer).
export function normalizeUtr(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

export function isValidUtr(utr: string): boolean {
  return /^[A-Z0-9]{6,30}$/.test(utr)
}
