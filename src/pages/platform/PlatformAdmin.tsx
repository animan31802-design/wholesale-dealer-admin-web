import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase/config";
import { useAuthStore } from "../../store/authStore";
import { cx } from "../../components/subscription/ui";
import { PlatformDataContext, usePlatformDataSource } from "./usePlatformData";
import { PlatformPayments } from "./PlatformPayments";
import { PlatformTenants } from "./PlatformTenants";
import { PlatformPricing } from "./PlatformPricing";
import { PlatformSettings } from "./PlatformSettings";

export type PlatformTab = "payments" | "tenants" | "pricing" | "settings";

// Platform admin screen — only reachable with the separate platform
// login (PlatformRoute in App.tsx; isPlatformAdmin() in firestore.rules).
// Verify payments, manage tenants and their end dates, plans/categories/
// prices, and the UPI / WhatsApp / grace settings.
export default function PlatformAdmin() {
  const data = usePlatformDataSource();
  const platformAdmin = useAuthStore((s) => s.platformAdmin);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [tab, setTab] = useState<PlatformTab>("payments");
  const pendingCount = data.requests.filter((r) => r.status === "pending").length;

  const tabs: { key: PlatformTab; label: string; badge?: number }[] = [
    { key: "payments", label: "💳 Payments", badge: pendingCount },
    { key: "tenants", label: "🏢 Tenants" },
    { key: "pricing", label: "🏷️ Plans & pricing" },
    { key: "settings", label: "⚙️ Settings" },
  ];

  const handleLogout = async () => {
    await signOut(auth);
    logout();
    navigate("/login");
  };

  return (
    <PlatformDataContext.Provider value={data}>
      <div className="min-h-screen bg-gray-100">
        <header className="bg-gray-900 text-white">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-orange-400">Platform admin</p>
              <p className="text-xs text-gray-400">{platformAdmin?.email}</p>
            </div>
            <button onClick={handleLogout} className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white">
              🚪 Logout
            </button>
          </div>
          <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={cx(
                  "flex shrink-0 items-center gap-2 rounded-t-lg px-4 py-2.5 text-sm font-medium",
                  tab === t.key ? "bg-gray-100 text-gray-900" : "text-gray-300 hover:bg-gray-800"
                )}
              >
                {t.label}
                {t.badge ? <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">{t.badge}</span> : null}
              </button>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6">
          {data.loading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : tab === "payments" ? (
            <PlatformPayments onGoTo={setTab} />
          ) : tab === "tenants" ? (
            <PlatformTenants />
          ) : tab === "pricing" ? (
            <PlatformPricing />
          ) : (
            <PlatformSettings />
          )}
        </main>
      </div>
    </PlatformDataContext.Provider>
  );
}
