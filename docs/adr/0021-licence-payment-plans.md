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

## Review

- yousefomar3003, 2026-11-14 (the product decisions: plan chosen on the quote, same total, licence
  starts after the first instalment, one Revolut link per instalment).
