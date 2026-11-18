# Student AI on tuition: the parent's line

Phase 3 of "Student AI seats bundled with tuition, plus revenue share" (approved 2026-11-17; plan
decisions 2, 3, 8 and 9). For every opted-in student Studafy adds a "Student AI" fee to the
child's fees: the parent price per month times the months to the end of the school's academic year,
paid with tuition. Migration 000238; pure rules in `apps/api/src/modules/finance/student-ai/plan.ts`;
reconciliation and reads in `.../student-ai/service.ts`; the billing worker's part in
`apps/workers/src/queues/billing/student-ai-line.ts`; finance page
`/portal/finance/settings/student-ai`; the parent app's Finance tab.

## The amount

- **Price:** the monthly price and currency on the parent's phase 2 opt-in (what they agreed to: the
  licence's signed parent price when they opted in). It is fixed on the line when the line is
  created; a later re-apply of programme values or a change of the school's currency never re-prices
  it. (`skipped_no_price` remains for a line without an opt-in to price it from.)
- **Months follow the school's academic year.** A calendar month belongs to the year when the year
  covers at least half of its days: 1 Sep - 30 Jun is 10 months, 1 Sep - 30 Apr is 8, and a year
  from 25 Aug to 10 Jun is Sep - May (9). Nothing assumes 10.
- **Charged months:** from the student's start month (not before the year's first month) to the
  year's last month. A late opt-in pays the remaining months only.
- **Total** = price x months, in minor units.

## Spread over the instalments (allocation rule)

- The instalments are the student's own tuition instalments (`installment_cache`, their ERPNext fee
  schedules) due in or after the start month and no later than the year's last month.
- Each charged month is paid by the latest of those instalments due in or before it (an instalment
  pays for the months from its due date up to the next one, as tuition is paid in advance); months
  before the first instalment are paid by the first.
- A portion is therefore a whole number of months, and its amount is the monthly price times that
  number. Uneven splits (10 months over 3 instalments: 4 + 3 + 3) need **no rounding**, and the
  portions always add up to the total exactly, in any currency's minor units.
- No instalment in range (none created yet, or a late opt-in after the last one): one portion per
  month, due on its first day.
- The spread follows the instalments: generating a payment plan (`POST /api/finance/fee-schedules/generate`)
  re-spreads what is not yet invoiced over the new due dates.

## Billing (ERPNext)

The billing worker, generating a Sales Invoice for a student (`generateInvoice`), puts every planned
portion due on or before the invoice's due date (its posting date when it has none) on that invoice
as its own item: Item/Fee Category `Student AI`, qty = months, rate = monthly price, description
"Student AI 2026-09 to 2026-12". The portions are then marked invoiced with the invoice's name and
are frozen (a trigger refuses any change or removal). ERPNext's totals, ledger and outstanding amount
carry the line like any other. The worker creates the `Student AI` Fee Category on the school's site
when it is missing. A portion in another currency than the invoice is left planned (never
converted). Scholarship and sibling discounts are computed on the fee structure's own components, so
they never reduce the Student AI line; sales tax applies to it like any other line unless
`Student AI` is an exempt category.

## Released and transferred seats (decision 9)

- **Released** (student left): charged up to the month before `releasedEffectiveMonth` (phase 2 sets
  it to the month after the release). Planned portions for later months are removed or reduced;
  invoiced portions never change. Refunds are between the school and the parent, outside Studafy.
- **Transferred:** the leaver stops as for a release; the new student has their own opt-in and line
  from the transfer month.
- An opt-in that disappears entirely: the line goes when nothing was invoiced; otherwise it stays,
  stopped after the last invoiced month.

## Auto-billing switch (per school, finance)

- **On (default):** as above.
- **Off:** no portions are planned (the school bills Student AI itself). Parents still see the same
  line, "paid with tuition"; `billing` is `outside`.
- **Changing it mid-year affects only what is not yet invoiced.** Off removes the planned portions.
  Back on plans again from the current month (`auto_billing_since`), so months the school billed
  itself while it was off are never billed twice. Invoiced portions never change either way.

## Reconciliation

`syncStudentAiFeeItems(tx, schoolId, studentId)` is the one function that brings a student's lines
and planned portions to what their opt-ins, instalments and the switch call for. It is idempotent:
it can run after any event, any number of times, and changes nothing when nothing changed. It runs in
a system transaction armed for the school (`withStudentAiTx`); `syncStudentAiFeeItemsInOwnTx` opens
one. Finance can run it for the whole school (`POST /api/finance/student-ai/sync`).

Opt-ins are read only through `listStudentAiOptIns` (`.../student-ai/opt-ins.ts`), from phase 2's
`app.ai_optins`: the start month, the status, the first month no longer charged (a release's
`released_effective_month`; for a transfer, the month the receiving student's opt-in starts -- the
month after the transfer, so the leaver is charged through the transfer month and no month is
charged twice), and the monthly price and currency the parent agreed to on the opt-in (the line's
price is fixed from it). Phase 2's opt-in (parent or on a parent's behalf), release and transfer
(both students) call `resyncStudentAiAfterCommit` once their transaction commits; so does the
fee-schedule generator. A failed re-sync is logged at error level with the school and student ids
(`POST /api/finance/student-ai/sync` is the retry). Opt-ins are per academic year: parents choose
again each new year, so a new year never carries a line over.

## Who sees what

- **Parents (app, Finance tab):** per opted-in child and academic year, "Student AI -- included in
  your school fees", the start month for a late opt-in and "stopped from <month>" after a release
  (en + ar). **No amount** (owner, 2026-11-18: the school tells parents the price): the family
  view's `student_ai_lines` carry only the year, start/end month, late start, stop month and status
  -- no price, total, currency, invoiced or planned amount. The school's own fee invoices keep their
  totals. Never the licence cost or the revenue share either, which are not on the wire. Row-level security limits the tables to the child's family and school
  leadership; the API scopes the family view to the parent's own family.
- **Students:** do not see fees in the app.
- **Finance (web):** every line with what is invoiced and what is still planned, the switch and the
  recalculation (`billing:read` / `billing:update`).
