import { useState, useRef } from "react";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { auth, db } from "../firebase/config";
import { useAuthStore } from "../store/authStore";
import { AppUser } from "../types";

// ── Brute-force constants ─────────────────────────────────────────
// NOTE: These are client-side guards only (UX layer). For production,
// enable Firebase App Check + reCAPTCHA Enterprise in the Firebase console
// for true server-side brute-force protection.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS   = 60_000; // 60 seconds

// ── Persist lockout in sessionStorage so page-refresh doesn't reset it ──
function getLockState(): { attempts: number; lockedUntil: number } {
  try {
    const raw = sessionStorage.getItem("_login_lock");
    return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
  } catch {
    return { attempts: 0, lockedUntil: 0 };
  }
}

function saveLockState(state: { attempts: number; lockedUntil: number }) {
  try {
    sessionStorage.setItem("_login_lock", JSON.stringify(state));
  } catch { /* sessionStorage unavailable — fail gracefully */ }
}

function clearLockState() {
  try { sessionStorage.removeItem("_login_lock"); } catch { /* ignore */ }
}

export default function Login() {
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [lockMsg, setLockMsg]   = useState("");

  // Derive initial lock state from sessionStorage so refresh doesn't bypass it
  const lockState = useRef(getLockState());

  const { logout } = useAuthStore();
  const navigate   = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    // ── Lockout check (survives page reload via sessionStorage) ───
    const state = lockState.current;
    const now   = Date.now();
    if (state.lockedUntil > now) {
      const secs = Math.ceil((state.lockedUntil - now) / 1000);
      setLockMsg(`Too many failed attempts. Please wait ${secs}s before trying again.`);
      return;
    }

    setLockMsg("");
    setError("");
    setLoading(true);

    try {
      const result = await signInWithEmailAndPassword(auth, email, password);

      // Reset failure counter on successful Firebase auth
      lockState.current = { attempts: 0, lockedUntil: 0 };
      clearLockState();

      // ── Validate user doc exists ──────────────────────────────
      const userDoc = await getDoc(doc(db, "users", result.user.uid));
      if (!userDoc.exists()) {
        await signOut(auth);
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

      navigate(userData.role === "packing_staff" ? "/orders" : "/");
    } catch {
      // ── Count failures & apply lockout ────────────────────────
      const newAttempts = (lockState.current.attempts || 0) + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        const newState = { attempts: 0, lockedUntil: Date.now() + LOCKOUT_MS };
        lockState.current = newState;
        saveLockState(newState);
        setLockMsg(`Too many failed attempts. Please wait ${LOCKOUT_MS / 1000}s before trying again.`);
      } else {
        const newState = { attempts: newAttempts, lockedUntil: 0 };
        lockState.current = newState;
        saveLockState(newState);
        setError("Invalid email or password.");
      }
    } finally {
      setLoading(false);
    }
  };

  const isLocked = Date.now() < lockState.current.lockedUntil;

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
