# ADR-021: Licence invoices are paid at once, monthly, or on a custom schedule

## Status

Accepted

## Context

A school licence is invoiced once, when its quote is accepted, and paid by bank transfer or a Revolut
payment link (ADR-018, [billing/feature-licensing.md](../billing/feature-licensing.md)). Many schools
only run for part of the year — an 8-month licence for the months students attend — and want to pay
it month by month, or in a few parts they agree with Studafy, not all at once. Until now an invoice had
one due date: partial payments were accepted, but nothing said how much was due when, reminders
treated any balance as one debt, and the licence started only once everything was paid (or the super
admin activated it by hand).

## Decision

1. **The super admin chooses the plan on the quote**: `in_full` (one payment, as before), `monthly`
   (one instalment per licence month) or `custom` (amounts and due dates the super admin enters). The
   school sees the plan and the schedule on the quote before accepting it.
2. **The total is the same whatever the plan.** The existing volume and duration discounts apply as
   before; there is no surcharge for paying monthly and no extra discount for paying at once.
3. **One invoice per quote, split into instalments** (`app.license_invoice_instalments`, migration
   000221). Invoice numbers stay gapless; payments are still recorded against the invoice.
   - Monthly: the total split evenly over the licence months, the rounding remainder on the first
     instalment; due on the licence start and the same day of each following month.
   - Custom: amounts that add up to the total exactly, dates in order and not before today, at most 24.
   - No instalment falls due before the invoice is issued (an earlier date moves to the issue date).
4. **Payments fill the earliest instalment first**, recomputed from the invoice's paid total on every
   payment and every void, so a voided payment comes off the latest-paid instalment. The invoice's due
   date is its earliest unpaid instalment's.
5. **The licence starts once the first instalment is paid in full.** The super admin can still
   activate early; doing so moves the instalment to pay now to the date given.
6. **Reminders and overdue marks are per instalment.** Each instalment is reminded of once when it
   falls due and once when it goes overdue. Suspension stays the super admin's decision, never
   automatic.
7. **Each instalment has its own Revolut payment link** for its amount; the school's "Pay online"
   opens the link of the instalment to pay now.
8. **The database keeps every invoice whole**: a deferred constraint trigger checks at commit that an
   invoice's instalments add up to its total, their paid parts to its paid amount, and their due dates
   never go backwards.

## Consequences

- Every invoice issued before 000221 became one instalment with the invoice's own id, so the due and
  overdue reminders already sent for it are not sent again.
- `app.license_invoices.payment_link` (000220) is superseded by the instalment's and no longer written;
  the invoice-level payment-link route sets the link of the instalment to pay now.
- A custom schedule is tied to the quote's total: re-pricing a custom quote needs its schedule again.
- A school paying monthly has its seats from the first payment while most of the invoice is unpaid.
  That is the point of the plan; the reminders, the overdue marks and the console's unpaid balance are
  how the super admin follows it up.

## Amendment (2026-11-17, migration 000233): the school chooses, and AI stops 30 days late

Owner decisions: "the school chooses the amount of months they want the AI for, not us; the school
chooses to pay monthly, yearly or custom; they see each year's payment and the full list of payment
dates", and "if an instalment is unpaid 30 days after its due date, the AI stops until it is paid".

1. **The school proposes the length and the plan on its request** (`/portal/license`, "Request AI
   for students"): 1-36 months (presets 3/6/12/24 or any number), an optional start date for a new
   licence, and `monthly`, `yearly` or `custom`. A custom plan is proposed as dates and _shares_ of
   the total (basis points adding up to 100%) because the school has no price yet; dates must be in
   order, from today, and before the term ends. The form previews every payment's date and share
   and what each licence year carries.
2. **The super admin still prices and approves.** The console's calculator opens on the request
   (`?requestId=`): the school's length, start and plan prefill the terms and the shares become
   amounts once the total is known. Changing any of them is allowed but needs a reason
   (`LICENSE_TERMS_CHANGE_REASON_REQUIRED`), which the school reads on the quote next to what it
   asked for. The school then accepts or declines the quote as before; accepting resolves the
   request. Nothing is invoiced on terms the school has not seen.
3. **`yearly` joins the plans**: one instalment per licence year, due on the start date and each
   anniversary; each year pays for its own months (a 13-month licence is 12/13 then 1/13 of the
   total, the rounding remainder on year 1). Every quote, calculation and invoice reports
   `yearTotals`: the total of the instalments falling due in each licence year.
4. **A seat increase's schedule spreads over the months left** (to the nearest month), not the whole
   term, so its instalments stay within the licence.
5. **AI stops 30 days after an unpaid instalment** (this replaces decision 6's "suspension stays the
   super admin's decision"). The hourly licence lifecycle job suspends an active licence once any
   unpaid instalment of one of its open invoices is 30 or more days past its due date (UTC dates:
   due 1 March, stopped from 31 March 00:00 UTC), marks it `nonpayment_suspended_at`, bumps its seat
   holders' entitlements and audits it. Every instalment counts, so a later one going unpaid stops it
   again. Recording the payment that settles it resumes the licence at once (the job also resumes
   any it finds settled, for example after an invoice is voided). A licence the super admin suspended
   by hand is never resumed automatically.
6. **The school is told**: banners on every licence page from the day an instalment is late ("AI
   stops on <date> if this payment is not made") and once it has stopped; an "AI stops if unpaid on"
   column on the payment schedule; in-app and push notices (`LICENSE_AI_STOP_WARNING` 7 days before
   the cutoff, `LICENSE_AI_STOPPED` when it stops) to the school's admins and principals and the
   super admins, alongside the existing due and overdue reminders. The console's licence list marks
   licences stopped for non-payment.
7. **Overdue payments are emailed** to the school's billing contacts (its admins and principals and
   its verified contact address), once each: the day after an instalment's due date, 7 days before
   the AI cutoff, and when the AI stops. Billing mail like the invoice, sent through the
   transactional email channel (outbox + dispatcher, suppression list), in the school's language,
   with how to pay and the invoice link -- a deliberate exception to "notifications are never
   emailed".

## Review

- yousefomar3003, 2026-11-14 (the product decisions: plan chosen on the quote, same total, licence
  starts after the first instalment, one Revolut link per instalment).
- yousefomar3003, 2026-11-17 (the amendment: the school chooses length and plan, yearly plan,
  per-year totals, AI stops 30 days after an unpaid instalment).
