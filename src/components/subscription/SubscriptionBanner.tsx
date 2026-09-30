import { Link, useLocation } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { usePendingRequest, useSubscriptionInfo } from "../../store/subscriptionStore";
import { formatDate } from "../../lib/subscription";
import { cx } from "./ui";

// One strip above every page: reminder before the end date, a countdown
// during the grace period, and a read-only notice after it. Shows nothing
// at all until subscriptions have been started for this tenant.
export function SubscriptionBanner() {
  const info = useSubscriptionInfo();
  const pending = usePendingRequest();
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  const isAdmin = user?.role === "admin";

  if (location.pathname.startsWith("/subscription")) return null;
  if (info.status === "not_enforced" || info.status === "active") return null;

  let tone: "amber" | "red" | "blue";
  let text: string;
  if (pending) {
    tone = "blue";
    text = `Subscription payment submitted — waiting for verification.${info.locked ? " The app stays read-only until it is verified." : ""}`;
  } else if (info.status === "pending") {
    tone = "red";
    text = "Subscription not active yet — the app is read-only until it is activated.";
  } else if (info.status === "expiring") {
    tone = "amber";
    text = `Subscription ends on ${formatDate(info.endsAt)} (${info.daysLeft} day${info.daysLeft === 1 ? "" : "s"} left).`;
  } else if (info.status === "grace") {
    tone = "red";
    text = `Subscription ended on ${formatDate(info.endsAt)}. The app becomes read-only in ${info.daysLeft} day${info.daysLeft === 1 ? "" : "s"}.`;
  } else {
    tone = "red";
    text = `🔒 Subscription expired on ${formatDate(info.endsAt)} — read-only mode. You can view and export data, but saving anything will fail.`;
  }
  if (!pending && !isAdmin) text += " Please contact the admin.";

  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5 text-sm",
        tone === "red" && "border-red-200 bg-red-50 text-red-700",
        tone === "amber" && "border-amber-200 bg-amber-50 text-amber-800",
        tone === "blue" && "border-blue-200 bg-blue-50 text-blue-700"
      )}
    >
      <span className="min-w-0 flex-1">{text}</span>
      {isAdmin && (
        <Link to="/subscription" className="shrink-0 rounded-lg bg-white px-3 py-1 text-xs font-semibold shadow-sm ring-1 ring-black/5 hover:bg-gray-50">
          {pending ? "View" : info.status === "expiring" ? "Renew" : "Pay now"}
        </Link>
      )}
    </div>
  );
}
