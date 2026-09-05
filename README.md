# Wholesale dealer fixes: dev-access reconciliation tool, mandatory order-linked payments, and collections date-accuracy fix

## Files changed
- `src/types/index.ts` — adds `AppUser.devAccess`, `DevReconciliationEntry`,
  `Order.devReconciliations` / `lastDevReconciledAt` / `lastDevReconciledBy` / `lastDevReconciledByName`,
  and `Order.lastPaymentAt`.
- `src/utils/ledger.ts` — adds `devReconcileOrderPayment()`; `applyPaymentToOrders()` now also stamps `lastPaymentAt`.
- `src/pages/Orders.tsx` — adds the "🛠 Mark as Paid (dev reconciliation)" button + modal, visible on any order status.
- `src/pages/Customers.tsx` — Record Payment tab now auto-selects unpaid orders (oldest-first) to match the
  entered amount, and makes order-linking **mandatory** whenever the customer has unpaid orders. See §5 below.
- `src/pages/FinanceReports.tsx` — Collections Report and Payment Mode Breakdown now bucket by actual payment
  date (`lastPaymentAt`), not order-creation date. See §6 below.
- `src/pages/CreateOrderPage.tsx` — stamps `lastPaymentAt` when an advance is collected at order creation.

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
