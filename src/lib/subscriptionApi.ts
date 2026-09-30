import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import { db } from '../firebase/config'
import {
  DEFAULT_PUBLIC_CONFIG,
  EMPTY_CATALOG,
  type PaymentRequest,
  type PlanCatalog,
  type PlatformPublicConfig,
  type PlatformTenant,
  type Tenant,
  type TenantPricing,
  type SubscriptionEvent,
  type SubscriptionEventType,
} from '../types/subscription'
import { accessUntilFor, buildTenantPricing, computeRenewal, newId } from './subscription'

// All Firestore reads/writes for the subscription feature. Tenant-side
// functions first, then platform-admin-only ones. Who may do what is
// enforced by firestore.rules — these just shape the documents.

const publicConfigRef = () => doc(db, 'platform', 'public')
const catalogRef = () => doc(db, 'platform', 'catalog')
const countersRef = () => doc(db, 'platform', 'counters')
const defaultPricingRef = () => doc(db, 'platform', 'defaultPricing')

// ---------- shared ----------

// Platform admin = /platformAdmins/{uid} exists. Rules only let a user
// read their OWN doc there, so a normal user just gets false.
export async function isPlatformAdminUid(uid: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'platformAdmins', uid))
    return snap.exists()
  } catch {
    return false
  }
}

export function subscribePublicConfig(cb: (cfg: PlatformPublicConfig) => void): () => void {
  return onSnapshot(
    publicConfigRef(),
    (snap) => cb({ ...DEFAULT_PUBLIC_CONFIG, ...(snap.exists() ? (snap.data() as Partial<PlatformPublicConfig>) : {}) }),
    () => cb(DEFAULT_PUBLIC_CONFIG)
  )
}

// ---------- tenant side ----------

// A tenant's own published price list (/tenantPricing/{id}) when the platform
// admin has given it a category or custom prices; otherwise the default
// price list (/platform/defaultPricing). The fallback is what lets a
// brand-new tenant see plans the moment it registers.
export function subscribeTenantPricing(tenantId: string, cb: (p: TenantPricing | null) => void): () => void {
  let own: TenantPricing | null | undefined
  let fallback: TenantPricing | null | undefined
  const emit = () => {
    if (own === undefined) return // wait for the tenant's own doc first
    if (own) return cb(own)
    if (fallback !== undefined) cb(fallback)
  }
  const unsubOwn = onSnapshot(
    doc(db, 'tenantPricing', tenantId),
    (snap) => {
      own = snap.exists() ? (snap.data() as TenantPricing) : null
      emit()
    },
    () => {
      own = null
      emit()
    }
  )
  const unsubDefault = onSnapshot(
    defaultPricingRef(),
    (snap) => {
      fallback = snap.exists() ? (snap.data() as TenantPricing) : null
      emit()
    },
    () => {
      fallback = null
      emit()
    }
  )
  return () => {
    unsubOwn()
    unsubDefault()
  }
}

// No orderBy on purpose — sorting client-side avoids needing a composite
// index (a tenant only ever has a handful of these).
export function subscribeTenantRequests(tenantId: string, cb: (reqs: PaymentRequest[]) => void): () => void {
  return onSnapshot(
    query(collection(db, 'paymentRequests'), where('tenantId', '==', tenantId)),
    (snap) => cb(snap.docs.map((d) => ({ ...(d.data() as PaymentRequest), id: d.id })).sort((a, b) => b.submittedAt - a.submittedAt)),
    () => cb([])
  )
}

export class DuplicateUtrError extends Error {
  constructor() {
    super('This UTR / reference number has already been submitted.')
  }
}

export async function submitPaymentRequest(input: {
  tenant: Tenant
  planId: string
  planName: string
  months: number
  amount: number
  utr: string | null
  screenshotUrl: string | null
  uid: string
  userName: string
}): Promise<PaymentRequest> {
  const ref = doc(collection(db, 'paymentRequests'))
  const request: PaymentRequest = {
    id: ref.id,
    tenantId: input.tenant.id,
    tenantName: input.tenant.name,
    planId: input.planId,
    planName: input.planName,
    months: input.months,
    amount: input.amount,
    utr: input.utr,
    screenshotUrl: input.screenshotUrl,
    status: 'pending',
    submittedBy: input.uid,
    submittedByName: input.userName,
    submittedAt: Date.now(),
  }
  // A UTR can only ever be claimed once, across all tenants. The rules
  // enforce it (creating an existing /paymentUtrs doc counts as an
  // update, which tenants can't do); this read just gives a clear message.
  if (input.utr) {
    const existing = await getDoc(doc(db, 'paymentUtrs', input.utr))
    if (existing.exists()) throw new DuplicateUtrError()
  }
  const batch = writeBatch(db)
  batch.set(ref, request)
  if (input.utr) batch.set(doc(db, 'paymentUtrs', input.utr), { tenantId: input.tenant.id, requestId: ref.id, at: Date.now() })
  await batch.commit()
  return request
}

export async function cancelPaymentRequest(requestId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'paymentRequests', requestId), { status: 'cancelled', cancelledAt: Date.now(), cancelledBy: uid })
}

// ---------- platform admin ----------

export async function savePublicConfig(next: PlatformPublicConfig, previousGraceDays: number, tenants: Tenant[]): Promise<void> {
  await setDoc(publicConfigRef(), { ...next, updatedAt: Date.now() })
  // accessUntil is stored per tenant (rules can't do date maths on a
  // second doc cheaply), so a grace change has to be re-applied to
  // every active subscription.
  if (next.graceDays !== previousGraceDays) await reapplyGrace(next.graceDays, tenants)
}

async function reapplyGrace(graceDays: number, tenants: Tenant[]) {
  const targets = tenants.filter((b) => b.subscriptionRequired === true && typeof b.subscriptionEndsAt === 'number')
  for (let i = 0; i < targets.length; i += 400) {
    const batch = writeBatch(db)
    for (const b of targets.slice(i, i + 400)) {
      batch.update(doc(db, 'tenants', b.id), {
        subscriptionAccessUntil: accessUntilFor(b.subscriptionEndsAt as number, graceDays),
        subscriptionUpdatedAt: Date.now(),
      })
    }
    await batch.commit()
  }
}

export function subscribeCatalog(cb: (c: PlanCatalog) => void): () => void {
  return onSnapshot(catalogRef(), (snap) => cb({ ...EMPTY_CATALOG, ...(snap.exists() ? (snap.data() as Partial<PlanCatalog>) : {}) }))
}

export function subscribeAllTenants(cb: (b: Tenant[]) => void): () => void {
  return onSnapshot(collection(db, 'tenants'), (snap) =>
    cb(snap.docs.map((d) => ({ ...(d.data() as Tenant), id: d.id })).sort((a, b) => a.name.localeCompare(b.name)))
  )
}

export function subscribePlatformTenants(cb: (tenantCfgs: Record<string, PlatformTenant>) => void): () => void {
  return onSnapshot(collection(db, 'platformTenants'), (snap) => {
    const out: Record<string, PlatformTenant> = {}
    snap.docs.forEach((d) => (out[d.id] = { ...(d.data() as PlatformTenant), tenantId: d.id }))
    cb(out)
  })
}

export function subscribeAllRequests(cb: (reqs: PaymentRequest[]) => void): () => void {
  return onSnapshot(query(collection(db, 'paymentRequests'), orderBy('submittedAt', 'desc'), limit(300)), (snap) =>
    cb(snap.docs.map((d) => ({ ...(d.data() as PaymentRequest), id: d.id })))
  )
}

export function subscribeTenantEvents(tenantId: string, cb: (events: SubscriptionEvent[]) => void): () => void {
  return onSnapshot(query(collection(db, 'subscriptionEvents'), where('tenantId', '==', tenantId)), (snap) =>
    cb(snap.docs.map((d) => ({ ...(d.data() as SubscriptionEvent), id: d.id })).sort((a, b) => b.at - a.at))
  )
}

// Re-publishes the resolved price list for the given tenants (all tenants
// when called after a catalog change).
export async function publishTenantPricing(catalog: PlanCatalog, tenantIds: string[], tenantCfgs: Record<string, PlatformTenant>): Promise<void> {
  const now = Date.now()
  for (let i = 0; i < tenantIds.length; i += 400) {
    const batch = writeBatch(db)
    for (const id of tenantIds.slice(i, i + 400)) {
      batch.set(doc(db, 'tenantPricing', id), buildTenantPricing(catalog, tenantCfgs[id], now))
    }
    await batch.commit()
  }
}

export async function saveCatalog(catalog: PlanCatalog, tenants: Tenant[], tenantCfgs: Record<string, PlatformTenant>): Promise<void> {
  await setDoc(catalogRef(), { ...catalog, updatedAt: Date.now() })
  await publishDefaultPricing(catalog)
  await publishTenantPricing(catalog, tenants.map((b) => b.id), tenantCfgs)
}

// Default prices (no category, no custom price) — what any tenant without
// its own /tenantPricing doc sees, including tenants added after the
// last catalog save.
export async function publishDefaultPricing(catalog: PlanCatalog): Promise<void> {
  await setDoc(defaultPricingRef(), buildTenantPricing(catalog, null, Date.now()))
}

// Called when the platform panel opens: catalogs saved before
// defaultPricing existed get it published once, automatically.
export async function ensureDefaultPricing(catalog: PlanCatalog): Promise<void> {
  if (!catalog.updatedAt) return
  const snap = await getDoc(defaultPricingRef())
  const current = snap.exists() ? (snap.data() as TenantPricing) : null
  if (!current || current.updatedAt < catalog.updatedAt) await publishDefaultPricing(catalog)
}

export async function savePlatformTenant(
  tenantId: string,
  patch: Omit<PlatformTenant, 'tenantId'>,
  catalog: PlanCatalog,
  tenantCfgs: Record<string, PlatformTenant>
): Promise<void> {
  const next: PlatformTenant = { ...(tenantCfgs[tenantId] ?? {}), ...patch, tenantId, updatedAt: Date.now() }
  await setDoc(doc(db, 'platformTenants', tenantId), next)
  await publishTenantPricing(catalog, [tenantId], { ...tenantCfgs, [tenantId]: next })
}

function eventDoc(e: Omit<SubscriptionEvent, 'id'>) {
  const ref = doc(collection(db, 'subscriptionEvents'))
  return { ref, data: { ...e, id: ref.id } }
}

export interface AdminActor {
  uid: string
  name: string
}

export async function approvePaymentRequest(
  request: PaymentRequest,
  opts: { endsAtOverride: number | null; note: string; graceDays: number; actor: AdminActor }
): Promise<void> {
  await runTransaction(db, async (tx) => {
    const reqRef = doc(db, 'paymentRequests', request.id)
    const bizRef = doc(db, 'tenants', request.tenantId)
    const [reqSnap, bizSnap, counterSnap] = await Promise.all([tx.get(reqRef), tx.get(bizRef), tx.get(countersRef())])
    if (!reqSnap.exists() || (reqSnap.data() as PaymentRequest).status !== 'pending') throw new Error('This request is no longer pending.')
    if (!bizSnap.exists()) throw new Error('Tenant not found.')
    const biz = bizSnap.data() as Tenant
    const now = Date.now()
    const oldEndsAt = typeof biz.subscriptionEndsAt === 'number' ? biz.subscriptionEndsAt : null
    const renewal = computeRenewal(oldEndsAt, now, request.months)
    const endsAt = opts.endsAtOverride ?? renewal.end

    const seq = ((counterSnap.exists() ? (counterSnap.data().receiptSeq as number) : 0) || 0) + 1
    const receiptNo = `WM-${new Date(now).getFullYear()}-${String(seq).padStart(4, '0')}`

    tx.set(countersRef(), { receiptSeq: seq }, { merge: true })
    tx.update(bizRef, {
      subscriptionRequired: true,
      subscriptionEndsAt: endsAt,
      subscriptionAccessUntil: accessUntilFor(endsAt, opts.graceDays),
      subscriptionUpdatedAt: now,
    })
    tx.update(reqRef, {
      status: 'approved',
      decidedAt: now,
      decidedBy: opts.actor.uid,
      adminNote: opts.note,
      periodStart: renewal.start,
      periodEnd: endsAt,
      receiptNo,
    })
    const ev = eventDoc({
      tenantId: request.tenantId,
      type: 'approved',
      oldEndsAt,
      newEndsAt: endsAt,
      reason: opts.note || `${request.planName} — ₹${request.amount}`,
      requestId: request.id,
      by: opts.actor.uid,
      byName: opts.actor.name,
      at: now,
    })
    tx.set(ev.ref, ev.data)
  })
}

export async function rejectPaymentRequest(request: PaymentRequest, reason: string, actor: AdminActor): Promise<void> {
  const now = Date.now()
  const batch = writeBatch(db)
  batch.update(doc(db, 'paymentRequests', request.id), { status: 'rejected', decidedAt: now, decidedBy: actor.uid, rejectReason: reason })
  const ev = eventDoc({
    tenantId: request.tenantId,
    type: 'rejected',
    oldEndsAt: null,
    newEndsAt: null,
    reason,
    requestId: request.id,
    by: actor.uid,
    byName: actor.name,
    at: now,
  })
  batch.set(ev.ref, ev.data)
  await batch.commit()
}

// Set a tenant's end date directly (also used to activate a pending
// tenant or to start subscriptions for an existing one). Always turns
// enforcement on, always logs the reason.
export async function changeEndDate(tenant: Tenant, newEndsAt: number, reason: string, graceDays: number, actor: AdminActor): Promise<void> {
  const now = Date.now()
  const batch = writeBatch(db)
  batch.update(doc(db, 'tenants', tenant.id), {
    subscriptionRequired: true,
    subscriptionEndsAt: newEndsAt,
    subscriptionAccessUntil: accessUntilFor(newEndsAt, graceDays),
    subscriptionUpdatedAt: now,
  })
  const ev = eventDoc({
    tenantId: tenant.id,
    type: 'date_changed',
    oldEndsAt: typeof tenant.subscriptionEndsAt === 'number' ? tenant.subscriptionEndsAt : null,
    newEndsAt,
    reason,
    requestId: null,
    by: actor.uid,
    byName: actor.name,
    at: now,
  })
  batch.set(ev.ref, ev.data)
  await batch.commit()
}

// Turning enforcement OFF makes the tenant behave like before
// subscriptions (never locked). Turning it back ON keeps whatever dates
// were there — with none, the tenant becomes "pending activation".
export async function setEnforcement(tenant: Tenant, required: boolean, reason: string, actor: AdminActor): Promise<void> {
  const now = Date.now()
  const batch = writeBatch(db)
  batch.update(doc(db, 'tenants', tenant.id), { subscriptionRequired: required, subscriptionUpdatedAt: now })
  const type: SubscriptionEventType = required ? 'enforcement_on' : 'enforcement_off'
  const endsAt = typeof tenant.subscriptionEndsAt === 'number' ? tenant.subscriptionEndsAt : null
  const ev = eventDoc({ tenantId: tenant.id, type, oldEndsAt: endsAt, newEndsAt: endsAt, reason, requestId: null, by: actor.uid, byName: actor.name, at: now })
  batch.set(ev.ref, ev.data)
  await batch.commit()
}

// Tenants are created by the platform admin. A new tenant starts with
// subscriptions NOT started (never locked) — set an end date from the
// panel to start them.
export async function createTenant(input: { id: string; name: string; ownerName?: string; phone?: string }): Promise<void> {
  const ref = doc(db, 'tenants', input.id)
  const existing = await getDoc(ref)
  if (existing.exists()) throw new Error(`A tenant with id "${input.id}" already exists.`)
  const tenant: Tenant = { id: input.id, name: input.name, createdAt: Date.now() }
  if (input.ownerName) tenant.ownerName = input.ownerName
  if (input.phone) tenant.phone = input.phone
  await setDoc(ref, tenant)
}

export async function updateTenantProfile(tenantId: string, patch: { name: string; ownerName: string; phone: string }): Promise<void> {
  await updateDoc(doc(db, 'tenants', tenantId), patch)
}

export { newId }
