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
