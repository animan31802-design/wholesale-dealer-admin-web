import { create } from "zustand";
import type { AppUser } from "../types";

// Platform admin = a Firebase Auth account that has NO /users doc but
// does have a /platformAdmins/{uid} doc. It only ever sees the platform
// screen (/platform) — never the business app.
export interface PlatformAdminIdentity {
  uid: string;
  email: string;
}

interface AuthState {
  user: AppUser | null;
  platformAdmin: PlatformAdminIdentity | null;
  loading: boolean;
  setUser: (user: AppUser | null) => void;
  setPlatformAdmin: (platformAdmin: PlatformAdminIdentity | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  platformAdmin: null,
  loading: true,
  setUser: (user) => set({ user }),
  setPlatformAdmin: (platformAdmin) => set({ platformAdmin }),
  setLoading: (loading) => set({ loading }),
   logout: () =>
    set({
      user: null,
      platformAdmin: null,
      loading: false,
    }),
}));
