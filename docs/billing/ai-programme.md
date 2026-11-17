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

# Phase 2: opt-in and programme seats

Migrations 000235 (tables, rules) and 000239 (notification types). Pure pricing in
`packages/license-pricing/src/ai-optin.ts`; API in `apps/api/src/modules/licensing/ai-optin*.ts`;
workers `apps/workers/src/queues/billing/ai-optin-notices.ts`; web `/portal/license/student-ai`;
app `/parent/student-ai`.

## The flow

1. **The school opens a window** (ORG_ADMIN / PRINCIPAL, `license:manage`) on its current licence
   for an academic year (default: the current one), with school-local open and close dates and
   optionally some grades or sections only. It needs a licence that takes seats (active or awaiting
   payment) with a student tier, and a parent price in the licence's currency. The school must
   accept the programme's **minimum seats** (it pays for at least `minSeats` even if fewer opt in);
   when the licence has fewer seats, an automatic seat request is opened for Studafy to price. One
   window open at a time; a window past its last day closes when the next opens.
2. **Parents are told** (`AI_OPTIN_AVAILABLE`, in-app and push, once per child and window, hourly
   job) and see, per eligible child, "Student AI for <child>": the price parents see per month ×
   the months left in the school's academic year = total, paid with tuition, committed for the year.
3. **A parent opts in** (`studentAi:optIn`, PARENT only; never ORG_ADMIN): linked to the child,
   window open and including the child, terms accepted (`AI_OPTIN_TERMS_VERSION`), and the total
   they were shown (else `AI_OPTIN_PRICE_CHANGED`). Recorded with who, when and the terms version.
   It cannot be undone. Parents with children at several schools have an account per school (the
   account switcher), so each school's offer is its own.
4. **Or the school records it on the parent's behalf** (single, bulk, or a CSV column of school
   admission numbers -- never a government ID), with a required note; same window, eligibility and
   price. Audited.
5. **Seats follow** (below). The child's parents get `AI_OPTIN_CONFIRMED`; school leadership gets a
   daily `AI_OPTIN_SUMMARY` of new opt-ins (16:00 UTC run).

**Late opt-in** is allowed while a window is open: priced for the remaining months only, starting
this month (`aiOptInPeriod`). Months always follow the school's academic year.

## Seats

Each active opt-in holds a seat on its licence (`app.license_seats`, through `assignSeats`, so the
existing entitlement path unlocks Student AI). **The licence's seat count is never raised by an
opt-in** -- seats are what the super admin priced and the school accepted. When opt-ins need more
seats than the licence has, the opt-in is recorded and **waits** (`seat_id` null), and one open
`license_change_requests` row with `source = 'ai_optin'` asks for `max(minSeats, active opt-ins)`
seats (raised as more opt in). The super admin prices it as a seat-increase quote; on acceptance
(or a console seat change) waiting opt-ins get seats, oldest first (`fillWaitingOptInSeats`). A
student who already held a seat keeps it, now held by the programme.

**No removals.** A seat an active opt-in holds cannot be unassigned: the API answers 409
`LICENSE_SEAT_PROGRAMME_LOCKED` and the database refuses it (`trg_license_seats_programme_lock`).
The only exception is a student who has **left** (status graduated, withdrawn or archived):

- **Transfer**: the seat goes to another enrolled student without an opt-in, with no billing change
  (a `transfer` opt-in at the same monthly price, charged from the next month to the year's end; the leaver pays through this month).
- **Release**: no longer charged from the **next** month (`released_effective_month`); the seat frees
  now and goes to the next opt-in waiting for one.

## Data (000235)

| Table                                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ai_optin_windows`                                    | licence, academic year, `opens_on`/`closes_on` (school-local), note, opened/closed by and when. One not closed per school.                                                                                                                                                                                                                                                                                                                                  |
| `app.ai_optin_window_scopes`                              | the grades or sections a window is limited to (none: every enrolled student).                                                                                                                                                                                                                                                                                                                                                                               |
| `app.ai_optins`                                           | student, academic year, licence, window, `source` (parent, school_on_behalf, transfer), `parent_user_id`, `recorded_by`, note, `terms_version`, `opted_in_at`, `start_month`, `end_month`, `months`, currency, `monthly_price_minor`, `total_minor`, `seat_id`, `status` (active, released, transferred), ended by/at/note, `released_effective_month`, `transferred_to_id` / `transferred_from_id`, `admins_notified_at`. One active per student per year. |
| `app.ai_optin_window_notices`                             | the workers' availability notices, one per window and student.                                                                                                                                                                                                                                                                                                                                                                                              |
| `school_licenses.commitment`, `license_quotes.commitment` | `full_year` (default, every existing one) or `month_to_month`. New licences and extensions take the accepted quote's; a seat increase keeps the licence's.                                                                                                                                                                                                                                                                                                  |
| `license_change_requests.source`                          | `school` or `ai_optin`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

An opt-in never changes after it is written except: the seat is linked once; status leaves `active`
once (leadership only, restrictive UPDATE policy `ai_optins_end_scope`); leadership's summary marks
it. Never deleted (`trg_ai_optins_guard`). Reads: tenant isolation plus `role_scope_visibility`
(`app.can_read_ai_optin`): leadership sees all, a parent or the student only their own. Definer
helpers `app.ai_optin_seat_locked(seat)` and `app.ai_optin_license_counts(licence)` (counts only, so
a parent's opt-in can size the seat request).

## For later phases

- **Phase 3 (tuition line):** each active opt-in carries `monthly_price_minor × months =
total_minor` from `start_month` to `end_month`; a released one stops at
  `released_effective_month`; a `transfer` opt-in starts at its own `start_month`.
- **Phase 4 (conversion):** opted in = `ai_optins` with `status = 'active'` (or ended after the
  measurement date) per licence / academic year; enrolled = students `enrolled` (the window's
  eligibility, `eligibleIn` in ai-optin.ts).
- **Phase 5 (share):** `school_licenses.commitment`; programme seats billed per month = active seats
  plus released ones until their effective month.
