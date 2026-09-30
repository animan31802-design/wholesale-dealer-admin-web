import { useMemo, useState } from "react";
import { Badge, Button, Card, EmptyBox, inputClass, Modal } from "../../components/subscription/ui";
import { requestStatusBadge, statusBadge } from "../../components/subscription/status";
import { approvePaymentRequest, rejectPaymentRequest } from "../../lib/subscriptionApi";
import {
  accessUntilFor,
  computeRenewal,
  formatDate,
  formatDateTime,
  formatRupees,
  fromDateInputValue,
  getSubscriptionInfo,
  toDateInputValue,
} from "../../lib/subscription";
import { printSubscriptionReceipt } from "../../utils/subscriptionReceipt";
import { usePlatformData } from "./usePlatformData";
import type { PaymentRequest } from "../../types/subscription";
import type { PlatformTab } from "./PlatformAdmin";

export function PlatformPayments({ onGoTo }: { onGoTo: (tab: PlatformTab) => void }) {
  const { requests, config, catalog } = usePlatformData();
  const [approving, setApproving] = useState<PaymentRequest | null>(null);
  const pending = useMemo(() => requests.filter((r) => r.status === "pending").sort((a, b) => a.submittedAt - b.submittedAt), [requests]);
  const decided = useMemo(() => requests.filter((r) => r.status !== "pending").slice(0, 60), [requests]);

  const setupMissing: string[] = [];
  if (!config.upiVpa) setupMissing.push("your UPI ID");
  if (!config.whatsappNumber) setupMissing.push("your WhatsApp number");
  if (!catalog.plans.some((p) => p.active && (catalog.defaultPrices[p.id] ?? 0) > 0)) setupMissing.push("at least one plan shown to tenants with a Default price");

  return (
    <div className="space-y-6">
      {setupMissing.length > 0 && (
        <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">⚠ Finish setup before tenants can pay: add {setupMissing.join(", ")}.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => onGoTo("settings")}>
              Settings
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onGoTo("pricing")}>
              Plans & pricing
            </Button>
          </div>
        </Card>
      )}

      <section>
        <h2 className="mb-3 text-base font-semibold text-gray-800">
          Waiting for verification {pending.length > 0 && <span className="text-gray-400">({pending.length})</span>}
        </h2>
        {pending.length === 0 ? (
          <EmptyBox title="Nothing to verify" description="New payment submissions show up here." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {pending.map((r) => (
              <PendingRequestCard key={r.id} request={r} onApprove={() => setApproving(r)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-gray-800">Recent decisions</h2>
        {decided.length === 0 ? (
          <p className="text-sm text-gray-400">None yet.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Tenant</th>
                  <th className="px-3 py-2.5 font-medium">Plan</th>
                  <th className="px-3 py-2.5 font-medium">Amount</th>
                  <th className="px-3 py-2.5 font-medium">UTR</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Decided</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {decided.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2.5 font-medium text-gray-800">{r.tenantName}</td>
                    <td className="px-3 py-2.5 text-gray-700">
                      {r.planName}
                      {r.status === "approved" && <p className="text-xs text-gray-500">until {formatDate(r.periodEnd)}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-800">{formatRupees(r.amount)}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-gray-600">{r.utr ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      {requestStatusBadge(r.status)}
                      {r.rejectReason && <p className="mt-1 max-w-[200px] text-xs text-gray-500">{r.rejectReason}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">{formatDateTime(r.decidedAt ?? r.cancelledAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      {r.status === "approved" && (
                        <Button variant="ghost" size="sm" onClick={() => printSubscriptionReceipt(r, config)}>
                          ⬇ {r.receiptNo}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {approving && <ApproveModal request={approving} onClose={() => setApproving(null)} />}
    </div>
  );
}

function PendingRequestCard({ request, onApprove }: { request: PaymentRequest; onApprove: () => void }) {
  const { tenants, config, actor, now, requests } = usePlatformData();
  const tenant = tenants.find((t) => t.id === request.tenantId);
  const info = getSubscriptionInfo(tenant, now, config.reminderDays);
  const [busy, setBusy] = useState(false);
  const possibleDuplicate = requests.some(
    (r) =>
      r.id !== request.id &&
      r.tenantId === request.tenantId &&
      r.status === "approved" &&
      Math.abs((r.decidedAt ?? 0) - request.submittedAt) < 3 * 24 * 60 * 60 * 1000
  );

  async function handleReject() {
    const reason = window.prompt(`Reject payment from ${request.tenantName}?\nThe admin sees this reason and can submit again.`, "");
    if (reason === null) return;
    if (!reason.trim()) {
      window.alert("A reason is required.");
      return;
    }
    setBusy(true);
    try {
      await rejectPaymentRequest(request, reason.trim(), actor);
    } catch (err) {
      console.error(err);
      window.alert(`Could not reject: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{request.tenantName}</p>
          <p className="text-xs text-gray-500">
            {request.submittedByName} · {formatDateTime(request.submittedAt)}
          </p>
        </div>
        {statusBadge(info)}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-3">
        <div>
          <p className="text-xs text-gray-500">Expected amount</p>
          <p className="text-lg font-bold text-gray-900">{formatRupees(request.amount)}</p>
          <p className="text-xs text-gray-500">{request.planName}</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">UTR / reference</p>
          <p className="break-all font-mono text-base font-semibold text-gray-900">{request.utr ?? "—"}</p>
          {!request.utr && <p className="text-xs text-gray-500">Match by tenant, amount and time</p>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>Current end: {formatDate(info.endsAt)}</span>
        {request.screenshotUrl && (
          <a href={request.screenshotUrl} target="_blank" rel="noreferrer" className="text-orange-600 hover:underline">
            🖼 Screenshot ↗
          </a>
        )}
      </div>
      {possibleDuplicate && <p className="mt-2 text-xs text-amber-700">A payment was approved for this tenant in the last few days — check it isn't a double submission.</p>}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={handleReject} disabled={busy}>
          ✕ Reject
        </Button>
        <Button size="sm" onClick={onApprove} disabled={busy}>
          ✓ Approve
        </Button>
      </div>
    </Card>
  );
}

function ApproveModal({ request, onClose }: { request: PaymentRequest; onClose: () => void }) {
  const { tenants, config, actor } = usePlatformData();
  const tenant = tenants.find((t) => t.id === request.tenantId);
  const currentEnd = typeof tenant?.subscriptionEndsAt === "number" ? tenant.subscriptionEndsAt : null;
  const renewal = useMemo(() => computeRenewal(currentEnd, Date.now(), request.months), [currentEnd, request.months]);
  const [endValue, setEndValue] = useState(toDateInputValue(renewal.end));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const chosenEnd = fromDateInputValue(endValue);
  const overridden = chosenEnd !== null && toDateInputValue(chosenEnd) !== toDateInputValue(renewal.end);

  async function handleApprove() {
    if (chosenEnd === null) return;
    if (overridden && !note.trim()) {
      window.alert("You changed the end date — add a short note saying why (it goes into the history).");
      return;
    }
    setBusy(true);
    try {
      await approvePaymentRequest(request, { endsAtOverride: overridden ? chosenEnd : null, note: note.trim(), graceDays: config.graceDays, actor });
      onClose();
    } catch (err) {
      console.error(err);
      window.alert(`Could not approve: ${(err as Error).message ?? err}`);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Approve payment — ${request.tenantName}`}
      subtitle={`${request.planName} · ${formatRupees(request.amount)}${request.utr ? ` · UTR ${request.utr}` : ""}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleApprove} disabled={busy || chosenEnd === null}>
            {busy ? "Approving…" : "Approve"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-gray-600">Only approve after you've found this payment in your bank / UPI app.</p>
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-3">
          <div>
            <dt className="text-xs text-gray-500">Current end date</dt>
            <dd className="font-medium text-gray-900">{formatDate(currentEnd)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">New period starts</dt>
            <dd className="font-medium text-gray-900">
              {formatDate(renewal.start)}
              <span className="block text-xs font-normal text-gray-500">
                {currentEnd !== null && currentEnd > Date.now() ? "after the current end date" : "today (was not active)"}
              </span>
            </dd>
          </div>
        </dl>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">
            New end date ({request.months} month{request.months === 1 ? "" : "s"} added)
          </span>
          <input type="date" className={inputClass} value={endValue} onChange={(e) => setEndValue(e.target.value)} />
          {chosenEnd !== null && (
            <span className="mt-1 block text-xs text-gray-500">
              Read-only after {formatDate(accessUntilFor(chosenEnd, config.graceDays))} ({config.graceDays}-day grace)
            </span>
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Note {overridden ? "(required — date changed)" : "(optional)"}</span>
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Paid ₹480 instead of ₹500 — accepted" />
        </label>
        {overridden && <Badge tone="amber">End date changed from the plan's default</Badge>}
      </div>
    </Modal>
  );
}
