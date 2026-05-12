import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
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
import Layout from "./components/Layout";

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
  const { setUser, setLoading } = useAuthStore();

  const { logout } = useAuthStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userDoc.exists()) {
          setUser(userDoc.data() as AppUser);
        } else {
          logout();
        }
      } else {
        logout();
      }
      setLoading(false);
    });
    return () => unsubscribe();
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
          <Route index        element={<AdminRoute><Dashboard /></AdminRoute>} />
          <Route path="users"     element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="settings"  element={<AdminRoute><Settings /></AdminRoute>} />

          {/* Admin + packing staff */}
          <Route path="orders"    element={<OpsRoute><Orders /></OpsRoute>} />
          <Route path="products"  element={<OpsRoute><Products /></OpsRoute>} />
          <Route path="customers" element={<OpsRoute><Customers /></OpsRoute>} />
          <Route path="packing"   element={<OpsRoute><PackingStation /></OpsRoute>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
