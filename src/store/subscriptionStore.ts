import { useEffect } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { create } from "zustand";
import { db } from "../firebase/config";
import { useAuthStore } from "./authStore";
import { subscribePublicConfig, subscribeTenantPricing, subscribeTenantRequests } from "../lib/subscriptionApi";
import { getSubscriptionInfo, isSubscriptionLocked, type SubscriptionInfo } from "../lib/subscription";
import {
  DEFAULT_PUBLIC_CONFIG,
  DEFAULT_TENANT_ID,
  type PaymentRequest,
  type PlatformPublicConfig,
  type Tenant,
  type TenantPricing,
} from "../types/subscription";

// Subscription data for the signed-in user's tenant, fed by ONE set of
// listeners (useSubscriptionSync, mounted once in Layout) and read by the
// banner, the Subscription page and the read-only guards.
interface SubscriptionState {
  tenant: Tenant | null;
  config: PlatformPublicConfig;
  pricing: TenantPricing | null;
  requests: PaymentRequest[];
  now: number;
  setTenant: (t: Tenant | null) => void;
  setConfig: (c: PlatformPublicConfig) => void;
  setPricing: (p: TenantPricing | null) => void;
  setRequests: (r: PaymentRequest[]) => void;
  tick: () => void;
}

export const useSubscriptionStore = create<SubscriptionState>((set) => ({
  tenant: null,
  config: DEFAULT_PUBLIC_CONFIG,
  pricing: null,
  requests: [],
  now: Date.now(),
  setTenant: (tenant) => set({ tenant }),
  setConfig: (config) => set({ config }),
  setPricing: (pricing) => set({ pricing }),
  setRequests: (requests) => set({ requests }),
  tick: () => set({ now: Date.now() }),
}));

export function currentTenantId(user: { tenantId?: string } | null | undefined): string {
  return user?.tenantId || DEFAULT_TENANT_ID;
}

export function useSubscriptionSync() {
  const user = useAuthStore((s) => s.user);
  const tenantId = user ? currentTenantId(user) : null;
  const enforced = useSubscriptionStore((s) => s.tenant?.subscriptionRequired === true);

  useEffect(() => {
    const timer = window.setInterval(() => useSubscriptionStore.getState().tick(), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Tenant doc + public config. A missing tenant doc (or any read error)
  // simply means "subscriptions not started" — never a lock.
  useEffect(() => {
    const { setTenant, setConfig } = useSubscriptionStore.getState();
    setTenant(null);
    if (!tenantId) return;
    const unsubTenant = onSnapshot(
      doc(db, "tenants", tenantId),
      (snap) => setTenant(snap.exists() ? ({ ...(snap.data() as Tenant), id: snap.id }) : null),
      () => setTenant(null)
    );
    const unsubConfig = subscribePublicConfig(setConfig);
    return () => {
      unsubTenant();
      unsubConfig();
    };
  }, [tenantId]);

  // Prices and payment requests only matter once subscriptions are on.
  useEffect(() => {
    const { setPricing, setRequests } = useSubscriptionStore.getState();
    setPricing(null);
    setRequests([]);
    if (!tenantId || !enforced) return;
    const unsubPricing = subscribeTenantPricing(tenantId, setPricing);
    const unsubRequests = subscribeTenantRequests(tenantId, setRequests);
    return () => {
      unsubPricing();
      unsubRequests();
    };
  }, [tenantId, enforced]);
}

export function useSubscriptionInfo(): SubscriptionInfo {
  const tenant = useSubscriptionStore((s) => s.tenant);
  const now = useSubscriptionStore((s) => s.now);
  const reminderDays = useSubscriptionStore((s) => s.config.reminderDays);
  return getSubscriptionInfo(tenant, now, reminderDays);
}

// True while the app is read-only (evaluated against the real clock, not
// just the once-a-minute tick, so a page opened at 00:00:30 is right).
export function useSubscriptionLocked(): boolean {
  const tenant = useSubscriptionStore((s) => s.tenant);
  useSubscriptionStore((s) => s.now); // re-render every tick
  return isSubscriptionLocked(tenant, Date.now());
}

export function usePendingRequest(): PaymentRequest | null {
  return useSubscriptionStore((s) => s.requests.find((r) => r.status === "pending") ?? null);
}
