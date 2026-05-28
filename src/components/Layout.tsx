import { useState, useEffect } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase/config";
import { useAuthStore } from "../store/authStore";
import { collection, getDocs, query, orderBy } from "firebase/firestore";
import { db } from "../firebase/config";
import { Customer } from "../types";
import { getOverdueCustomers } from "../utils/ledger";

type NavItem = {
  path?: string;
  label: string;
  icon: string;
  children?: NavItem[];
};

// Admin sees everything
const adminNavItems: NavItem[] = [
  { path: "/", label: "Dashboard", icon: "📊" },
  { path: "/orders", label: "Orders", icon: "📦" },
  { path: "/create-order", label: "Create Order", icon: "➕" },
  { path: "/packing", label: "Packing View", icon: "📋" },
  { path: "/products", label: "Products", icon: "🛒" },
  { path: "/customers", label: "Customers", icon: "🏪" },
  { path: "/users", label: "Users", icon: "👥" },
  { path: "/agent-cash", label: "Agent Cash", icon: "💵" },

  // Reports Group
  {
    label: "Reports",
    icon: "📑",
    children: [
      {
        path: "/reports/salesrevenue",
        label: "Sales & Revenue",
        icon: "📈",
      },
      {
        path: "/reports/orders",
        label: "Order Reports",
        icon: "📋",
      },
      {
        path: "/reports/stock",
        label: "Stock Reports",
        icon: "📦",
      },
      {
        path: "/reports/finance",
        label: "Finance Reports",
        icon: "💰",
      },
      {
        path: "/reports/customer",
        label: "Customer Reports",
        icon: "🧑‍💼",
      },
      {
        path: "/reports/agent",
        label: "Agent Reports",
        icon: "👥",
      },
    ],
  },
];

// Packing staff — no create order access
const packingNavItems: NavItem[] = [
  { path: "/orders", label: "Orders", icon: "📦" },
  { path: "/create-order", label: "Create Order", icon: "➕" },
  { path: "/packing", label: "Packing View", icon: "📋" },
  { path: "/products", label: "Products", icon: "🛒" },
  { path: "/customers", label: "Customers", icon: "🏪" },
];

export default function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const isPackingStaff = user?.role === "packing_staff";
  const isAdmin = user?.role === "admin";
  const navItems = isPackingStaff ? packingNavItems : adminNavItems;

  const [reportsOpen, setReportsOpen] = useState<boolean>(false);

  // ── Overdue badge count (admin only) ─────────────────────────
  const [overdueCount, setOverdueCount] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    getDocs(query(collection(db, "customers"), orderBy("shopName")))
      .then(async (snap) => {
        const customers = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Customer));
        const overdue = await getOverdueCustomers(customers, 30);
        setOverdueCount(overdue.length);
      })
      .catch(() => {});
  }, [isAdmin]);

  const handleLogout = async (): Promise<void> => {
    await signOut(auth);
    logout();
    navigate("/login");
  };

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const NavContent = () => (
    <>
      {/* Brand */}
      <div className="p-5 border-b border-gray-700">
        <div className="flex items-center gap-3 mb-1">
          <img src="/ptm_logo.jpeg" alt="Logo" className="w-10 h-10 object-contain rounded-lg flex-shrink-0" />
          <h1 className="text-lg font-bold text-orange-400 leading-tight">PTM Mill</h1>
        </div>
        <p className="text-xs text-gray-400 mt-1">{user?.name}</p>
        <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${
          isPackingStaff ? "bg-blue-900 text-blue-300" : "bg-orange-900 text-orange-300"
        }`}>
          {isPackingStaff ? "Operations" : "Admin"}
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          if (item.children) {
            return (
              <div key={item.label}>
                <button type="button" onClick={() => setReportsOpen(!reportsOpen)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium text-gray-300 hover:bg-gray-800 transition-all">
                  <div className="flex items-center gap-3">
                    <span>{item.icon}</span><span>{item.label}</span>
                  </div>
                  <span className="text-lg font-bold">{reportsOpen ? "−" : "+"}</span>
                </button>
                {reportsOpen && (
                  <div className="ml-4 mt-1 space-y-1 border-l border-gray-700 pl-3">
                    {item.children.map((child) => (
                      <NavLink key={child.path} to={child.path!}
                        onClick={() => setSidebarOpen(false)}
                        className={({ isActive }) =>
                          `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all ${
                            isActive ? "bg-orange-500 text-white" : "text-gray-400 hover:bg-gray-800 hover:text-white"
                          }`}>
                        <span>{child.icon}</span>{child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <NavLink key={item.path} to={item.path!} end={item.path === "/"}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive ? "bg-orange-500 text-white"
                  : item.path === "/create-order" ? "text-orange-300 hover:bg-gray-800 border border-orange-800"
                  : "text-gray-300 hover:bg-gray-800"
                }`}>
              <span>{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.path === "/customers" && isAdmin && overdueCount > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center leading-tight">
                  {overdueCount}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="p-3 border-t border-gray-700 space-y-1">
        {!isPackingStaff && (
          <NavLink to="/settings" onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive ? "bg-orange-500 text-white" : "text-gray-300 hover:bg-gray-800"
              }`}>
            <span>⚙️</span> Settings
          </NavLink>
        )}
        <button type="button" onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all">
          <span>🚪</span> Logout
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-screen bg-gray-100">
      {/* ── Desktop Sidebar ── */}
      <div className="hidden md:flex w-60 bg-gray-900 text-white flex-col flex-shrink-0">
        <NavContent />
      </div>

      {/* ── Mobile Overlay ── */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 bg-gray-900 text-white flex flex-col shadow-2xl">
            <NavContent />
          </div>
        </div>
      )}

      {/* ── Main Content ── */}
      <div className="flex-1 overflow-auto flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 flex-shrink-0">
          <button onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <img src="/ptm_logo.jpeg" alt="Logo" className="w-7 h-7 object-contain rounded" />
          <span className="text-sm font-bold text-orange-500">PTM Mill</span>
        </div>

        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </div>
    </div>
  );
}