import { useState, useRef } from "react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../firebase/config";
import { useAuthStore } from "../store/authStore";
import { AppUser } from "../types";

// ── Brute-force constants ─────────────────────────────────────────
const MAX_ATTEMPTS   = 5;   // lock after this many failures
const LOCKOUT_MS     = 60_000; // 60 seconds

export default function Login() {
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  // Brute-force state (kept in refs so they survive re-renders without causing them)
  const attempts   = useRef(0);
  const lockedUntil = useRef<number>(0);
  const [lockMsg, setLockMsg] = useState("");

  const { logout } = useAuthStore();
  const navigate   = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    // ── Lockout check ─────────────────────────────────────────────
    const now = Date.now();
    if (lockedUntil.current > now) {
      const secs = Math.ceil((lockedUntil.current - now) / 1000);
      setLockMsg(`Too many failed attempts. Please wait ${secs}s before trying again.`);
      return;
    }
    setLockMsg("");
    setError("");
    setLoading(true);

    try {
      const result = await signInWithEmailAndPassword(auth, email, password);

      // Reset failure counter on successful Firebase auth
      attempts.current = 0;

      // ── Validate user doc exists ──────────────────────────────
      const userDoc = await getDoc(doc(db, "users", result.user.uid));
      if (!userDoc.exists()) {
        await signOut(auth);
        // Generic message — don't reveal account existence
        setError("Invalid email or password.");
        return;
      }

      const userData = userDoc.data() as AppUser;

      // ── Role check ────────────────────────────────────────────
      if (userData.role !== "admin" && userData.role !== "packing_staff") {
        await signOut(auth);
        setError("Access denied.");
        return;
      }

      // ── isActive check ────────────────────────────────────────
      if (userData.isActive === false) {
        await signOut(auth);
        logout();
        setError("Your account has been deactivated. Please contact the administrator.");
        return;
      }

      // Don't setUser here — App.tsx onAuthStateChanged handles it
      navigate(userData.role === "packing_staff" ? "/orders" : "/");
    } catch {
      // ── Count failures & apply lockout ────────────────────────
      attempts.current += 1;
      if (attempts.current >= MAX_ATTEMPTS) {
        lockedUntil.current = Date.now() + LOCKOUT_MS;
        attempts.current = 0;
        setLockMsg(`Too many failed attempts. Please wait ${LOCKOUT_MS / 1000}s before trying again.`);
      } else {
        // Always use a generic message — never reveal whether email exists
        setError("Invalid email or password.");
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocked = Date.now() < lockedUntil.current;

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">🏬 Dealer Admin</h1>
          <p className="text-gray-500 mt-2 text-sm">Sign in to your dashboard</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLocked}
              placeholder="admin@example.com"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLocked}
              placeholder="••••••••"
              className="w-full border border-gray-300 rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
            />
          </div>

          {lockMsg && (
            <div className="bg-orange-50 border border-orange-200 text-orange-700 text-sm px-4 py-3 rounded-lg">
              🔒 {lockMsg}
            </div>
          )}

          {error && !lockMsg && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || isLocked}
            className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3 rounded-lg transition-all disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}