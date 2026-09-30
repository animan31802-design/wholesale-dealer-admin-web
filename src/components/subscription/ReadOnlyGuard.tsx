import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { useSubscriptionLocked } from "../../store/subscriptionStore";

// Screens that exist only to create/change records (Create Order, Packing,
// Processing, Attendance marking). While the subscription has lapsed the
// app is read-only, so these show a notice instead of a form that would
// fail on save. Firestore rules refuse the writes regardless.
export function ReadOnlyGuard({ page, children }: { page: string; children: ReactNode }) {
  const locked = useSubscriptionLocked();
  const user = useAuthStore((s) => s.user);
  if (!locked) return <>{children}</>;
  return (
    <div className="flex items-center justify-center p-8 min-h-[60vh]">
      <div className="max-w-md text-center bg-white border border-gray-200 rounded-xl shadow-sm p-6">
        <div className="text-3xl mb-2">🔒</div>
        <p className="font-semibold text-gray-800">{page} is unavailable in read-only mode</p>
        <p className="text-sm text-gray-500 mt-1">
          The subscription has expired, so nothing new can be added or changed. You can still view and export existing data.
        </p>
        {user?.role === "admin" ? (
          <Link to="/subscription" className="inline-block mt-4 px-4 py-2 text-sm font-medium text-white bg-orange-500 rounded-lg hover:bg-orange-600">
            Renew subscription
          </Link>
        ) : (
          <p className="text-sm text-gray-600 mt-3 font-medium">Please contact the admin to renew.</p>
        )}
      </div>
    </div>
  );
}
