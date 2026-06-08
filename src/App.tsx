import { useEffect, useRef } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { auth, db } from "./firebase/config";
import { useAuthStore } from "./store/authStore";
import { AppUser } from "./types";

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
import Layout from "./components/Layout";
import ProcessingStation from "./pages/ProcessingStation";

// ── Route guards ─────────────────────────────────────────────────

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-gray-500 text-sm">
        Loading...
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
  const { setUser, setLoading, logout } = useAuthStore();
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
          logout();
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

          {/* Admin + packing staff */}
          <Route path="orders"        element={<OpsRoute><Orders /></OpsRoute>} />
          <Route path="products"      element={<OpsRoute><Products /></OpsRoute>} />
          <Route path="customers"     element={<OpsRoute><Customers /></OpsRoute>} />
          <Route path="packing"       element={<OpsRoute><PackingStation /></OpsRoute>} />
          <Route path="processing"    element={<OpsRoute><ProcessingStation /></OpsRoute>} />

          {/* Create order — admin only (admins place orders on behalf of field agents on web) */}
          <Route path="create-order"     element={<AdminRoute><CreateOrderPage /></AdminRoute>} />

          {/* Agent Cash Collection — admin only */}
          <Route path="agent-cash"       element={<AdminRoute><AgentCashCollection /></AdminRoute>} />

          {/* Reports — admin only */}
          <Route path="reports/salesrevenue"    element={<AdminRoute><SalesRevenueReports /></AdminRoute>} />
          <Route path="reports/stock"    element={<AdminRoute><StockReports /></AdminRoute>} />
          <Route path="reports/finance"  element={<AdminRoute><FinanceReports /></AdminRoute>} />
          <Route path="reports/agent"  element={<AdminRoute><AgentReports /></AdminRoute>} />
          <Route path="reports/orders"   element={<AdminRoute><OrderReports /></AdminRoute>} />
          <Route path="reports/customer"  element={<AdminRoute><CustomerReports /></AdminRoute>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}