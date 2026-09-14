# Wholesale dealer fixes: dev-access reconciliation tool, mandatory order-linked payments, collections date-accuracy fix, Customer Balance report improvements, and the ledger data-integrity investigation

## Files changed
- `src/types/index.ts` — adds `AppUser.devAccess`, `DevReconciliationEntry`,
  `Order.devReconciliations` / `lastDevReconciledAt` / `lastDevReconciledBy` / `lastDevReconciledByName`,
  and `Order.lastPaymentAt`.
- `src/types/ledger.ts` — adds `LedgerPaymentAllocation` and `LedgerEntry.allocations`. See §9.
- `src/utils/ledger.ts` — adds `devReconcileOrderPayment()`; `applyPaymentToOrders()` rewritten to write
  ONE grouped ledger entry per payment (re-reading every order fresh inside its own transaction). See §9.
- `src/pages/Orders.tsx` — adds the "🛠 Mark as Paid (dev reconciliation)" button + modal, visible on any order
  status; `recordSingleOrderPayment` call updated for the new signature.
- `src/pages/Customers.tsx` — Record Payment tab auto-selects/mandatory-links unpaid orders (§5); **removes the
  ledger dedup-on-view logic that was silently deleting real transaction history** (§9); Ledger tab now renders
  grouped payments with an expand/collapse breakdown, and its table no longer needs a horizontal scrollbar.
- `src/pages/FinanceReports.tsx` — Collections Report and Payment Mode Breakdown now bucket by actual payment
  date (`lastPaymentAt`), not order-creation date. See §6.
- `src/pages/CreateOrderPage.tsx` — stamps `lastPaymentAt` when an advance is collected at order creation.
- `src/pages/CustomerReports.tsx` — Customer Balances tab gets an Area column, a "Only customers with due"
  filter, print output respects the chart setting, and the misleading date-range label is gone. See §7, §8.
- `src/pages/Settings.tsx` — new "Reports & Printing" setting: Include/Exclude charts in printed reports.
  See §7.

`tsc --noEmit` and `npm run build` both pass clean with these changes on top of your uploaded code.
See `CHANGES.diff` for a reviewable unified diff of exactly what moved.

## 1. How the dev-mode switch works (no new plumbing needed)

Your `App.tsx` already keeps a **live** `onSnapshot` listener on `users/{uid}` for
the logged-in user, so it re-applies instantly if that doc changes — no re-login needed.
That's exactly the mechanism you described. So turning the hidden features on/off for
one person is just:

1. Open Firebase Console → Firestore → `users` collection.
2. Find that person's doc (their `uid`, same id as their Firebase Auth user).
3. Add/edit a boolean field: `devAccess: true`.
4. When you're done, flip it back to `false` (or delete the field).

Nothing in the app UI (not even `Users.tsx`, the admin user-management screen) exposes
this field — it's console-only by design, so it can't be toggled by mistake or by a
non-technical admin.

**One thing worth doing outside this codebase:** if you have Firestore security rules
deployed, add a rule so a user can never write their *own* `devAccess` field via the
client SDK (only reads should be allowed on that field, and only your Admin
SDK/console should be able to write it). I don't have your `firestore.rules` in this
zip, so I couldn't check/edit it — just flagging it so `devAccess` can't be self-granted.

## 2. What "Mark as Paid" does and doesn't do

It only appears in the order drawer when the logged-in user has `devAccess: true`,
they're an admin, the order is delivered, and it has a balance due — same visibility
condition as "Record Payment", plus the dev flag.

It calls `devReconcileOrderPayment(orderId, amount, note, uid, name)`, which:
- ✅ Updates that order's `amountCollected` / `balanceDue` directly.
- ✅ Bumps `adminCollected` by the same amount, so `AgentCashCollection.tsx`'s
  cash-in-hand math keeps excluding it from whatever delivery agent handled the order
  (same convention `applyPaymentToOrders` already uses).
- ✅ Appends an entry to `order.devReconciliations[]` (amount, timestamp, your uid/name,
  and a required note) and stamps `lastDevReconciledAt/By/ByName` — so every use is
  auditable later, including by someone other than you.
- ❌ Does **not** write a ledger entry under `customers/{id}/payments`.
- ❌ Does **not** touch `customer.outstandingDue`.

That last two are the point: in your broken cases, the ledger and `outstandingDue` are
already correct (the cash was recorded via the customer-level "Record Payment" tab
without a bill selected, which calls `recordManualPayment` — ledger + due only, no
order write). This tool fixes only the order side, so nothing gets double-counted.

The modal requires a short reason/reference note and an explicit confirmation checkbox
before the button enables, since this writes directly to live orders.

**Visibility, dev mode vs. normal:** the "Record Payment" button still only shows for
delivered orders with a balance. The dev-only "🛠 Mark as Paid" button is different on
purpose — it shows for **any** order status (draft, confirmed, out for delivery,
delivered, even cancelled) as long as there's a positive `totalAmount - amountCollected`
gap, since reconciliation isn't tied to the delivery workflow.

## 3. Root cause, confirmed in your code

`Customers.tsx` → the "Record Payment" tab → `handlePayment()`:
- If the admin **checks specific order(s)** in "Settle Specific Order(s)" → calls
  `applyPaymentToOrders`, which updates the ledger, `outstandingDue`, **and** each
  order's `amountCollected`/`balanceDue`. Fully correct.
- If **no orders are checked** → calls `recordManualPayment`, which only writes a
  ledger credit and reduces `outstandingDue`. No order is touched.

So any time your team collected a bulk/general payment from a customer and didn't
tick the specific bill(s) it covered, the money is correctly in the ledger and
`outstandingDue`, but the underlying order(s) still look unpaid — which is exactly
what inflates "Pending Collections" in `FinanceReports.tsx` (it sums
`totalAmount - amountCollected` per order).

## 4. How to actually fix the affected orders

For each customer where you see this mismatch:
1. Open Customers → that customer → **Ledger** tab, and cross-check against **Orders**
   tab to see which specific orders are still showing a balance despite the ledger
   being settled.
2. Confirm the math: sum of "pending" orders for that customer should currently be
   *more* than their real `outstandingDue` — that gap is what you're correcting.
3. Enable `devAccess: true` on your own user doc in Firestore.
4. Open each affected order → "🛠 Mark as Paid (dev reconciliation)" → enter the
   amount that was actually already paid for that specific bill, add a note
   (e.g. "Bulk payment on 2 Sep wasn't linked — see ledger entry X"), confirm, save.
5. Re-check `outstandingDue` on the customer doc — it should be unchanged by this
   step (by design). Only the order-level and Pending Collections numbers should move.
6. Once all affected orders for that customer are cleared, set `devAccess: false`
   again on your user doc.

Since it's live data, I'd suggest reconciling one customer fully, re-checking their
ledger vs. orders vs. `outstandingDue` add up, and only then moving to the next.

## 5. Customers → Record Payment tab: auto-select + mandatory linking

This closes the loophole that caused the original mismatch, so it can't happen again
going forward.

**Auto-select (live):** as the admin types an amount, the oldest unpaid order(s) are
ticked automatically until their combined due covers the amount — the last order
picked may only be partially covered, exactly matching how the payment actually gets
applied (`applyPaymentToOrders` fills oldest-first, partially settling the last one it
touches). This only re-runs when the **amount** changes, so it never undoes a manual
tick/untick the admin makes afterwards.

**Manual override:** still fully available — tick or untick any order at any time.

**Mandatory linkage:** whenever a customer has any unpaid orders, the "Record Payment"
button now stays disabled unless:
- at least one order is selected, **and**
- the entered amount is ≤ the selected orders' total due.

If the amount typed is more than what's selected can cover, there's a clear inline
warning telling the admin to either select more orders or reduce the amount — it no
longer silently falls back to an unlinked ledger-only payment. The only case where an
unlinked payment still happens is a customer with **zero** unpaid orders (e.g. a due
that came purely from a manual adjustment) — there's nothing to link to in that case,
so the old ledger-only path is kept for that specific situation only.

## 6. Finance Reports: Collections & Payment Mode were bucketed by the wrong date

**Bug:** both reports filtered orders by `createdAt` (order placement date) falling in
the selected date range — but they're meant to show *money collected* in that range.
For any order paid later than it was created (credit customers, or anything fixed via
the dev reconciliation tool), the collection would silently vanish from whatever period
you were actually looking at. This predates today's work — it's a real, independent bug,
not just a side effect of the reconciliation tool.

**Fix:** added `Order.lastPaymentAt`, stamped by `applyPaymentToOrders`,
`devReconcileOrderPayment`, and order creation (if an advance was taken up front).
Both reports now filter/bucket by `lastPaymentAt ?? deliveredAt ?? createdAt` instead
of `createdAt` alone. The Collections tab table now shows both **"Collected On"**
(the real date, used for filtering) and **"Order Date"**, so nothing is hidden.

`ProfitReport` was deliberately left as-is — it's an accrual/revenue view keyed to when
a sale was booked, not a cash-basis view, so `createdAt` is the right field there.

**What this does NOT fix:** orders already reconciled before this update, or any
already-delivered order, won't have `lastPaymentAt` retroactively — they'll keep
falling back to `deliveredAt`/`createdAt`. To see those specific ones in the Collections
tab, widen the date range to their original order period. Everything reconciled or
paid from now on will show up correctly in whichever period you're viewing when it
happens.

**Outside this codebase:** I couldn't find where an order actually gets marked
`status: "delivered"` with a real delivery-collection amount anywhere in this repo —
that write must live in a separate delivery-facing app/interface. If one exists, it
should stamp `lastPaymentAt` the same way when it records a delivery collection, or
those collections will keep being bucketed by `deliveredAt`/`createdAt` instead of the
exact moment the cash came in.

## 7. Customer Reports → Customer Balance: Area column, due-only filter, chart-free printing

**Area column:** the shop's area now has its own column (Region, then Area) instead of
being a small subtext line under the shop name. It reads from the same `customer.area`
field that was already there — nothing else changes.

**"Only customers with due" filter:** a checkbox next to the Region dropdown. When
checked, customers with zero balance are hidden from both the table and the export —
useful when you only want to work through people who actually owe money. It combines
with the existing search and region filters (all three narrow the same list together).

**Charts in printed reports — new global setting:** Settings → **Reports & Printing** →
"Charts in Printed Reports", with an Include/Exclude toggle. Defaults to **Include**
(unchanged prior behaviour) until an admin turns it off.

Turning it off removes the bar/pie charts from what gets printed on the Customer
Balances, Top Customers, Order Frequency, and By Region tabs — the data table still
prints in full either way, just without the chart above it.

**Why this only touches Customer Reports:** I checked every report page for how they
build their print output. Finance, Orders, Stock, Staff Attendance, and Agent reports
all generate print output directly from `headers`/`rows` data — they never included
charts in print in the first place, so this setting has no effect on them (and doesn't
need to — there's nothing to exclude). Customer Reports is the only page that prints by
cloning what's actually on screen, which is why it was the only place showing charts in
print to begin with. The setting is still named/placed generically ("Reports &
Printing", not "Customer Reports"), so if another report page is ever built the same
way (DOM-clone printing with charts), it can opt into the same setting by tagging its
chart card with the `report-chart-block` CSS class — no new setting needed.

## 8. Customer Balances: misleading "Last 30 days" label, and a clean handover-sheet print

**"Last 30 days" label:** Customer Balances (and the Ledger Statement tab) were always
showing the *complete, all-time* outstanding — they never actually filtered by the
7/30/90-day picker. The picker itself is already hidden on those two tabs, but the
header line above it (`"49 customers · 29 with outstanding dues · Last 30 days"`) still
appended whatever date range happened to be selected elsewhere, which was misleading.
That trailing range text is now only shown on the tabs that are genuinely date-scoped
(Top Customers, Order Frequency, By Region) — Customer Balances and Ledger Statement no
longer show it. Nothing about the actual numbers changed, this was a label-only issue.

*(Side note, not changed: the "Active (in range)" summary card at the top still uses
that same date picker and still shows on every tab, including Customer Balances. Say
the word if you'd like that hidden on this tab too.)*

**Printed sheet, cleaned up for handover to the delivery person:** the filter bar
(search box, region dropdown, "Only customers with due" checkbox, the "X of Y
customers · filtered" text) and the card header text ("All Customer Balances", "29 with
balance due · Total outstanding: ₹...") no longer appear in print — same `.print-hide`
technique as the rest of this section. Only the actual table prints now, plus the page
title/subtitle `printTable` already puts at the top.

The **Status** column (Clear / Due / Over Limit badges) is swapped out for a blank
**Collected (₹)** column in print only — an empty bordered box per row, sized for
writing a number by hand. On screen, nothing changes: you still see the Status badges
as before. Handing this sheet to a delivery person now gives them shop, area, phone,
and balance due, with a physical box next to each row to write down what they actually
collected.

**The print subtitle had the same "Last 30 days" bug, separately from the on-screen
header — also fixed.** `printTable`'s subtitle line (shown just under the report title
on the printed page) was always fed `rangeLabel` regardless of which tab was open. It's
now blank for Customer Balances and Ledger Statement (the same two all-time tabs), and
the subtitle line itself is only rendered when there's something to show, so there's no
leftover empty line on the printed sheet.

## 9. Ledger data-integrity investigation — root causes found and fixed

This came from a real customer (Pandu Store, phone 9965653341) whose ledger showed
₹71,180 due while the Customers list and Orders tab agreed on ₹65,810, and the client
separately confirmed the true due was ₹68,495. Full details of the investigation are in
the conversation; summarizing the two root causes found and fixed here.

### Bug 1 (the big one): a "dedup" cleanup routine was deleting real payments

`Customers.tsx`'s `fetchLedger()` ran this every single time anyone opened a customer's
Ledger tab:

```js
// kept only the FIRST ledger entry per (orderId + type + direction) combination —
// every entry after the first with the same key was deleted from Firestore
```

The key had no date, no amount, no ID — just `orderId + type + direction`. Any time the
*same order* received a payment across two separate sessions (completely normal for a
credit customer paying an old bill in installments), the second entry collided with the
first and got silently deleted. `outstandingDue` and the order itself were already
correct by the time this ran (both are updated at the moment a payment is written) — only
the ledger's own historical record of the transaction was destroyed. This is **removed
entirely** — it was already in the code you uploaded, not something introduced by our
earlier work.

### Bug 2: `applyPaymentToOrders` computed allocations from stale, pre-fetched data

The old version calculated how much to apply to each order using whatever
`amountCollected` the caller's browser already had in memory, *before* opening the
Firestore transaction — it never re-read the order fresh at write time. Traced through
this same customer's real data, this is what let a second payment (minutes after the
first) re-apply money to an order that had *just* been settled, resulting in a genuine
over-credit — not just a missing ledger record, but ₹2,685 credited to an order the
customer never actually paid that amount for.

**Fixed:** `applyPaymentToOrders` now does all its reads (customer + every target order)
*inside* the transaction, computes allocations from that live data, and — critically —
**aborts with a clear error** if the live balances can't absorb the full amount typed
(e.g. because something else already settled part of it in the meantime), instead of
silently dropping the leftover or applying it somewhere the admin didn't choose. A stale
tab or accidental double-submit now fails loudly and asks the admin to refresh, rather
than quietly corrupting a balance.

### The data-model change you asked for: one ledger entry per payment

Previously a single payment split across N orders wrote N separate top-level ledger
rows — which is also exactly what made the dedup bug possible to trigger in the first
place. Now `applyPaymentToOrders` writes **one** entry for the whole amount received,
with a `allocations: [{ orderId, orderNo, amountApplied }]` breakdown attached.

- The Ledger tab shows one row per payment. If it covers 2+ orders, a ▸/▾ toggle appears
  in the Note column (click the row) revealing each order's real order number and the
  amount applied to it.
- The collapsed row's note defaults to: `"...for order #<no>"` for one order,
  `"...settled orders #<no1> + #<no2>"` for two, `"...settled N orders (see breakdown)"`
  for three or more — always using the real `orderNo`, never the old truncated-ID format.
- This applies everywhere a payment is written from the app — the Customers → Payment
  tab and the Orders drawer's single-order "Record Payment" both go through the same
  `applyPaymentToOrders`, so they're consistent (a single-order payment just has one
  allocation, so no toggle shows for it — nothing to expand).
- **Old entries are untouched** — they'll keep showing as separate rows forever, exactly
  as they are now. Only new payments going forward use the grouped format.

### Ledger tab horizontal scrollbar — fixed

The table now uses a fixed column-width layout (`table-fixed` + explicit widths) with
text wrapping instead of relying on natural content width, so it fits inside the modal
without needing to scroll horizontally at all.

### What this does NOT do

None of this retroactively repairs Pandu Store's own numbers — `outstandingDue` is
still sitting at ₹65,810 instead of the confirmed-correct ₹68,495. That's a one-time
manual data correction (not a code change), separate from these fixes, and still
outstanding — let me know when you want that done.
