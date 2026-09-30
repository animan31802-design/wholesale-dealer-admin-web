import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../store/authStore";
import { usePendingRequest, useSubscriptionInfo, useSubscriptionStore } from "../store/subscriptionStore";
import {
  computeRenewal,
  formatDate,
  formatDateTime,
  formatRupees,
  isValidUtr,
  normalizeUtr,
  sortedPublishedPlans,
  tenantPaymentNote,
  whatsappLink,
  type SubscriptionInfo,
} from "../lib/subscription";
import { cancelPaymentRequest, DuplicateUtrError, submitPaymentRequest } from "../lib/subscriptionApi";
import { buildUpiUri, generateUpiQrDataUrl } from "../utils/upiQr";
import { uploadToCloudinary } from "../utils/cloudinary";
import { printSubscriptionReceipt } from "../utils/subscriptionReceipt";
import { Badge, Button, Card, inputClass } from "../components/subscription/ui";
import { paymentAlertText, requestStatusBadge, statusBadge } from "../components/subscription/status";
import type { PaymentRequest, PlatformPublicConfig } from "../types/subscription";

// Admin-only page (see App.tsx): plan, payment by UPI QR, history, receipts.
export default function Subscription() {
  const tenant = useSubscriptionStore((s) => s.tenant);
  const config = useSubscriptionStore((s) => s.config);
  const requests = useSubscriptionStore((s) => s.requests);
  const info = useSubscriptionInfo();
  const pending = usePendingRequest();

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">💳 Subscription</h1>
        <p className="text-sm text-gray-500">Your plan, payments and receipts</p>
      </div>

      <div className="space-y-6">
        <StatusCard info={info} />
        {!tenant || info.status === "not_enforced" ? null : pending ? (
          <PendingCard request={pending} config={config} />
        ) : (
          <PayCard info={info} />
        )}
        {requests.length > 0 && <HistoryCard requests={requests} config={config} />}
      </div>
    </div>
  );
}

function StatusCard({ info }: { info: SubscriptionInfo }) {
  let message: string;
  switch (info.status) {
    case "pending":
      message = "Waiting for activation. Choose a plan and pay below — the app unlocks as soon as your payment is verified.";
      break;
    case "active":
      message = `Your subscription is active until ${formatDate(info.endsAt)}.`;
      break;
    case "expiring":
      message = `Your subscription ends on ${formatDate(info.endsAt)} — ${info.daysLeft} day${info.daysLeft === 1 ? "" : "s"} left. Renew early; no days are lost.`;
      break;
    case "grace":
      message = `Your subscription ended on ${formatDate(info.endsAt)}. The app becomes read-only on ${formatDate(info.accessUntil)} unless you renew.`;
      break;
    case "expired":
      message = `Your subscription ended on ${formatDate(info.endsAt)}. The app is read-only: everyone can view and export data, but nothing can be added or changed (web and mobile) until you renew.`;
      break;
    default:
      message = "Subscriptions have not started yet. Nothing to do for now.";
  }
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-gray-800">Current status</h2>
        {statusBadge(info)}
      </div>
      <p className="mt-3 text-sm text-gray-600">{message}</p>
      {info.endsAt !== null && (
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-gray-500">Paid until</dt>
            <dd className="font-medium text-gray-900">{formatDate(info.endsAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Read-only from</dt>
            <dd className="font-medium text-gray-900">{formatDate(info.accessUntil)}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

function PendingCard({ request, config }: { request: PaymentRequest; config: PlatformPublicConfig }) {
  const user = useAuthStore((s) => s.user);
  const [busy, setBusy] = useState(false);

  async function handleCancel() {
    if (!user) return;
    if (!window.confirm("Cancel this payment request? Only do this if you chose the wrong plan or haven't actually paid.")) return;
    setBusy(true);
    try {
      await cancelPaymentRequest(request.id, user.uid);
    } catch (err) {
      console.error(err);
      window.alert("Could not cancel. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 border-amber-200">
      <p className="text-sm font-semibold text-gray-900">⏳ Payment submitted — waiting for verification</p>
      <p className="mt-1 text-sm text-gray-600">
        {request.planName} · {formatRupees(request.amount)} · submitted {formatDateTime(request.submittedAt)} by {request.submittedByName}
        {request.utr ? ` · UTR ${request.utr}` : ""}
      </p>
      <p className="mt-2 text-xs text-gray-500">Your new dates appear here as soon as the payment is verified.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {config.whatsappNumber && (
          <a href={whatsappLink(config.whatsappNumber, paymentAlertText(request))} target="_blank" rel="noreferrer">
            <Button variant="secondary" size="sm">💬 Notify on WhatsApp</Button>
          </a>
        )}
        <Button variant="ghost" size="sm" onClick={handleCancel} disabled={busy}>
          Cancel request
        </Button>
      </div>
    </Card>
  );
}

function PayCard({ info }: { info: SubscriptionInfo }) {
  const user = useAuthStore((s) => s.user);
  const tenant = useSubscriptionStore((s) => s.tenant);
  const config = useSubscriptionStore((s) => s.config);
  const pricing = useSubscriptionStore((s) => s.pricing);
  const now = useSubscriptionStore((s) => s.now);
  const plans = useMemo(() => sortedPublishedPlans(pricing), [pricing]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [utr, setUtr] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<PaymentRequest | null>(null);

  const plan = plans.find((p) => p.id === planId) ?? null;
  const highestMonthlyRate = plans.length ? Math.max(...plans.map((p) => p.price / p.months)) : 0;

  const upiOpts = useMemo(
    () =>
      plan && tenant
        ? { vpa: config.upiVpa, payeeName: config.payeeName || "Subscription", amount: plan.price, note: tenantPaymentNote(tenant.id, plan.months) }
        : null,
    [plan, tenant, config.upiVpa, config.payeeName]
  );

  useEffect(() => {
    setQr(null);
    if (!upiOpts || !upiOpts.vpa) return;
    let cancelled = false;
    generateUpiQrDataUrl(upiOpts).then((url) => !cancelled && setQr(url)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [upiOpts]);

  if (!tenant || !user) return null;

  if (submitted) {
    return (
      <Card className="p-5 border-green-200">
        <p className="text-sm font-semibold text-gray-900">✅ Payment submitted</p>
        <p className="mt-1 text-sm text-gray-600">
          It will be verified and your subscription updated. Tap below to send the details on WhatsApp so it's checked faster.
        </p>
        {config.whatsappNumber && (
          <a className="mt-4 inline-block" href={whatsappLink(config.whatsappNumber, paymentAlertText(submitted))} target="_blank" rel="noreferrer">
            <Button>💬 Notify on WhatsApp</Button>
          </a>
        )}
      </Card>
    );
  }

  if (plans.length === 0) {
    return (
      <Card className="p-5">
        <p className="text-sm font-medium text-gray-800">Plans aren't available yet</p>
        <p className="mt-1 text-sm text-gray-500">
          Please contact us{config.whatsappNumber ? ` on WhatsApp (+${config.whatsappNumber.replace(/\D/g, "")})` : ""} to get your plan set up.
        </p>
      </Card>
    );
  }

  const renewal = plan ? computeRenewal(info.endsAt, now, plan.months) : null;

  async function handleSubmit() {
    if (!plan || !tenant || !user) return;
    setError(null);
    const cleanUtr = utr.trim() ? normalizeUtr(utr) : null;
    if (cleanUtr && !isValidUtr(cleanUtr)) {
      setError("The UTR / reference number should be 6–30 letters or digits (UPI UTRs are 12 digits). Leave it empty if you don't have it.");
      return;
    }
    setSubmitting(true);
    try {
      const screenshotUrl = file ? await uploadToCloudinary(file) : null;
      const req = await submitPaymentRequest({
        tenant,
        planId: plan.id,
        planName: plan.name,
        months: plan.months,
        amount: plan.price,
        utr: cleanUtr,
        screenshotUrl,
        uid: user.uid,
        userName: user.name || user.email,
      });
      setSubmitted(req);
    } catch (err) {
      console.error(err);
      setError(err instanceof DuplicateUtrError ? err.message : "Could not submit. If the price just changed, refresh the page and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-gray-800">{info.status === "pending" ? "Choose a plan" : "Renew or extend"}</h2>
      <p className="mt-1 text-sm text-gray-500">Any plan you buy is added after your current end date, so renewing early never loses days.</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((p) => {
          const perMonth = p.price / p.months;
          const saving = highestMonthlyRate > 0 && p.months > 1 ? Math.round((1 - perMonth / highestMonthlyRate) * 100) : 0;
          const selected = p.id === planId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPlanId(p.id);
                setError(null);
              }}
              className={`rounded-xl border p-4 text-left transition-all ${
                selected ? "border-orange-500 bg-orange-50 ring-2 ring-orange-300" : "border-gray-200 bg-white hover:border-orange-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-gray-900">{p.name}</span>
                {saving > 0 && <Badge tone="green">Save {saving}%</Badge>}
              </div>
              <p className="mt-2 text-2xl font-bold text-gray-900">{formatRupees(p.price)}</p>
              <p className="text-xs text-gray-500">
                {p.months} month{p.months === 1 ? "" : "s"} · {formatRupees(Math.round(perMonth))}/month
              </p>
            </button>
          );
        })}
      </div>

      {plan && upiOpts && (
        <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 p-4 sm:p-5">
          {renewal && (
            <p className="mb-4 text-sm text-gray-700">
              {info.endsAt !== null && info.endsAt > now ? (
                <>
                  Current end date <span className="font-semibold">{formatDate(info.endsAt)}</span> → after this payment{" "}
                  <span className="font-semibold">{formatDate(renewal.end)}</span>
                </>
              ) : (
                <>
                  After verification, active until about <span className="font-semibold">{formatDate(renewal.end)}</span>
                  <span className="text-gray-500"> (counted from the day it's verified)</span>
                </>
              )}
            </p>
          )}

          {!config.upiVpa ? (
            <p className="text-sm text-red-700">Payment details haven't been set up yet. Please contact us.</p>
          ) : (
            <div className="flex flex-col gap-5 md:flex-row">
              <div className="flex shrink-0 flex-col items-center">
                {qr ? (
                  <img src={qr} alt="UPI QR code" className="h-52 w-52 rounded-lg border border-gray-200 bg-white" />
                ) : (
                  <div className="flex h-52 w-52 items-center justify-center rounded-lg border border-gray-200 bg-white text-xs text-gray-400">Generating QR…</div>
                )}
                <a href={buildUpiUri(upiOpts)} className="mt-3 md:hidden">
                  <Button variant="secondary" size="sm">📱 Open UPI app</Button>
                </a>
              </div>

              <div className="min-w-0 flex-1 space-y-3 text-sm">
                <div>
                  <p className="text-xs text-gray-500">Amount (fixed for this plan)</p>
                  <p className="text-xl font-bold text-gray-900">{formatRupees(plan.price)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Pay to UPI ID</p>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium text-gray-900">{config.upiVpa}</span>
                    <button
                      type="button"
                      title="Copy UPI ID"
                      className="text-xs text-orange-600 hover:underline"
                      onClick={() => navigator.clipboard?.writeText(config.upiVpa).catch(() => undefined)}
                    >
                      Copy
                    </button>
                  </div>
                  {config.payeeName && <p className="text-xs text-gray-500">{config.payeeName}</p>}
                </div>
                <ol className="list-decimal space-y-1 pl-4 text-gray-600">
                  <li>Scan the QR with any UPI app (GPay, PhonePe, Paytm…) and pay.</li>
                  <li>Wait until the app shows the payment as successful.</li>
                  <li>
                    Come back here and tap <span className="font-medium">I've paid</span>.
                  </li>
                </ol>

                <div className="grid gap-3 pt-1 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600">UTR / reference no. (optional)</span>
                    <input className={inputClass} value={utr} onChange={(e) => setUtr(e.target.value)} placeholder="e.g. 427318905562" />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-gray-600">Payment screenshot (optional)</span>
                    <span className="flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 bg-white px-3 text-gray-500 hover:border-orange-400">
                      <span className="truncate">{file ? file.name : "📎 Choose image"}</span>
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    </span>
                  </label>
                </div>
                <details className="text-xs text-gray-500">
                  <summary className="cursor-pointer">Where do I find the UTR?</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    <li>Google Pay: "UPI transaction ID"</li>
                    <li>PhonePe: "UTR" (not the ID starting with T)</li>
                    <li>Paytm: "UPI Ref No."</li>
                    <li>BHIM / bank apps: "UTR", "RRN" or "Ref No."</li>
                  </ul>
                </details>

                {error && <p className="text-sm text-red-700">{error}</p>}
                <Button onClick={handleSubmit} disabled={submitting} className="w-full sm:w-auto">
                  {submitting ? "Submitting…" : "I've paid"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function HistoryCard({ requests, config }: { requests: PaymentRequest[]; config: PlatformPublicConfig }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-gray-100 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-800">Payment history</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-5 py-2.5 font-medium">Submitted</th>
              <th className="px-3 py-2.5 font-medium">Plan</th>
              <th className="px-3 py-2.5 font-medium">Amount</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-5 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {requests.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-5 py-3 text-gray-700">{formatDateTime(r.submittedAt)}</td>
                <td className="px-3 py-3 text-gray-700">
                  {r.planName}
                  {r.status === "approved" && (
                    <p className="text-xs text-gray-500">
                      {formatDate(r.periodStart)} – {formatDate(r.periodEnd)}
                    </p>
                  )}
                </td>
                <td className="px-3 py-3 font-medium text-gray-900">{formatRupees(r.amount)}</td>
                <td className="px-3 py-3">
                  {requestStatusBadge(r.status)}
                  {r.status === "rejected" && r.rejectReason && <p className="mt-1 max-w-[220px] text-xs text-red-700">{r.rejectReason}</p>}
                </td>
                <td className="px-5 py-3 text-right">
                  {r.status === "approved" && (
                    <Button variant="ghost" size="sm" onClick={() => printSubscriptionReceipt(r, config)}>
                      ⬇ Receipt
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
