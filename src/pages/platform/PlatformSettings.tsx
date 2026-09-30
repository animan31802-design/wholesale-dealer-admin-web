import { useEffect, useState } from 'react'
import { Button, Card, cx, inputClass } from '../../components/subscription/ui'
import { savePublicConfig } from '../../lib/subscriptionApi'
import { normalizeWhatsappNumber } from '../../lib/subscription'
import { usePlatformData } from './usePlatformData'
import type { PlatformPublicConfig } from '../../types/subscription'

export function PlatformSettings() {
  const { config, tenants } = usePlatformData()
  const [draft, setDraft] = useState<PlatformPublicConfig>(config)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!dirty) setDraft(config)
  }, [config, dirty])

  function set<K extends keyof PlatformPublicConfig>(key: K, value: PlatformPublicConfig[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    setDirty(true)
  }

  async function handleSave() {
    const upi = draft.upiVpa.trim()
    if (upi && !/^[\w.-]+@[\w.-]+$/.test(upi)) return window.alert('That UPI ID looks wrong — it should look like name@bank.')
    const grace = Math.max(0, Math.trunc(Number(draft.graceDays) || 0))
    const reminder = Math.max(0, Math.trunc(Number(draft.reminderDays) || 0))
    if (grace !== config.graceDays) {
      const ok = window.confirm(
        `Change grace period to ${grace} day${grace === 1 ? '' : 's'}?\nThis is applied to every tenant right away — some may go read-only (or get unlocked) immediately.`
      )
      if (!ok) return
    }
    setBusy(true)
    try {
      await savePublicConfig(
        {
          ...draft,
          upiVpa: upi,
          payeeName: draft.payeeName.trim(),
          whatsappNumber: normalizeWhatsappNumber(draft.whatsappNumber),
          graceDays: grace,
          reminderDays: reminder,
        },
        config.graceDays,
        tenants
      )
      setDirty(false)
    } catch (err) {
      console.error(err)
      window.alert(`Could not save: ${(err as Error).message ?? err}`)
    } finally {
      setBusy(false)
    }
  }

  const field = (label: string, hint: string | null, input: React.ReactNode) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {input}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  )

  return (
    <div className="max-w-3xl space-y-6">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900">Payments</h2>
        <p className="mb-4 text-sm text-gray-500">Where tenants send money, and where you get the "I've paid" alerts.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('UPI ID', 'Shown to tenants and put into the QR code.', (
            <input className={inputClass} value={draft.upiVpa} onChange={(e) => set('upiVpa', e.target.value)} placeholder="yourname@okbank" />
          ))}
          {field('Payee name', 'Name shown in the payer\'s UPI app.', (
            <input className={inputClass} value={draft.payeeName} onChange={(e) => set('payeeName', e.target.value)} placeholder="Your name / business" />
          ))}
          {field('WhatsApp number for alerts', 'With country code, e.g. 919876543210 (10 digits get 91 added).', (
            <input className={inputClass} value={draft.whatsappNumber} onChange={(e) => set('whatsappNumber', e.target.value)} placeholder="919876543210" inputMode="tel" />
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900">Reminders & grace period</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {field('Grace period (days)', 'After the end date the tenant keeps full access for this many days, then goes read-only.', (
            <input type="number" min={0} className={inputClass} value={draft.graceDays} onChange={(e) => set('graceDays', Number(e.target.value))} />
          ))}
          {field('Reminder banner (days before end)', null, (
            <input type="number" min={0} className={inputClass} value={draft.reminderDays} onChange={(e) => set('reminderDays', Number(e.target.value))} />
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold text-gray-900">Receipts</h2>
        <p className="mb-4 text-sm text-gray-500">Printed at the top of the receipts tenants can download.</p>
        <div className="grid gap-4">
          {field('Issuer name', 'Defaults to the payee name.', (
            <input className={inputClass} value={draft.receiptIssuerName ?? ''} onChange={(e) => set('receiptIssuerName', e.target.value)} />
          ))}
          {field('Issuer details', 'Address, phone, GSTIN — one per line (optional).', (
            <textarea
              className={cx(inputClass, 'h-24 py-2')}
              value={draft.receiptIssuerDetails ?? ''}
              onChange={(e) => set('receiptIssuerDetails', e.target.value)}
            />
          ))}
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        {dirty && (
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(config)
              setDirty(false)
            }}
          >
            Discard
          </Button>
        )}
        <Button onClick={handleSave} disabled={!dirty || busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </div>
  )
}
