import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, cx, EmptyBox, inputClass, Modal } from "../../components/subscription/ui";
import { requestStatusBadge, statusBadge } from "../../components/subscription/status";
import {
  changeEndDate,
  createTenant,
  savePlatformTenant,
  setEnforcement,
  subscribeTenantEvents,
  updateTenantProfile,
} from "../../lib/subscriptionApi";
import {
  accessUntilFor,
  DAY_MS,
  endOfDay,
  formatDate,
  formatDateTime,
  formatRupees,
  fromDateInputValue,
  getSubscriptionInfo,
  resolvePrice,
  toDateInputValue,
  whatsappLink,
  type SubscriptionStatus,
} from "../../lib/subscription";
import { usePlatformData } from "./usePlatformData";
import { DEFAULT_TENANT_ID, type SubscriptionEvent, type Tenant } from "../../types/subscription";

type Filter = "all" | "attention" | "not_started";
const ATTENTION: SubscriptionStatus[] = ["pending", "expiring", "grace", "expired"];

export function PlatformTenants() {
  const { tenants, tenantCfgs, catalog, config, requests, now } = usePlatformData();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tenants
      .map((t) => ({ tenant: t, info: getSubscriptionInfo(t, now, config.reminderDays) }))
      .filter(({ tenant, info }) => {
        if (filter === "attention" && !ATTENTION.includes(info.status)) return false;
        if (filter === "not_started" && info.status !== "not_enforced") return false;
        if (q && !`${tenant.name} ${tenant.ownerName ?? ""} ${tenant.phone ?? ""} ${tenant.id}`.toLowerCase().includes(q)) return false;
        return true;
      });
  }, [tenants, now, config.reminderDays, filter, search]);

  const categoryName = (id?: string | null) => catalog.categories.find((c) => c.id === id)?.name;
  const openTenant = tenants.find((t) => t.id === openId) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1 text-sm">
          {(
            [
              ["all", "All tenants"],
              ["attention", "Needs attention"],
              ["not_started", "Not started"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cx("rounded px-3 py-1.5", filter === key ? "bg-orange-500 text-white" : "text-gray-600 hover:bg-gray-100")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input className={cx(inputClass, "sm:w-64")} placeholder="Search name, owner, phone" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button onClick={() => setAdding(true)}>+ Add tenant</Button>
        </div>
      </div>

      {tenants.length === 0 ? (
        <EmptyBox
          title="No tenants yet"
          description={`Add your business as the first tenant with ID "${DEFAULT_TENANT_ID}" — every current user belongs to it.`}
        />
      ) : rows.length === 0 ? (
        <EmptyBox title="No tenants match" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Tenant</th>
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Paid until</th>
                <th className="px-3 py-2.5 font-medium">Days left</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map(({ tenant, info }) => {
                const hasPending = requests.some((r) => r.tenantId === tenant.id && r.status === "pending");
                return (
                  <tr key={tenant.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setOpenId(tenant.id)}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{tenant.name}</p>
                      <p className="text-xs text-gray-500">
                        {[tenant.ownerName, tenant.phone].filter(Boolean).join(" · ") || "—"} <span className="font-mono">({tenant.id})</span>
                      </p>
                    </td>
                    <td className="px-3 py-3 text-gray-700">{categoryName(tenantCfgs[tenant.id]?.categoryId) ?? <span className="text-gray-400">Default</span>}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {statusBadge(info)}
                        {hasPending && <Badge tone="amber">Payment to verify</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-gray-700">{formatDate(info.endsAt)}</td>
                    <td className="px-3 py-3 text-gray-700">
                      {info.status === "active" || info.status === "expiring" ? info.daysLeft : info.status === "grace" ? `${info.daysLeft} (grace)` : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-medium text-orange-600">Manage →</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {adding && <AddTenantModal onClose={() => setAdding(false)} suggestDefault={tenants.length === 0} />}
      {openTenant && <TenantDetailModal tenant={openTenant} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function AddTenantModal({ onClose, suggestDefault }: { onClose: () => void; suggestDefault: boolean }) {
  const [id, setId] = useState(suggestDefault ? DEFAULT_TENANT_ID : "");
  const [name, setName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    const cleanId = id.trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,40}$/.test(cleanId)) return window.alert("Tenant ID: 2–40 lowercase letters, digits, - or _.");
    if (!name.trim()) return window.alert("Enter the business name.");
    setBusy(true);
    try {
      await createTenant({ id: cleanId, name: name.trim(), ownerName: ownerName.trim(), phone: phone.replace(/\D/g, "") });
      onClose();
    } catch (err) {
      console.error(err);
      window.alert((err as Error).message ?? String(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add tenant"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-700">
          The app is single-business today: every existing user belongs to tenant <span className="font-mono font-semibold">{DEFAULT_TENANT_ID}</span>.
          Create that one for your business. New tenants start with subscriptions <b>not started</b> (never locked) until you set an end date.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Tenant ID (can't be changed later)</span>
          <input className={cx(inputClass, "font-mono")} value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Business name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. PTM Mill" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Owner name (optional)</span>
            <input className={inputClass} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Owner phone for WhatsApp (optional)</span>
            <input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="9876543210" />
          </label>
        </div>
      </div>
    </Modal>
  );
}

type DetailTab = "subscription" | "profile" | "history";

function TenantDetailModal({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const { config, now } = usePlatformData();
  const [tab, setTab] = useState<DetailTab>("subscription");
  const info = getSubscriptionInfo(tenant, now, config.reminderDays);

  return (
    <Modal
      wide
      title={tenant.name}
      subtitle={[tenant.ownerName, tenant.phone, `ID: ${tenant.id}`].filter(Boolean).join(" · ")}
      onClose={onClose}
      headerExtra={
        <div className="flex gap-1 px-5 py-2 text-sm">
          {(
            [
              ["subscription", "Subscription"],
              ["profile", "Profile, category & prices"],
              ["history", "History"],
            ] as [DetailTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cx("rounded-lg px-3 py-1.5", tab === key ? "bg-orange-50 font-medium text-orange-700" : "text-gray-600 hover:bg-gray-50")}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto self-center">{statusBadge(info)}</span>
        </div>
      }
    >
      {tab === "subscription" && <SubscriptionTab tenant={tenant} />}
      {tab === "profile" && <ProfileTab tenant={tenant} />}
      {tab === "history" && <HistoryTab tenant={tenant} />}
    </Modal>
  );
}

function SubscriptionTab({ tenant }: { tenant: Tenant }) {
  const { config, actor, now } = usePlatformData();
  const info = getSubscriptionInfo(tenant, now, config.reminderDays);
  const [mode, setMode] = useState<"set" | "shift">(info.endsAt === null ? "set" : "shift");
  const [dateValue, setDateValue] = useState(toDateInputValue(info.endsAt ?? endOfDay(now + 30 * DAY_MS)));
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const newEndsAt = useMemo(() => {
    if (mode === "set") return fromDateInputValue(dateValue);
    const n = Number(days);
    if (!days.trim() || !Number.isFinite(n) || n === 0 || info.endsAt === null) return null;
    return endOfDay(info.endsAt + Math.trunc(n) * DAY_MS);
  }, [mode, dateValue, days, info.endsAt]);
  const newAccessUntil = newEndsAt !== null ? accessUntilFor(newEndsAt, config.graceDays) : null;

  async function handleSave() {
    if (newEndsAt === null) return;
    if (!reason.trim()) return window.alert("Reason required — every date change is logged with its reason.");
    if (newAccessUntil !== null && newAccessUntil <= Date.now()) {
      if (!window.confirm(`With this date (plus the ${config.graceDays}-day grace) the app goes READ-ONLY immediately for everyone in this tenant. Continue?`)) return;
    } else if (info.endsAt !== null && newEndsAt < info.endsAt) {
      if (!window.confirm(`Shorten the subscription from ${formatDate(info.endsAt)} to ${formatDate(newEndsAt)}?`)) return;
    }
    setBusy(true);
    try {
      await changeEndDate(tenant, newEndsAt, reason.trim(), config.graceDays, actor);
      setReason("");
      setDays("");
    } catch (err) {
      console.error(err);
      window.alert(`Could not save: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleEnforcement(required: boolean) {
    const reasonText = window.prompt(
      required
        ? "Turn subscriptions back ON for this tenant (it follows its end date again). Reason?"
        : "Stop subscriptions for this tenant (it will never be locked; dates are kept). Reason?",
      ""
    );
    if (reasonText === null) return;
    if (!reasonText.trim()) return window.alert("Reason required.");
    setBusy(true);
    try {
      await setEnforcement(tenant, required, reasonText.trim(), actor);
    } catch (err) {
      console.error(err);
      window.alert(`Could not save: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  const reminderText = [
    `Hello ${tenant.ownerName || tenant.name},`,
    info.status === "expired"
      ? `Your subscription ended on ${formatDate(info.endsAt)} and the app is now read-only.`
      : info.endsAt
        ? `Your subscription ends on ${formatDate(info.endsAt)}.`
        : "Your subscription is waiting for activation.",
    "You can renew from the Subscription page in the app (admin login). Thank you!",
  ].join("\n");

  return (
    <div className="space-y-5 text-sm">
      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-gray-500">Subscriptions</dt>
          <dd className="font-medium text-gray-900">{tenant.subscriptionRequired ? "On" : "Not started"}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Paid until</dt>
          <dd className="font-medium text-gray-900">{formatDate(info.endsAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Read-only from</dt>
          <dd className="font-medium text-gray-900">{formatDate(info.accessUntil)}</dd>
        </div>
        <div>
          <dt className="text-xs text-gray-500">Added</dt>
          <dd className="font-medium text-gray-900">{formatDate(tenant.createdAt)}</dd>
        </div>
      </dl>

      {!tenant.subscriptionRequired && (
        <p className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-blue-700">
          Subscriptions haven't started for this tenant — the app works as before and is never locked. Setting an end date below turns them on.
        </p>
      )}

      <div className="rounded-xl border border-gray-200 p-4">
        <h3 className="font-semibold text-gray-900">{info.endsAt === null ? "Activate / set end date" : "Change end date"}</h3>
        <div className="mt-3 flex gap-1 text-xs">
          <button onClick={() => setMode("set")} className={cx("rounded-lg px-3 py-1.5", mode === "set" ? "bg-orange-500 text-white" : "bg-gray-100 text-gray-600")}>
            Set exact date
          </button>
          <button
            onClick={() => setMode("shift")}
            disabled={info.endsAt === null}
            className={cx("rounded-lg px-3 py-1.5 disabled:opacity-40", mode === "shift" ? "bg-orange-500 text-white" : "bg-gray-100 text-gray-600")}
          >
            Add / remove days
          </button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {mode === "set" ? (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">New end date</span>
              <input type="date" className={inputClass} value={dateValue} onChange={(e) => setDateValue(e.target.value)} />
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">Days (use minus to remove, e.g. -5)</span>
              <input type="number" className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} placeholder="e.g. 7" />
            </label>
          )}
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600">Reason (required)</span>
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Starting subscriptions" />
          </label>
        </div>
        {newEndsAt !== null && (
          <p className="mt-3 text-gray-600">
            {formatDate(info.endsAt)} → <span className="font-semibold text-gray-900">{formatDate(newEndsAt)}</span>
            <span className="text-gray-500"> · read-only after {formatDate(newAccessUntil)}</span>
          </p>
        )}
        <div className="mt-3 flex justify-end">
          <Button onClick={handleSave} disabled={busy || newEndsAt === null}>
            Save end date
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        {tenant.subscriptionRequired && tenant.phone ? (
          <a href={whatsappLink(tenant.phone, reminderText)} target="_blank" rel="noreferrer">
            <Button variant="secondary" size="sm">💬 Send WhatsApp reminder</Button>
          </a>
        ) : (
          <span />
        )}
        {tenant.subscriptionRequired ? (
          <Button variant="ghost" size="sm" onClick={() => handleEnforcement(false)} disabled={busy}>
            Stop subscriptions for this tenant
          </Button>
        ) : info.endsAt !== null ? (
          <Button variant="ghost" size="sm" onClick={() => handleEnforcement(true)} disabled={busy}>
            Turn subscriptions back on
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProfileTab({ tenant }: { tenant: Tenant }) {
  const { catalog, tenantCfgs } = usePlatformData();
  const cfg = tenantCfgs[tenant.id];
  const [name, setName] = useState(tenant.name);
  const [ownerName, setOwnerName] = useState(tenant.ownerName ?? "");
  const [phone, setPhone] = useState(tenant.phone ?? "");
  const [categoryId, setCategoryId] = useState<string>(cfg?.categoryId ?? "");
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(cfg?.priceOverrides ?? {}).map(([k, v]) => [k, String(v)]))
  );
  const [notes, setNotes] = useState(cfg?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const draftCfg = {
    tenantId: tenant.id,
    categoryId: categoryId || null,
    priceOverrides: Object.fromEntries(
      Object.entries(overrides)
        .filter(([, v]) => v.trim() !== "" && Number(v) > 0)
        .map(([k, v]) => [k, Number(v)])
    ),
  };

  async function handleSave() {
    if (!name.trim()) return window.alert("Business name is required.");
    setBusy(true);
    setSaved(false);
    try {
      await updateTenantProfile(tenant.id, { name: name.trim(), ownerName: ownerName.trim(), phone: phone.replace(/\D/g, "") });
      await savePlatformTenant(tenant.id, { categoryId: draftCfg.categoryId, priceOverrides: draftCfg.priceOverrides, notes }, catalog, tenantCfgs);
      setSaved(true);
    } catch (err) {
      console.error(err);
      window.alert(`Could not save: ${(err as Error).message ?? err}`);
    } finally {
      setBusy(false);
    }
  }

  const plans = [...catalog.plans].sort((a, b) => a.sort - b.sort);

  return (
    <div className="space-y-5 text-sm">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Business name</span>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Owner name</span>
          <input className={inputClass} value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600">Owner phone (WhatsApp)</span>
          <input className={inputClass} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
        </label>
      </div>

      <label className="block sm:w-72">
        <span className="mb-1 block text-xs font-medium text-gray-600">Category</span>
        <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Default (no category)</option>
          {catalog.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {plans.length === 0 ? (
        <p className="text-gray-500">No plans yet — add them under Plans & pricing.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full min-w-[520px]">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 font-medium">Price without custom</th>
                <th className="px-3 py-2.5 font-medium">Custom price for this tenant</th>
                <th className="px-4 py-2.5 font-medium">Tenant pays</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {plans.map((p) => {
                const base = resolvePrice(catalog, { ...draftCfg, priceOverrides: {} }, p.id);
                const final = resolvePrice(catalog, draftCfg, p.id);
                return (
                  <tr key={p.id} className={cx(!p.active && "opacity-50")}>
                    <td className="px-4 py-2.5 font-medium text-gray-800">
                      {p.name}
                      {!p.active && <span className="ml-1 text-xs text-gray-400">(hidden)</span>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{base ? `${formatRupees(base.price)} · ${base.source}` : "—"}</td>
                    <td className="px-3 py-2.5">
                      <input
                        type="number"
                        min={0}
                        className={cx(inputClass, "h-9 w-32")}
                        placeholder="—"
                        value={overrides[p.id] ?? ""}
                        onChange={(e) => setOverrides((o) => ({ ...o, [p.id]: e.target.value }))}
                      />
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-gray-900">
                      {p.active && final ? formatRupees(final.price) : <span className="font-normal text-gray-400">not offered</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-600">Private notes (only you see these)</span>
        <textarea className={cx(inputClass, "h-24 py-2")} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <div className="flex items-center justify-end gap-3">
        {saved && <span className="text-xs text-green-700">Saved — the tenant sees the new prices now.</span>}
        <Button onClick={handleSave} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function HistoryTab({ tenant }: { tenant: Tenant }) {
  const { requests } = usePlatformData();
  const [events, setEvents] = useState<SubscriptionEvent[]>([]);
  useEffect(() => subscribeTenantEvents(tenant.id, setEvents), [tenant.id]);
  const tenantRequests = requests.filter((r) => r.tenantId === tenant.id);

  const label: Record<SubscriptionEvent["type"], string> = {
    approved: "Payment approved",
    rejected: "Payment rejected",
    date_changed: "End date changed",
    enforcement_on: "Subscriptions turned on",
    enforcement_off: "Subscriptions stopped",
  };

  return (
    <div className="space-y-6 text-sm">
      <section>
        <h3 className="mb-2 font-semibold text-gray-900">Changes</h3>
        {events.length === 0 ? (
          <p className="text-gray-400">No changes yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {events.map((e) => (
              <li key={e.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-gray-800">{label[e.type]}</span>
                  <span className="text-xs text-gray-500">
                    {formatDateTime(e.at)} · {e.byName}
                  </span>
                </div>
                {(e.type === "approved" || e.type === "date_changed") && (
                  <p className="text-xs text-gray-600">
                    {formatDate(e.oldEndsAt)} → {formatDate(e.newEndsAt)}
                  </p>
                )}
                {e.reason && <p className="text-xs text-gray-500">{e.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 font-semibold text-gray-900">Payment requests</h3>
        {tenantRequests.length === 0 ? (
          <p className="text-gray-400">None yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
            {tenantRequests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <span className="text-gray-700">
                  {formatDateTime(r.submittedAt)} · {r.planName} · {formatRupees(r.amount)}
                  {r.utr ? ` · ${r.utr}` : ""}
                </span>
                {requestStatusBadge(r.status)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
