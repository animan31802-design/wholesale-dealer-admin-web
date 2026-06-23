/**
 * AgentCashCollection.tsx
 *
 * Shows every field agent and delivery agent's current "cash in hand"
 * (money they have collected but not yet handed over to admin).
 *
 * Field agents accumulate cash from:
 *   - advancePaid collected at order creation
 *
 * Delivery agents accumulate cash from:
 *   - amountCollected at delivery  (minus the advancePaid that field agent already has)
 *
 * Admin can "collect" cash from an agent: enters the amount received,
 * saves it → the agent's cash-in-hand drops immediately (real-time in
 * both the web admin and the agent's mobile app via onSnapshot).
 *
 * Firestore:
 *   agentCashLedger/{agentId}          — summary doc  { cashInHand: number }
 *   agentCashLedger/{agentId}/entries  — sub-collection of individual entries
 */

import { useEffect, useState, useMemo } from "react";
import {
  collection, doc, onSnapshot, query, orderBy,
  runTransaction, addDoc, getDocs, where, getDoc,
} from "firebase/firestore";
import { db } from "../firebase/config";
import { AppUser, Order } from "../types";
import { useModalKeyboard } from "../hooks/useModalKeyboard";
import { useAuthStore } from "../store/authStore";

// ── Types ─────────────────────────────────────────────────────────

interface AgentCashState {
  agent: AppUser;
  cashInHand: number;          // current unsubmitted amount
  lastCollectedAt?: string;    // last time admin collected from this agent
  pendingOrders: number;       // number of orders contributing to this cash
}

interface CashEntry {
  id?: string;
  agentId: string;
  agentName: string;
  type: "order_advance" | "order_delivery" | "admin_collection" | string; // open string so unknown future types show a fallback label instead of crashing
  orderId?: string;
  orderNo?: string;  // human-readable yyMMddHHmmss3rand — written by both field agent and delivery
  amount: number;              // always positive
  direction: "in" | "out";    // in = cash with agent, out = handed to admin
  note?: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

// ── Helper ────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Sub-component: Collection Modal ──────────────────────────────

function CollectModal({
  agent,
  cashInHand,
  onClose,
  onCollected,
}: {
  agent: AppUser;
  cashInHand: number;
  onClose: () => void;
  onCollected: () => void;
}) {
  const { user } = useAuthStore();
  const [amount, setAmount] = useState(fmt(cashInHand).replace(/,/g, ""));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleCollect = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return;
    if (amt > cashInHand + 0.01) {
      alert("Amount cannot exceed the cash in hand.");
      return;
    }
    setSaving(true);
    try {
      await runTransaction(db, async (t) => {
        const summaryRef = doc(db, "agentCashLedger", agent.uid);
        const summarySnap = await t.get(summaryRef);
        const currentCash = summarySnap.exists()
          ? (summarySnap.data().cashInHand ?? 0)
          : 0;

        const newCash = Math.max(0, Math.round((currentCash - amt) * 100) / 100);

        t.set(summaryRef, {
          agentId: agent.uid,
          agentName: agent.name,
          agentRole: agent.role,
          cashInHand: newCash,
          lastCollectedAt: new Date().toISOString(),
        }, { merge: true });

        // Write the entry doc within the transaction
        const entryRef = doc(collection(db, "agentCashLedger", agent.uid, "entries"));
        t.set(entryRef, {
          agentId: agent.uid,
          agentName: agent.name,
          type: "admin_collection",
          amount: amt,
          direction: "out",
          note: note.trim() || `Cash collected by admin`,
          createdBy: user!.uid,
          createdByName: user!.name,
          createdAt: new Date().toISOString(),
        } satisfies Omit<CashEntry, "id">);
      });

      onCollected();
      onClose();
    } catch (err: any) {
      alert(err.message || "Failed to record collection.");
    } finally {
      setSaving(false);
    }
  };

  const remaining = Math.max(0, cashInHand - (parseFloat(amount) || 0));
  useModalKeyboard({ onClose, onConfirm: handleCollect, disabled: saving || !amount.trim() });
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">Collect Cash</h3>
            <p className="text-sm text-gray-500">{agent.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="p-6 space-y-4">
          {/* Cash in hand banner */}
          <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 flex justify-between items-center">
            <span className="text-sm text-orange-700 font-medium">Cash in hand</span>
            <span className="text-xl font-bold text-orange-600">₹{fmt(cashInHand)}</span>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Amount Received from Agent (₹) *
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-orange-300"
              autoFocus
            />
            {/* Quick chip: full amount */}
            <button
              onClick={() => setAmount(cashInHand.toFixed(2))}
              className="mt-2 text-xs bg-orange-100 text-orange-700 px-3 py-1 rounded-full hover:bg-orange-200"
            >
              Full amount ₹{fmt(cashInHand)}
            </button>
          </div>

          {parseFloat(amount) > 0 && (
            <div className={`rounded-xl px-4 py-3 text-sm ${remaining > 0 ? "bg-yellow-50 border border-yellow-200" : "bg-green-50 border border-green-200"}`}>
              {remaining > 0 ? (
                <span className="text-yellow-700">
                  ₹{fmt(remaining)} will remain with the agent after collection.
                </span>
              ) : (
                <span className="text-green-700 font-semibold">
                  ✅ Fully collected — agent's balance will be ₹0.00
                </span>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. End of day collection"
              className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={onClose} className="flex-1 border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
              Cancel
            </button>
            <button
              onClick={handleCollect}
              disabled={saving || !amount || parseFloat(amount) <= 0}
              className="flex-1 bg-orange-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-orange-600 disabled:opacity-50"
            >
              {saving ? "Saving..." : "✅ Collect Cash"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-component: Agent History Modal ────────────────────────────

function HistoryModal({ agent, onClose }: { agent: AppUser; onClose: () => void }) {
  const [entries, setEntries] = useState<CashEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getDocs(
      query(
        collection(db, "agentCashLedger", agent.uid, "entries"),
        orderBy("createdAt", "desc")
      )
    ).then((snap) => {
      setEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() } as CashEntry)));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [agent.uid]);

  // FIX: formalised as a constant with an explicit fallback so unknown type strings
  // from future mobile versions show a readable label rather than a raw key.
  const TYPE_LABELS: Record<string, string> = {
    order_advance:    "💼 Advance Collected",
    order_delivery:   "🚚 Delivery Collection",
    admin_collection: "✅ Handed to Admin",
  };
  const typeLabel = (type: string) => TYPE_LABELS[type] ?? `📋 ${type.replace(/_/g, " ")}`;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-gray-800">{agent.name}</h3>
            <p className="text-sm text-gray-500">Cash transaction history</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="text-center py-12 text-gray-400">Loading...</div>
          ) : entries.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <p className="text-3xl mb-2">📭</p>
              <p>No transactions yet</p>
            </div>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm min-w-[480px]">
              <thead className="bg-gray-50 text-gray-400 text-xs uppercase tracking-wide sticky top-0">
                <tr>
                  <th className="px-5 py-3 text-left">Date</th>
                  <th className="px-5 py-3 text-left">Type</th>
                  <th className="px-5 py-3 text-left">Note</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="px-5 py-3 text-gray-500 text-xs whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleDateString("en-IN", {
                        day: "2-digit", month: "short", year: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                        e.direction === "in"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-green-100 text-green-700"
                      }`}>
                        {typeLabel(e.type)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-xs max-w-[160px]">
                      <p>{e.note || "—"}</p>
                      {(e as any).orderNo
                        ? <p className="text-gray-400 font-mono">#{(e as any).orderNo}</p>
                        : e.orderId
                          ? <p className="text-gray-400 font-mono">#{e.orderId.slice(0, 8).toUpperCase()}</p>
                          : null
                      }
                    </td>
                    <td className={`px-5 py-3 text-right font-semibold ${
                      e.direction === "in" ? "text-blue-600" : "text-green-600"
                    }`}>
                      {e.direction === "in" ? "+" : "−"}₹{fmt(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button onClick={onClose} className="w-full border border-gray-300 text-gray-600 py-2.5 rounded-xl text-sm hover:bg-gray-50">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export default function AgentCashCollection() {
  const { user } = useAuthStore();
  const [agents, setAgents] = useState<AppUser[]>([]);
  const [cashSummaries, setCashSummaries] = useState<Record<string, number | null>>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [collectAgent, setCollectAgent] = useState<AgentCashState | null>(null);
  const [historyAgent, setHistoryAgent] = useState<AppUser | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ── Load agents (field_agent + delivery) ─────────────────────
  useEffect(() => {
    getDocs(query(collection(db, "users"), orderBy("name"))).then((snap) => {
      const all = snap.docs.map((d) => d.data() as AppUser);
      setAgents(all.filter((u) => u.role === "field_agent" || u.role === "delivery"));
    });
  }, []);

  // ── Real-time cash summaries from agentCashLedger ────────────
  // cashSummaries stores null = "no ledger doc exists yet" (fall back to order-derived)
  //                      number = explicit balance from the ledger doc (including 0)
  useEffect(() => {
    if (agents.length === 0) return;
    const unsubs: (() => void)[] = [];

    agents.forEach((agent) => {
      const summaryRef = doc(db, "agentCashLedger", agent.uid);
      const unsub = onSnapshot(summaryRef, (snap) => {
        // Only store a value when the doc actually exists.
        // If the doc doesn't exist yet, keep null so we fall back to order-derived cash.
        const cash = snap.exists() ? (snap.data().cashInHand ?? 0) : null;
        setCashSummaries((prev) => ({ ...prev, [agent.uid]: cash as number }));
      });
      unsubs.push(unsub);
    });

    return () => unsubs.forEach((u) => u());
  }, [agents]);

  // ── Load today's orders to calculate per-agent pending cash ──
  useEffect(() => {
    // Listen to all delivered + pending orders to compute cash in hand
    const unsub = onSnapshot(
      query(collection(db, "orders"), orderBy("createdAt", "desc")),
      (snap) => {
        setOrders(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Order)));
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // ── Compute cash each agent holds from orders ─────────────────
  // This is the "ground truth" derived from orders.
  // We also sync it to agentCashLedger when cash changes.
  const agentCashFromOrders = useMemo(() => {
    const map: Record<string, number> = {};

    orders.forEach((o) => {
      if (o.status === "cancelled") return;

      const advance   = (o as any).advancePaid ?? 0;
      const collected = o.amountCollected ?? 0;
      // Exclude amounts an admin recorded directly (e.g. via the order drawer's
      // "Record Payment" or a Customers-page settlement) — that money was never
      // physically handed to the delivery agent, so it shouldn't count toward
      // their cash-in-hand.
      const adminPortion = (o as any).adminCollected ?? 0;
      const deliveryCollected = Math.max(0, collected - adminPortion);

      // Field agent gets the advance paid at order creation
      if (advance > 0 && o.agentId) {
        map[o.agentId] = (map[o.agentId] ?? 0) + advance;
      }

      // Delivery agent gets the amount they physically collected at the door
      // (advance is separate cash already with the field agent; admin-recorded
      // settlements are excluded since the delivery agent never held that cash)
      if (o.status === "delivered" && o.deliveryPersonId && deliveryCollected > 0) {
        map[o.deliveryPersonId] = (map[o.deliveryPersonId] ?? 0) + deliveryCollected;
      }
    });

    return map;
  }, [orders]);

  // ── Build AgentCashState rows ─────────────────────────────────
  const agentRows = useMemo((): AgentCashState[] => {
    return agents.map((agent) => {
      // Use Firestore agentCashLedger as the source of truth for cash in hand
      // (it gets reduced as admin collects). Fall back to order-derived if no ledger.
      const ledgerCash = cashSummaries[agent.uid] ?? null;
      const cashInHand = ledgerCash !== null ? ledgerCash : (agentCashFromOrders[agent.uid] ?? 0);

      const pendingOrders = orders.filter((o) => {
        if (o.status === "cancelled") return false;
        const advance = (o as any).advancePaid ?? 0;
        if (agent.role === "field_agent") return advance > 0 && o.agentId === agent.uid;
        if (agent.role === "delivery") {
          const collected = o.amountCollected ?? 0;
          const adminPortion = (o as any).adminCollected ?? 0;
          const deliveryCollected = Math.max(0, collected - adminPortion);
          return o.status === "delivered" && o.deliveryPersonId === agent.uid && deliveryCollected > advance;
        }
        return false;
      }).length;

      return { agent, cashInHand, pendingOrders };
    });
  }, [agents, cashSummaries, agentCashFromOrders, orders]);

  const fieldAgentRows = agentRows.filter((r) => r.agent.role === "field_agent");
  const deliveryRows = agentRows.filter((r) => r.agent.role === "delivery");

  const totalInField = fieldAgentRows.reduce((s, r) => s + r.cashInHand, 0);
  const totalInDelivery = deliveryRows.reduce((s, r) => s + r.cashInHand, 0);
  const grandTotal = totalInField + totalInDelivery;

  const AgentCard = ({ row }: { row: AgentCashState }) => {
    const hasBalance = row.cashInHand > 0.005;
    return (
      <div className={`bg-white rounded-2xl shadow-sm border p-5 transition-all ${
        hasBalance ? "border-orange-200" : "border-gray-100"
      }`}>
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-gray-800 truncate">{row.agent.name}</p>
            <p className="text-xs text-gray-400 mt-0.5">{row.agent.phone || row.agent.email}</p>
            <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${
              row.agent.role === "field_agent"
                ? "bg-blue-100 text-blue-700"
                : "bg-green-100 text-green-700"
            }`}>
              {row.agent.role === "field_agent" ? "💼 Field Agent" : "🚚 Delivery Agent"}
            </span>
          </div>
          <div className="text-right flex-shrink-0 ml-4">
            <p className="text-xs text-gray-400 mb-0.5">Cash in Hand</p>
            <p className={`text-2xl font-bold ${hasBalance ? "text-orange-600" : "text-gray-400"}`}>
              ₹{fmt(row.cashInHand)}
            </p>
            {row.pendingOrders > 0 && (
              <p className="text-xs text-gray-400 mt-0.5">
                from {row.pendingOrders} order{row.pendingOrders !== 1 ? "s" : ""}
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setHistoryAgent(row.agent)}
            className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-xl text-xs font-medium hover:bg-gray-50"
          >
            📋 History
          </button>
          {hasBalance && (
            <button
              onClick={() => setCollectAgent(row)}
              className="flex-[2] bg-orange-500 text-white py-2 rounded-xl text-xs font-semibold hover:bg-orange-600"
            >
              ✅ Collect ₹{fmt(row.cashInHand)}
            </button>
          )}
          {!hasBalance && (
            <div className="flex-[2] bg-green-50 border border-green-200 rounded-xl py-2 text-center text-xs font-semibold text-green-600">
              ✓ All Clear
            </div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-3 text-gray-400">
        <span className="animate-spin text-xl">⏳</span> Loading...
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Agent Cash Collection</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Track cash held by each agent · Collect and clear balances at end of day
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-green-50 px-3 py-1.5 rounded-full">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
          Live
        </div>
      </div>

      {/* Summary banner */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {[
          { label: "Total in Field Agents", value: totalInField, icon: "💼", color: "blue" },
          { label: "Total in Delivery Agents", value: totalInDelivery, icon: "🚚", color: "green" },
          { label: "Grand Total Outstanding", value: grandTotal, icon: "💰", color: "orange" },
        ].map((stat) => (
          <div key={stat.label} className={`rounded-2xl p-5 ${
            stat.color === "blue" ? "bg-blue-50 border border-blue-100" :
            stat.color === "green" ? "bg-green-50 border border-green-100" :
            "bg-orange-50 border border-orange-100"
          }`}>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{stat.label}</p>
            <div className="flex items-center gap-2">
              <span className="text-2xl">{stat.icon}</span>
              <span className={`text-2xl font-bold ${
                stat.color === "blue" ? "text-blue-600" :
                stat.color === "green" ? "text-green-600" :
                "text-orange-600"
              }`}>₹{fmt(stat.value)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* How it works */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl px-5 py-4 mb-6">
        <p className="text-xs font-semibold text-blue-700 mb-2">ℹ️ How cash tracking works</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-blue-600">
          <div>💼 <strong>Field Agent cash</strong> = Advance amounts collected at order creation</div>
          <div>🚚 <strong>Delivery Agent cash</strong> = Full amount collected at the door (advance is separate with field agent)</div>
          <div>✅ <strong>Collecting</strong>: Agent hands over cash → Admin enters amount → Balance reduces instantly</div>
          <div>📋 <strong>History</strong>: Full log of every entry and collection for each agent</div>
        </div>
      </div>

      {/* Field Agents */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            💼 Field Agents ({fieldAgentRows.length})
          </h3>
          <span className="text-sm font-bold text-blue-600">₹{fmt(totalInField)} total</span>
        </div>
        {fieldAgentRows.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm bg-white rounded-2xl border border-gray-100">
            No field agents yet
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {fieldAgentRows.map((row) => (
              <AgentCard key={row.agent.uid} row={row} />
            ))}
          </div>
        )}
      </div>

      {/* Delivery Agents */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            🚚 Delivery Agents ({deliveryRows.length})
          </h3>
          <span className="text-sm font-bold text-green-600">₹{fmt(totalInDelivery)} total</span>
        </div>
        {deliveryRows.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm bg-white rounded-2xl border border-gray-100">
            No delivery agents yet
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {deliveryRows.map((row) => (
              <AgentCard key={row.agent.uid} row={row} />
            ))}
          </div>
        )}
      </div>

      {/* Collect Modal */}
      {collectAgent && (
        <CollectModal
          agent={collectAgent.agent}
          cashInHand={collectAgent.cashInHand}
          onClose={() => setCollectAgent(null)}
          onCollected={() => setRefreshKey((k) => k + 1)}
        />
      )}

      {/* History Modal */}
      {historyAgent && (
        <HistoryModal
          agent={historyAgent}
          onClose={() => setHistoryAgent(null)}
        />
      )}
    </div>
  );
}