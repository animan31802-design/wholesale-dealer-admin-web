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
import PackingStation from "./pages/PackingStation";
import Settings from "./pages/Settings";
import Layout from "./components/Layout";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  if (loading)
    return (
      <div className="flex items-center justify-center h-screen text-gray-500">
        Loading...
      </div>
    );
  if (!user) return <Navigate to="/login" />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  if (!user) return <Navigate to="/login" />;
  if (user.role !== "admin") return <Navigate to="/packing" />;
  return <>{children}</>;
}

function PackingRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  if (loading) return null;
  if (!user) return <Navigate to="/login" />;
  if (user.role !== "packing_staff" && user.role !== "admin")
    return <Navigate to="/" />;
  return <>{children}</>;
}

export default function App() {
  const { setUser, setLoading } = useAuthStore();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const userDoc = await getDoc(doc(db, "users", firebaseUser.uid));
        if (userDoc.exists()) {
          setUser(userDoc.data() as AppUser);
        } else {
          setUser(null);
        }
      } else {
        setUser(null);
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
          {/* Admin-only routes */}
          <Route index element={<AdminRoute><Dashboard /></AdminRoute>} />
          <Route path="orders"    element={<AdminRoute><Orders /></AdminRoute>} />
          <Route path="products"  element={<AdminRoute><Products /></AdminRoute>} />
          <Route path="customers" element={<AdminRoute><Customers /></AdminRoute>} />
          <Route path="users"     element={<AdminRoute><Users /></AdminRoute>} />
          <Route path="settings"  element={<AdminRoute><Settings /></AdminRoute>} />

          {/* Packing staff + admin */}
          <Route path="packing" element={<PackingRoute><PackingStation /></PackingRoute>} />
        </Route>

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
  );
}
