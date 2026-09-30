import { useEffect, useState } from 'react'
import { Button, Card, cx, inputClass } from '../../components/subscription/ui'
import { saveCatalog } from '../../lib/subscriptionApi'
import { formatRupees, newId } from '../../lib/subscription'
import { usePlatformData } from './usePlatformData'
import type { PlanCatalog } from '../../types/subscription'

// Plans (any number, any length), tenant categories (any number), and the
// price table: one price per plan for the default and for each
// category. A tenant's own custom price (Tenants → Profile, category & prices) beats
// both. Saving re-publishes every tenant's price list.
export function PlatformPricing() {
  const { catalog, tenants, tenantCfgs } = usePlatformData()
  const [draft, setDraft] = useState<PlanCatalog>(catalog)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  // Pick up changes saved elsewhere, unless there are unsaved edits here.
  useEffect(() => {
    if (!dirty) setDraft(catalog)
  }, [catalog, dirty])

  function update(fn: (c: PlanCatalog) => PlanCatalog) {
    setDraft((c) => fn(structuredClone(c)))
    setDirty(true)
  }

  const plans = [...draft.plans].sort((a, b) => a.sort - b.sort)

  function addPlan() {
    update((c) => {
      const sort = c.plans.reduce((m, p) => Math.max(m, p.sort), 0) + 1
      c.plans.push({ id: newId('plan'), name: 'New plan', months: 1, active: true, sort })
      return c
    })
  }

  function movePlan(id: string, dir: -1 | 1) {
    update((c) => {
      const ordered = [...c.plans].sort((a, b) => a.sort - b.sort)
      const i = ordered.findIndex((p) => p.id === id)
      const j = i + dir
      if (j < 0 || j >= ordered.length) return c
      ;[ordered[i], ordered[j]] = [ordered[j], ordered[i]]
      ordered.forEach((p, idx) => (p.sort = idx + 1))
      c.plans = ordered
      return c
    })
  }

  async function removePlan(id: string) {
    if (!window.confirm('Remove this plan?\nTenants stop seeing it. Past payments keep their plan name. To just pause it, untick "Show to tenants" instead.')) return
    update((c) => {
      c.plans = c.plans.filter((p) => p.id !== id)
      delete c.defaultPrices[id]
      Object.values(c.categoryPrices).forEach((m) => delete m[id])
      return c
    })
  }

  function addCategory() {
    update((c) => {
      c.categories.push({ id: newId('cat'), name: `Category ${c.categories.length + 1}` })
      return c
    })
  }

  async function removeCategory(id: string) {
    const inUse = Object.values(tenantCfgs).filter((c) => c.categoryId === id).length
    const msg = inUse
      ? `${inUse} tenant${inUse === 1 ? '' : 's'} use it — they'll fall back to the default prices (or their custom prices).`
      : 'No tenants use it.'
    if (!window.confirm(`Remove this category?\n${msg}`)) return
    update((c) => {
      c.categories = c.categories.filter((x) => x.id !== id)
      delete c.categoryPrices[id]
      return c
    })
  }

  function setPrice(categoryId: string | null, planId: string, value: string) {
    update((c) => {
      const n = Number(value)
      const target = categoryId ? (c.categoryPrices[categoryId] ??= {}) : c.defaultPrices
      if (value.trim() === '' || !Number.isFinite(n) || n <= 0) delete target[planId]
      else target[planId] = n
      return c
    })
  }

  async function handleSave() {
    for (const p of draft.plans) {
      if (!p.name.trim()) return window.alert('Every plan needs a name')
      if (!Number.isInteger(p.months) || p.months < 1) return window.alert(`"${p.name}" needs a length of at least 1 month`)
    }
    for (const c of draft.categories) {
      if (!c.name.trim()) return window.alert('Every category needs a name')
    }
    setBusy(true)
    try {
      await saveCatalog(draft, tenants, tenantCfgs)
      setDirty(false)
    } catch (err) {
      console.error(err)
      window.alert(`Could not save: ${(err as Error).message ?? err}`)
    } finally {
      setBusy(false)
    }
  }

  const priceInput = (categoryId: string | null, planId: string) => {
    const value = categoryId ? draft.categoryPrices[categoryId]?.[planId] : draft.defaultPrices[planId]
    return (
      <input
        type="number"
        min={0}
        className={cx(inputClass, 'h-9 w-28')}
        placeholder="—"
        value={value ?? ''}
        onChange={(e) => setPrice(categoryId, planId, e.target.value)}
      />
    )
  }

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur">
        <p className="text-sm text-gray-600">
          {dirty ? 'Unsaved changes — tenants keep seeing the old prices until you save.' : 'Saved. Tenants see these prices.'}
        </p>
        <div className="flex gap-2">
          {dirty && (
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(catalog)
                setDirty(false)
              }}
            >
              Discard
            </Button>
          )}
          <Button onClick={handleSave} disabled={!dirty || busy}>
            {busy ? 'Saving…' : 'Save & publish'}
          </Button>
        </div>
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Plans</h2>
            <p className="text-sm text-gray-500">Tenants see a plan only when "Show to tenants" is ticked AND it has a price below.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={addPlan}>
            + Add plan
          </Button>
        </div>
        {plans.length > 0 && !plans.some((p) => p.active && (draft.defaultPrices[p.id] ?? 0) > 0) && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No plan is shown to tenants yet — tick "Show to tenants" and enter a Default price, then Save & publish. Until then tenants see "Plans aren't available".
          </p>
        )}
        {plans.length === 0 ? (
          <p className="text-sm text-gray-400">No plans yet. Add e.g. Monthly (1), Half-yearly (6), Yearly (12).</p>
        ) : (
          <div className="space-y-2">
            {plans.map((p, idx) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 p-2">
                <input
                  className={cx(inputClass, 'h-9 min-w-[160px] flex-1')}
                  value={p.name}
                  onChange={(e) =>
                    update((c) => {
                      c.plans.find((x) => x.id === p.id)!.name = e.target.value
                      return c
                    })
                  }
                />
                <label className="flex items-center gap-1.5 text-sm text-gray-600">
                  <input
                    type="number"
                    min={1}
                    className={cx(inputClass, 'h-9 w-20')}
                    value={p.months}
                    onChange={(e) =>
                      update((c) => {
                        c.plans.find((x) => x.id === p.id)!.months = Math.trunc(Number(e.target.value))
                        return c
                      })
                    }
                  />
                  months
                </label>
                <label className="flex items-center gap-1.5 px-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    checked={p.active}
                    onChange={(e) =>
                      update((c) => {
                        c.plans.find((x) => x.id === p.id)!.active = e.target.checked
                        return c
                      })
                    }
                  />
                  Show to tenants
                </label>
                <div className="ml-auto flex items-center">
                  <button className="p-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" disabled={idx === 0} onClick={() => movePlan(p.id, -1)} title="Move up">
                    ↑
                  </button>
                  <button
                    className="p-1.5 text-gray-400 hover:text-gray-700 disabled:opacity-30"
                    disabled={idx === plans.length - 1}
                    onClick={() => movePlan(p.id, 1)}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button className="p-1.5 text-gray-400 hover:text-red-600" onClick={() => removePlan(p.id)} title="Remove plan">
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Tenant categories</h2>
            <p className="text-sm text-gray-500">e.g. Small, Medium, Large — assign each tenant under Tenants.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={addCategory}>
            + Add category
          </Button>
        </div>
        {draft.categories.length === 0 ? (
          <p className="text-sm text-gray-400">No categories — every tenant pays the default prices.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {draft.categories.map((c) => (
              <div key={c.id} className="flex items-center gap-1 rounded-xl border border-gray-200 p-1.5">
                <input
                  className={cx(inputClass, 'h-8 w-40')}
                  value={c.name}
                  onChange={(e) =>
                    update((d) => {
                      d.categories.find((x) => x.id === c.id)!.name = e.target.value
                      return d
                    })
                  }
                />
                <button className="p-1.5 text-gray-400 hover:text-red-600" onClick={() => removeCategory(c.id)} title="Remove category">
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900">Prices (₹)</h2>
        <p className="mb-3 text-sm text-gray-500">
          Leave a category's box empty to use the default price. Leave the default empty too and that plan isn't offered to those tenants.
        </p>
        {plans.length === 0 ? (
          <p className="text-sm text-gray-400">Add a plan first.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="px-2 py-2 font-medium">Default</th>
                  {draft.categories.map((c) => (
                    <th key={c.id} className="px-2 py-2 font-medium">
                      {c.name || '—'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const def = draft.defaultPrices[p.id]
                  return (
                    <tr key={p.id} className={cx(!p.active && 'opacity-50')}>
                      <td className="py-1.5 pr-4">
                        <p className="font-medium text-gray-800">{p.name}</p>
                        <p className="text-xs text-gray-500">
                          {p.months} mo{def ? ` · ${formatRupees(Math.round(def / Math.max(1, p.months)))}/mo` : ''}
                        </p>
                      </td>
                      <td className="px-2 py-1.5">{priceInput(null, p.id)}</td>
                      {draft.categories.map((c) => (
                        <td key={c.id} className="px-2 py-1.5">
                          {priceInput(c.id, p.id)}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
