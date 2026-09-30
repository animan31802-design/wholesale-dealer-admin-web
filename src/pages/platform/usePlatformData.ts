import { createContext, useContext, useEffect, useState } from "react";
import { useAuthStore } from "../../store/authStore";
import {
  ensureDefaultPricing,
  subscribeAllRequests,
  subscribeAllTenants,
  subscribeCatalog,
  subscribePlatformTenants,
  subscribePublicConfig,
  type AdminActor,
} from "../../lib/subscriptionApi";
import {
  DEFAULT_PUBLIC_CONFIG,
  EMPTY_CATALOG,
  type PaymentRequest,
  type PlanCatalog,
  type PlatformPublicConfig,
  type PlatformTenant,
  type Tenant,
} from "../../types/subscription";

export interface PlatformData {
  loading: boolean;
  tenants: Tenant[];
  tenantCfgs: Record<string, PlatformTenant>;
  catalog: PlanCatalog;
  requests: PaymentRequest[];
  config: PlatformPublicConfig;
  actor: AdminActor;
  now: number;
}

// All live data the platform panel needs, subscribed once at the top of
// the panel and shared with every tab through context.
export function usePlatformDataSource(): PlatformData {
  const platformAdmin = useAuthStore((s) => s.platformAdmin);
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [tenantCfgs, setTenantCfgs] = useState<Record<string, PlatformTenant>>({});
  const [catalog, setCatalog] = useState<PlanCatalog>(EMPTY_CATALOG);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [config, setConfig] = useState<PlatformPublicConfig>(DEFAULT_PUBLIC_CONFIG);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const unsubs = [
      subscribeAllTenants(setTenants),
      subscribePlatformTenants(setTenantCfgs),
      subscribeCatalog(setCatalog),
      subscribeAllRequests(setRequests),
      subscribePublicConfig(setConfig),
    ];
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      unsubs.forEach((u) => u());
      window.clearInterval(timer);
    };
  }, []);

  const catalogUpdatedAt = catalog.updatedAt ?? 0;
  useEffect(() => {
    if (!catalogUpdatedAt) return;
    ensureDefaultPricing(catalog).catch((err) => console.error("default pricing publish failed", err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogUpdatedAt]);

  return {
    loading: tenants === null,
    tenants: tenants ?? [],
    tenantCfgs,
    catalog,
    requests,
    config,
    now,
    actor: { uid: platformAdmin?.uid ?? "", name: platformAdmin?.email || "Platform admin" },
  };
}

export const PlatformDataContext = createContext<PlatformData | null>(null);

export function usePlatformData(): PlatformData {
  const ctx = useContext(PlatformDataContext);
  if (!ctx) throw new Error("usePlatformData must be used inside PlatformAdmin");
  return ctx;
}
