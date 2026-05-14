import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase/config";
import { useAuthStore } from "../store/authStore";

// Admin sees everything
const adminNavItems = [
  { path: "/",                    label: "Dashboard",     icon: "📊" },
  { path: "/orders",              label: "Orders",        icon: "📦" },
  { path: "/create-order",        label: "Create Order",  icon: "➕" },
  { path: "/packing",             label: "Packing View",  icon: "📋" },
  { path: "/products",            label: "Products",      icon: "🛒" },
  { path: "/customers",           label: "Customers",     icon: "🏪" },
  { path: "/users",               label: "Users",         icon: "👥" },
  { path: "/reports/salesrevenue",       label: "Sales & Revenue", icon: "📈" },
  { path: "/reports/orders",      label: "Order Reports",   icon: "📋" },
  { path: "/reports/stock",       label: "Stock Reports", icon: "📦" },
  { path: "/reports/finance",     label: "Finance Reports", icon: "💰" },
  { path: "/reports/customer",       label: "Customer Reports", icon: "🧑‍💼" },
  { path: "/reports/agent",     label: "Agent Reports", icon: "👥" },
];

// Packing staff — no create order access
const packingNavItems = [
  { path: "/orders",    label: "Orders",      icon: "📦" },
  { path: "/packing",   label: "Packing View",icon: "📋" },
  { path: "/products",  label: "Products",    icon: "🛒" },
  { path: "/customers", label: "Customers",   icon: "🏪" },
];

export default function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const isPackingStaff = user?.role === "packing_staff";
  const navItems = isPackingStaff ? packingNavItems : adminNavItems;

  const handleLogout = async () => {
    await signOut(auth);
    logout();
    navigate("/login");
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <div className="w-60 bg-gray-900 text-white flex flex-col flex-shrink-0">

        {/* Brand */}
        <div className="p-5 border-b border-gray-700">
          <h1 className="text-lg font-bold text-orange-400">🏬 Dealer Admin</h1>
          <p className="text-xs text-gray-400 mt-1">{user?.name}</p>
          <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${
            isPackingStaff
              ? "bg-blue-900 text-blue-300"
              : "bg-orange-900 text-orange-300"
          }`}>
            {isPackingStaff ? "Operations" : "Admin"}
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? item.path === "/create-order"
                      ? "bg-orange-500 text-white"
                      : "bg-orange-500 text-white"
                    : item.path === "/create-order"
                    ? "text-orange-300 hover:bg-gray-800 border border-orange-800"
                    : "text-gray-300 hover:bg-gray-800"
                }`
              }
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Bottom — Settings (admin only) + Logout */}
        <div className="p-3 border-t border-gray-700 space-y-0.5">
          {!isPackingStaff && (
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? "bg-orange-500 text-white"
                    : "text-gray-300 hover:bg-gray-800"
                }`
              }
            >
              <span>⚙️</span> Settings
            </NavLink>
          )}
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all"
          >
            <span>🚪</span> Logout
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}