import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { Customer, OrderItemOverride } from "../types";

export type PaymentMode = "cash" | "upi" | "bank" | "credit";

// A full snapshot of an in-progress bill — everything needed to
// resume billing exactly where the agent left off.
export interface BillDraft {
  customer: Customer;
  cartQty: Record<string, number>;
  cartOverrides: Record<string, OrderItemOverride>;
  paidAmount: string;
  paymentMode: PaymentMode;
  notes: string;
  selectedRegion?: string;
  // Snapshot of product name/price/gst/taxInclusive at the moment this
  // draft was saved, used to diff against the live catalogue on resume
  // (only for items WITHOUT a per-bill override — an override always wins).
  productSnapshot: Record<string, { name: string; price: number; gst: string; taxInclusive?: boolean }>;
  // Denormalized total at save time, purely for the bubble hover preview —
  // recomputed for real (against live prices) the moment the bill is resumed.
  lastKnownTotal: number;
  updatedAt: number; // epoch ms — used for the staleness indicator + expiry
}

interface ExitHandlers {
  onDiscard: () => void;
  onSaveAndMinimize: () => void;
}

interface BillingDraftsState {
  drafts: Record<string, BillDraft>;
  // Which customer's bill is currently open (full-screen) in CreateOrderPage.
  // Not persisted — on a fresh load nothing is "open", everything is a bubble.
  activeCustomerId: string | null;
  // True while the currently open bill has items that haven't been minimized/saved yet.
  // Layout uses this to decide whether to intercept sidebar navigation.
  hasUnsavedActiveBill: boolean;
  exitHandlers: ExitHandlers | null;
  // Set by a bubble click to ask CreateOrderPage to swap to that customer's draft.
  resumeCustomerId: string | null;
  resumeToken: number;

  saveDraft: (customerId: string, draft: Omit<BillDraft, "updatedAt">) => void;
  removeDraft: (customerId: string) => void;
  setActiveCustomerId: (id: string | null) => void;
  setHasUnsavedActiveBill: (v: boolean) => void;
  registerExitHandlers: (h: ExitHandlers | null) => void;
  requestResume: (customerId: string) => void;
  clearResumeRequest: () => void;
  pruneExpired: (expiryHours: number) => void;
}

export const useBillingDraftsStore = create<BillingDraftsState>()(
  persist(
    (set, get) => ({
      drafts: {},
      activeCustomerId: null,
      hasUnsavedActiveBill: false,
      exitHandlers: null,
      resumeCustomerId: null,
      resumeToken: 0,

      saveDraft: (customerId, draft) =>
        set((state) => ({
          drafts: { ...state.drafts, [customerId]: { ...draft, updatedAt: Date.now() } },
        })),

      removeDraft: (customerId) =>
        set((state) => {
          const next = { ...state.drafts };
          delete next[customerId];
          return {
            drafts: next,
            activeCustomerId: state.activeCustomerId === customerId ? null : state.activeCustomerId,
          };
        }),

      setActiveCustomerId: (id) => set({ activeCustomerId: id }),
      setHasUnsavedActiveBill: (v) => set({ hasUnsavedActiveBill: v }),
      registerExitHandlers: (h) => set({ exitHandlers: h }),

      requestResume: (customerId) =>
        set((state) => ({ resumeCustomerId: customerId, resumeToken: state.resumeToken + 1 })),
      clearResumeRequest: () => set({ resumeCustomerId: null }),

      pruneExpired: (expiryHours) => {
        const cutoff = Date.now() - expiryHours * 60 * 60 * 1000;
        const state = get();
        const next: Record<string, BillDraft> = {};
        let changed = false;
        Object.entries(state.drafts).forEach(([id, d]) => {
          // Never prune the bill currently open on screen.
          if (d.updatedAt >= cutoff || id === state.activeCustomerId) {
            next[id] = d;
          } else {
            changed = true;
          }
        });
        if (changed) set({ drafts: next });
      },
    }),
    {
      name: "billing-drafts-storage",
      storage: createJSONStorage(() => localStorage),
      // Only the drafts themselves are worth persisting across a refresh —
      // "which one is open" and the exit-handler callbacks are transient.
      partialize: (state) => ({ drafts: state.drafts }),
    }
  )
);
