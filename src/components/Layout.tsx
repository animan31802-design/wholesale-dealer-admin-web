import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase/config";
import { useAuthStore } from "../store/authStore";

const navItems = [
  { path: "/", label: "Dashboard", icon: "📊" },
  { path: "/orders", label: "Orders", icon: "📦" },
  { path: "/products", label: "Products", icon: "🛒" },
  { path: "/customers", label: "Customers", icon: "🏪" },
  { path: "/users", label: "Users", icon: "👥" },
];

export default function Layout() {
  const { user, setUser } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    setUser(null);
    navigate("/login");
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <div className="w-64 bg-gray-900 text-white flex flex-col">
        <div className="p-5 border-b border-gray-700">
          <h1 className="text-xl font-bold text-orange-400">🏬 Dealer Admin</h1>
          <p className="text-xs text-gray-400 mt-1">{user?.name}</p>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? "bg-orange-500 text-white"
                    : "text-gray-300 hover:bg-gray-800"
                }`
              }
            >
              <span>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleLogout}
            className="w-full px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-all text-left"
          >
            🚪 Logout
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
