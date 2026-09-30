import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { auth, db } from "./firebase/config";
import { useAuthStore } from "./store/authStore";
import { AppUser } from "./types";
import { isPlatformAdminUid } from "./lib/subscriptionApi";

import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import Products from "./pages/Products";
import Customers from "./pages/Customers";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import PackingStation from "./pages/PackingStation";
import CreateOrderPage from "./pages/CreateOrderPage";
import SalesRevenueReports from "./pages/SalesRevenueReports";
import StockReports from "./pages/StockReports";
import FinanceReports from "./pages/FinanceReports";
import AgentReports from "./pages/AgentReports";
import OrderReports from "./pages/OrderReports";
import CustomerReports from "./pages/CustomerReports";
import AgentCashCollection from "./pages/AgentCashCollection";
import Staff from "./pages/Staff";
import StaffAttendance from "./pages/StaffAttendance";
import StaffAttendanceReports from "./pages/StaffAttendanceReports";
import Layout from "./components/Layout";
import ProcessingStation from "./pages/ProcessingStation";
import Subscription from "./pages/Subscription";
import PlatformAdmin from "./pages/platform/PlatformAdmin";
import { ReadOnlyGuard } from "./components/subscription/ReadOnlyGuard";

// ── Route guards ─────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, platformAdmin } = useAuthStore();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-gray-500 text-sm">
        Loading...
      </div>
    );
  // Platform admin login has no business account — send it to its own screen.
  if (!user && platformAdmin) return <Navigate to="/platform" replace />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// Platform admin only (a login with a /platformAdmins doc and no /users doc)
function PlatformRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, platformAdmin } = useAuthStore();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-gray-500 text-sm">
        Loading...
      </div>
    );
  if (platformAdmin) return <>{children}</>;
  if (user) return <Navigate to="/" replace />;
  return <Navigate to="/login" replace />;
}

// Admin only — redirects packing staff to /orders
function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/orders" replace />;
  return <>{children}</>;
}

// Admin + packing_staff allowed — everyone else goes to /login
function OpsRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin" && user.role !== "packing_staff")
    return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { setUser, setLoading, logout, setPlatformAdmin } = useAuthStore();
  // Keep a ref to the live user-doc unsubscribe so we can cancel it on sign-out
  const userDocUnsub = useRef<(() => void) | null>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      // Cancel any previous real-time listener from a prior session
      if (userDocUnsub.current) { userDocUnsub.current(); userDocUnsub.current = null; }

      if (firebaseUser) {
        // Initial load: read once to set user before subscribing
        const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userDoc.exists()) {
          const userData = userDoc.data() as AppUser;
          if (userData.isActive === false) {
            await signOut(auth);
            logout();
          } else {
            setUser(userData);
            // FIX (LOW): Real-time listener keeps role/isActive in sync.
            // If an admin changes this user's role or deactivates them,
            // the UI updates immediately without requiring re-login.
            userDocUnsub.current = onSnapshot(
              doc(db, "users", firebaseUser.uid),
              (snap) => {
                if (!snap.exists()) { logout(); return; }
                const live = snap.data() as AppUser;
                if (live.isActive === false) {
                  signOut(auth).then(() => logout());
                } else {
                  setUser(live);
                }
              },
              () => { /* permission error after deactivation — already signed out */ }
            );
          }
        } else {
          // No business account. The only other valid login is the
          // platform admin (see pages/platform) — anything else is signed
          // out exactly as before.
          const platformAdmin = await isPlatformAdminUid(firebaseUser.uid);
          if (platformAdmin) {
            setUser(null);
            setPlatformAdmin({ uid: firebaseUser.uid, email: firebaseUser.email ?? "" });
          } else {
            logout();
          }
        }
      } else {
        logout();
      }
      setLoading(false);
    });
    return () => {
      unsubscribe();
      if (userDocUnsub.current) userDocUnsub.current();
    };
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/platform" element={<PlatformRoute><PlatformAdmin /></PlatformRoute>} />

        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          {/* Admin only */}
          <Route index           element={<AdminRoute><Dashboard /></AdminRoute>} />
          <Route path="users"    element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
          <Route path="subscription" element={<AdminRoute><Subscription /></AdminRoute>} />

          {/* Admin + packing staff */}
          <Route path="orders"        element={<OpsRoute><Orders /></OpsRoute>} />
          <Route path="products"      element={<OpsRoute><Products /></OpsRoute>} />
          <Route path="customers"     element={<OpsRoute><Customers /></OpsRoute>} />
          <Route path="packing"       element={<OpsRoute><ReadOnlyGuard page="Packing View"><PackingStation /></ReadOnlyGuard></OpsRoute>} />
          <Route path="processing"    element={<OpsRoute><ReadOnlyGuard page="Processing"><ProcessingStation /></ReadOnlyGuard></OpsRoute>} />

          {/* Create order — admin only (admins place orders on behalf of field agents on web) */}
          <Route path="create-order"     element={<AdminRoute><ReadOnlyGuard page="Create Order"><CreateOrderPage /></ReadOnlyGuard></AdminRoute>} />

          {/* Agent Cash Collection — admin only */}
          <Route path="agent-cash"       element={<AdminRoute><AgentCashCollection /></AdminRoute>} />

          {/* Reports — admin only */}
          <Route path="reports/salesrevenue"    element={<AdminRoute><SalesRevenueReports /></AdminRoute>} />
          <Route path="reports/stock"    element={<AdminRoute><StockReports /></AdminRoute>} />
          <Route path="reports/finance"  element={<AdminRoute><FinanceReports /></AdminRoute>} />
          <Route path="reports/agent"  element={<AdminRoute><AgentReports /></AdminRoute>} />
          <Route path="reports/orders"   element={<AdminRoute><OrderReports /></AdminRoute>} />
          <Route path="reports/customer"  element={<AdminRoute><CustomerReports /></AdminRoute>} />

          {/* Staff & Attendance — admin only for staff mgmt, packing staff can mark attendance */}
          <Route path="staff"      element={<AdminRoute><Staff /></AdminRoute>} />
          <Route path="attendance" element={<OpsRoute><ReadOnlyGuard page="Attendance"><StaffAttendance /></ReadOnlyGuard></OpsRoute>} />
          <Route path="/reports/attendance" element={<OpsRoute><StaffAttendanceReports /></OpsRoute>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}