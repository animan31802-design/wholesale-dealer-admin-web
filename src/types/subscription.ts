// ---------- Platform subscription ----------
//
// Same model as wholesale-manager-web, keyed by TENANT. Today the whole
// app is one tenant (PTM Mill, id "main" — see DEFAULT_TENANT_ID); when
// the app goes multi-tenant each dealer is just another tenant record and
// users get a tenantId. No payment gateway: the admin pays by UPI QR,
// submits "I've paid", and the platform admin verifies and approves.
//
// Firestore layout:
//   /platformAdmins/{uid}            — exists() = platform admin (create by hand in the console)
//   /tenants/{tenantId}              — Tenant (subscription dates; written only by the platform admin)
//   /platform/public                 — PlatformPublicConfig (any signed-in user can read)
//   /platform/defaultPricing         — TenantPricing used by tenants without their own
//   /platform/catalog                — PlanCatalog (platform admin only)
//   /platform/counters               — { receiptSeq } (platform admin only)
//   /platformTenants/{tenantId}      — PlatformTenant (category, custom prices, notes — platform only)
//   /tenantPricing/{tenantId}        — TenantPricing for ONE tenant (that tenant can read)
//   /paymentRequests/{id}            — PaymentRequest
//   /paymentUtrs/{utr}               — { tenantId, requestId } — a UTR can be used once
//   /subscriptionEvents/{id}         — SubscriptionEvent (platform audit trail)

export const DEFAULT_TENANT_ID = 'main'

export interface Tenant {
  id: string
  name: string
  ownerName?: string
  // Digits, used for WhatsApp reminders from the platform panel.
  phone?: string
  createdAt: number
  // Subscription — same meaning as in wholesale-manager-web. A tenant
  // without subscriptionRequired === true is never locked.
  subscriptionRequired?: boolean
  subscriptionEndsAt?: number
  subscriptionAccessUntil?: number
  subscriptionUpdatedAt?: number
}

export interface PlatformPublicConfig {
  upiVpa: string
  payeeName: string
  // Digits only, with country code (e.g. 919876543210). Used for the
  // wa.me "Notify on WhatsApp" link after a shop submits a payment.
  whatsappNumber: string
  graceDays: number
  // Banner starts this many days before the end date.
  reminderDays: number
  // Printed on receipts (optional).
  receiptIssuerName?: string
  receiptIssuerDetails?: string
  updatedAt?: number
}

export const DEFAULT_PUBLIC_CONFIG: PlatformPublicConfig = {
  upiVpa: '',
  payeeName: '',
  whatsappNumber: '',
  graceDays: 3,
  reminderDays: 7,
  receiptIssuerName: '',
  receiptIssuerDetails: '',
}

export interface PlanDef {
  id: string
  name: string
  months: number
  active: boolean
  sort: number
}

export interface ShopCategory {
  id: string
  name: string
}

export interface PlanCatalog {
  plans: PlanDef[]
  categories: ShopCategory[]
  // planId -> price. Used when a tenant has no category, or its category
  // has no price for that plan.
  defaultPrices: Record<string, number>
  // categoryId -> planId -> price
  categoryPrices: Record<string, Record<string, number>>
  updatedAt?: number
}

export const EMPTY_CATALOG: PlanCatalog = { plans: [], categories: [], defaultPrices: {}, categoryPrices: {} }

export interface PlatformTenant {
  tenantId: string
  categoryId?: string | null
  // planId -> price. Beats category and default prices for this one tenant.
  priceOverrides?: Record<string, number>
  notes?: string
  updatedAt?: number
}

export interface PublishedPlan {
  name: string
  months: number
  price: number
  sort: number
}

// What a tenant actually sees and pays — one resolved price per active
// plan. Firestore rules check a payment request's amount against this.
export interface TenantPricing {
  plans: Record<string, PublishedPlan>
  updatedAt: number
}

export type PaymentRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'

export interface PaymentRequest {
  id: string
  tenantId: string
  tenantName: string
  planId: string
  planName: string
  months: number
  amount: number
  utr: string | null
  screenshotUrl: string | null
  status: PaymentRequestStatus
  submittedBy: string
  submittedByName: string
  submittedAt: number
  // Set by the platform admin on decision
  decidedAt?: number
  decidedBy?: string
  rejectReason?: string
  adminNote?: string
  periodStart?: number
  periodEnd?: number
  receiptNo?: string
  // Set when the admin cancels their own pending request
  cancelledAt?: number
  cancelledBy?: string
}

export type SubscriptionEventType = 'approved' | 'rejected' | 'date_changed' | 'enforcement_on' | 'enforcement_off'

export interface SubscriptionEvent {
  id: string
  tenantId: string
  type: SubscriptionEventType
  oldEndsAt: number | null
  newEndsAt: number | null
  reason: string
  requestId?: string | null
  by: string
  byName: string
  at: number
}
