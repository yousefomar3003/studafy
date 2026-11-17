# Student AI programme: settings and versions

Phase 1 of "Student AI seats bundled with tuition, plus revenue share" (approved 2026-11-17). Every
number in the programme is the super admin's to change, globally or per school, and licences keep
the values they were signed with. Migration 000234; pure rules in
`packages/license-pricing/src/ai-programme.ts`; API in `apps/api/src/modules/licensing/ai-programme*.ts`;
console page `/portal/platform/ai-programme`.

## The settings

| Setting                                                                            | Field                                         | Default                                                       | Unit                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| In-app purchase price (display and calculations only; the stores set the real one) | `iapPriceMinor`                               | 600 USD                                                       | minor units / student / month              |
| School licence price                                                               | `licensePriceMinor`                           | 400 USD                                                       | minor units / seat / month                 |
| Price parents see                                                                  | `parentPriceMinor`                            | 600 USD                                                       | minor units / month                        |
| Minimum seats                                                                      | `minSeats`                                    | 30                                                            | seats                                      |
| Maximum revenue share                                                              | `maxShareBps`                                 | 1500                                                          | basis points                               |
| Conversion tiers (from -> share)                                                   | `conversionTiers`                             | 0->0, 2500->400, 4000->600, 5500->800, 7000->1000, 8500->1200 | bps                                        |
| Large-school floor                                                                 | `largeSchoolMinSeats` / `largeSchoolShareBps` | 500 seats / 800                                               | seats / bps (0 turns it off)               |
| Content-bonus tiers (upload consistency -> bonus)                                  | `contentBonusTiers`                           | 0->0, 6000->150, 8000->300                                    | bps                                        |
| Bonus only above a 0% conversion share                                             | `bonusRequiresConversionShare`                | true                                                          |                                            |
| Conversion measured after                                                          | `measurementOffsetDays`                       | 30                                                            | days after the licence starts              |
| Grace before Student AI stops                                                      | `nonpaymentGraceDays`                         | 30                                                            | days after an unpaid instalment's due date |
| Month-to-month licences earn                                                       | `monthToMonthShareBps`                        | 0                                                             | bps of the tier values (5000 = half)       |
| How the share is given                                                             | `payoutMode`                                  | `invoice_credit`                                              | `invoice_credit` or `payout`               |

Prices are per currency in a global version; a school is priced in its own currency
(`schools.default_currency_id`). The parent price may be any amount, including the licence price or
less: the console warns ("the school keeps no margin" / "below cost") but never blocks. Nothing
assumes a 10-month year: prices are monthly and the licence's own months (the school's academic
year) multiply them.

Validation (shared by the API and the console): tiers start at 0, thresholds rise strictly, shares
never fall, at most 20 rows; every share, the floor and each bonus at most the maximum; percentages
0-10000 bps; prices 0-100,000,000 minor units; minimum seats 1-100,000; measurement 0-365 days;
grace 1-365 days. A reason is required on every save.

## Versions

- `app.ai_programme_versions` (+ `_version_prices`, `_version_tiers`): global, one immutable row per
  save (`version_number`, `reason`, `created_by`, `created_by_school_id`, `created_at`). Version 1 is
  the defaults above, with the fixed id `a1000000-0000-4000-8000-000000000001`.
- `app.ai_programme_school_overrides` (+ `_school_override_tiers`): per school (tenant RLS), one
  immutable row per save; NULL inherits; a tier kind with no rows inherits that table. Clearing is a
  new, empty version.
- Rows reject UPDATE and DELETE by trigger. studafy_app may read (a school resolves its own values),
  never write.
- Saves take `basedOnVersionId` / `basedOnOverrideId`; a newer save in between is a 409
  `AI_PROGRAMME_VERSION_CONFLICT`. Each save is audited (global: the operator's home school; school:
  the console's two rows).

Resolution: `resolveAiProgramme(global, override, currency)` -- the school's value wherever it sets
one; override prices count only in their own currency; the in-app price is global only.

## Licences and quotes

- A quote records `ai_programme_version_id` / `ai_programme_override_id` when it is priced (and
  re-priced). NULL on quotes from before 000234.
- Accepting a `new` quote (a new licence) or an `extension` (a renewal) signs the licence with the
  quote's pair; a `seat_increase` keeps the licence's. A licence made directly in the console is
  signed with the values in force for its school.
- `school_licenses.ai_programme_version_id` / `_override_id` / `_applied_at` and
  `nonpayment_grace_days` (the resolved grace, so the workers' AI-stop SQL needs no resolution).
- The super admin can re-apply the current values to a licence (draft, awaiting payment, active or
  suspended) with a reason, audited with the versions before and after and the changed fields. It does
  not touch `updated_at`, so an open quote on the licence does not go stale.

## For later phases

- Read what a licence was signed with: `resolveAiProgrammeStamp(tx, { versionId, overrideId },
currencyCode)` or `licenseAiProgramme(tx, license)`.
- `previewRevenueShare(values, { conversionBps, uploadConsistencyBps, seats, fullYear })` is the
  share formula the console's example uses (tier, floor, bonus rule, cap, month-to-month). Phase 5
  applies it to what Studafy actually collects at that school's licence price.
- `tierFor` / `nextTierFor` give the tier a value is in and the next one ("add N seats -> unlock X%").
- No school-facing route reads these settings yet; phases 2-6 add the ones they need.

## Revenue share engine (phase 5, migration 000237)

The share Studafy pays a school on what it actually collects for Student AI seats. Every number comes
from the programme values the licence carries (its signed version and override); nothing is
hard-coded.

### The calculation (`@studafy/license-pricing`, `revenue-share.ts`)

`computeRevenueShare(values, { conversionBps, uploadConsistencyBps, seats, commitment, baseMinor })`:

- **Conversion share**: the conversion tier of the locked conversion, raised to the large-school floor
  when the licence's student seats (at measurement) reach `largeSchoolMinSeats`.
- **Content bonus**: the upload-consistency tier, counted only when the conversion share is above 0%
  if `bonusRequiresConversionShare`.
- **Full-year share**: conversion + bonus, capped at `maxShareBps`.
- **Total**: the full-year share, or for a month-to-month licence that share x
  `monthToMonthShareBps` / 10000 (0 by default).
- **Amount**: the Student AI part of the money collected x total.

A part not known yet (conversion not locked, upload consistency not measured) counts as 0% and is
flagged pending -- unless it cannot change the result (a month-to-month licence earning 0%; a bonus
ruled out by a 0% conversion share, with no tier above 0%, or with the conversion share already at the
cap).

**Rounding** (integer, BigInt, one rule per step):

| Step                           | Rule                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Conversion, upload consistency | `n x 10000 / d`, rounded **down** to a basis point (69.99% stays in 55-69%); 0 with nothing to divide by; at most 100% |
| Month-to-month total           | `full-year bps x multiplier / 10000`, rounded half up to a basis point                                                 |
| Student AI part of a payment   | `collected x student seat lines / all seat lines`, rounded half up to a minor unit                                     |
| Amount                         | `base x total bps / 10000`, rounded half up to a minor unit                                                            |

One amount per ledger entry (a payment's part of one instalment), so a licence's total share can
differ from the share of its total by at most half a minor unit per entry. The worked example is a
test: 350 of 500 (70% -> 10%) + uploads 85% (+3%) = 13% of $14,000 (= $4 x 350 x 10) = $1,820, and
the same in ten monthly payments of $182; so is an 8-month school at its own price.

### Conversion snapshots (`app.ai_programme_conversion_snapshots`)

- A licence's **measurement periods**: its start, and the first day each accepted extension (a
  renewal) adds. Measurement day = period start + `measurementOffsetDays`.
- The workers' hourly licence lifecycle job (step 6, its own transaction) measures each period on its
  measurement day -- enrolled students and opted-in students as of that day -- and **locks** it
  (`source = scheduled`). One locked row per period; nothing is measured for a locked period again. A
  measurement day more than 31 days back is locked only when a share waits for it (no back-measuring
  of old licences on deploy).
- Before the lock, the super admin can re-measure now, with a reason (`source = super_admin`,
  audited): a provisional figure; the lock still happens on the day.
- Enrolled = students with status `enrolled` who existed and were admitted by the end of the day.
- Opted in = **adapter** `countOptedInStudents(tx, schoolId, licenseId, onDate)` in
  `packages/billing/src/ai-revenue-share/measures.ts`. Until phase 2 is integrated: the licence's
  student seats held at the end of the day.

### The ledger (`app.ai_programme_revenue_share_entries`)

Recording a payment (the console's "Record a transfer") writes one entry per instalment it paid:
collected, the Student AI part (`base`), the period that instalment pays for (monthly: licence month k;
yearly: licence year k; at once: the term; custom: due date to the day before the next), the licence's
programme versions, commitment, conversion (locked snapshot), upload consistency over that period
(**adapter** `uploadConsistencyForPeriod(tx, { schoolId, licenseId, from, to })`, null until phase 4
is integrated, so the bonus stays pending), bonus, cap, multiplier, total and amount.

| Status       | Meaning                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `pending`    | conversion not locked or bonus not known: provisional, worked out again (each payment, the console's recompute, the hourly job) |
| `owed`       | final; to be credited on the school's next licence invoice                                                                      |
| `zero`       | final and 0 (under the first tier, month-to-month at 0%)                                                                        |
| `credited`   | an `ai_share_credit` line on the next invoice (`credit_invoice_id`)                                                             |
| `payout_due` | payout mode, or the licence ended with no open next invoice                                                                     |
| `paid_out`   | in a recorded payout (`app.ai_programme_revenue_share_payouts`, with the transfer reference)                                    |
| `forfeited`  | its instalment was not paid by its cutoff (decision 11, below)                                                                  |
| `void`       | its payment was voided before the share was given                                                                               |

The figures of a final entry never change and rows are never deleted (trigger). A pending entry keeps
the versions it was recorded under. A voided payment whose share was already credited or paid out gets
a `reversal` entry (negative), netted against the next credit or payout.

### Credit on the next invoice, payout

`app.settle_ai_revenue_share(as_of)` (SECURITY DEFINER, the armed school only; returns every change
for the caller to audit) runs after a payment is recorded or voided, after an invoice is issued
(including a school accepting a quote), on the console's recompute, and hourly:

1. **Forfeit** (below).
2. **Credit**: owed shares go on the school's open invoices issued after their own invoice, earliest
   first, never above an invoice's unpaid balance (reversals netted in first). The invoice gets an
   `ai_share_credit` line; `credit_total_minor` goes up and `total_minor` down; its unpaid instalments
   come down earliest first (an instalment taken to 0 is paid); its status, due date and overdue mark
   follow -- so the balance, reminders and the AI stop all use the reduced amounts. A credit that
   leaves a new licence's first instalment paid puts it in force (as a payment would). If that invoice
   is voided, its shares are owed again.
3. **Payout due**: what is still owed for a licence that has ended (expired or cancelled) has no next
   invoice: it becomes `payout_due`. The super admin records the payout (`POST .../payouts`, with the
   amount shown as a guard), audited.

### Forfeiture (decision 11)

An instalment is **forfeit** once it was not paid in full by its cutoff -- its due date + the
licence's `nonpayment_grace_days`, the day the lifecycle job stops the licence's AI for non-payment:
still unpaid on or after the cutoff, or settled by money received on or after it. Its shares not yet
given are forfeited: part payments made before the cutoff (`unpaid_at_cutoff`) and the late rest
(`late_payment`, recorded already forfeited). Nothing accrues on unpaid money anyway (shares are on
collected money only), shares already credited or paid out are not clawed back, and other periods'
shares are untouched. Decided on what is recorded when the cutoff passes.

### Integration (phases 2 and 4)

- `countOptedInStudents` and `uploadConsistencyForPeriod` in
  `packages/billing/src/ai-revenue-share/measures.ts` are the only two places to swap.
- `licenceCommitment` reads `school_licenses.commitment` through `to_jsonb` so it works before and
  after phase 2's column; read the column directly once it is there.
