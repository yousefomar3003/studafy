# Student AI programme: settings and versions

Phase 1 of "Student AI seats bundled with tuition, plus revenue share" (approved 2026-11-17). Every
number in the programme is the super admin's to change, globally or per school, and licences keep
the values they were signed with. Migration 000234; pure rules in
`packages/license-pricing/src/ai-programme.ts`; API in `apps/api/src/modules/licensing/ai-programme*.ts`;
console page `/portal/platform/ai-programme`.

## The settings

| Setting                                                                            | Field                                         | Default                                                       | Unit                                       |
| ---------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| In-app purchase price (display and calculations only; the stores set the real one) | `iapPriceMinor`                               | 599 USD                                                       | minor units / student / month              |
| School licence price                                                               | `licensePriceMinor`                           | 400 USD                                                       | minor units / seat / month                 |
| School-offer price (the school tells parents; never shown in the app)              | `parentPriceMinor`                            | 400 USD                                                       | minor units / month                        |
| Minimum seats                                                                      | `minSeats`                                    | 30                                                            | seats                                      |
| Maximum revenue share                                                              | `maxShareBps`                                 | 1500                                                          | basis points                               |
| Conversion tiers (from -> share)                                                   | `conversionTiers`                             | 0->0, 2500->400, 4000->600, 5500->800, 7000->1000, 8500->1200 | bps                                        |
| Large-school floor                                                                 | `largeSchoolMinSeats` / `largeSchoolShareBps` | 500 seats / 800                                               | seats / bps (0 turns it off)               |
| Content-bonus tiers (upload consistency -> bonus)                                  | `contentBonusTiers`                           | 0->0, 6000->150, 8000->300                                    | bps                                        |
| Bonus only above a 0% conversion share                                             | `bonusRequiresConversionShare`                | true                                                          |                                            |
| Conversion measured after                                                          | `measurementOffsetDays`                       | 30                                                            | unused since 000250: conversion is monthly |
| Grace before Student AI stops                                                      | `nonpaymentGraceDays`                         | 30                                                            | days after an unpaid instalment's due date |
| Month-to-month licences earn                                                       | `monthToMonthShareBps`                        | 0                                                             | bps of the tier values (5000 = half)       |
| How the share is given                                                             | `payoutMode`                                  | `invoice_credit`                                              | `invoice_credit` or `payout`               |

**Owner's prices (2026-11-18).** Student AI bought in the app is $5.99 a month (the in-app purchase;
the App Store / Google Play price is the real one, this value is the reference). When the school
offers it, the price is the school-offer price Studafy sets -- $4 a month by default -- and **the
school tells parents that price, not Studafy**: no parent-facing API route, notification or app
screen carries it (or a total, or an amount). Schools, finance and the super admin see it on the web
so they can tell parents. With the defaults (parents $4, licence $4) the school keeps no margin and
earns only the revenue share, which is still calculated on what Studafy collects.

**Choice (2026-11-18).** A family may take Student AI through the school's offer or buy it in the
app at the store's price. A student **without** a school seat is always offered the in-app purchase,
even at a school with a licence or the programme. A student **with** a school seat (a licence in
force, or a programme opt-in holding a seat -- including one waiting for its licence to start) is
never sold it: `GET /api/subscriptions/ai/store/config` answers `covered_by_school` and the app shows
"Provided by <school>". A store purchase that races a seat assignment is not refused (the store has
taken the money): it is recorded and handled as a seat given to someone who already pays (an
overlap row; Google Play renewal cancelled; an App Store purchaser told to turn renewal off,
`LICENSE_SEAT_APPLE_RENEWAL`). The in-app purchase offer never mentions the school option.

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

- Read what a licence was signed with: `resolveAiProgrammeValues(tx, { versionId, overrideId },
currencyCode)` -- the core resolver (values only; `readProgrammeValues` in @studafy/billing), for
  school-facing requests and the workers -- or, in platform views only, `resolveAiProgrammeStamp`
  (which adds the versions and their authors' names, looked up by arming each super admin's home
  school) and `licenseAiProgramme(tx, license)`.
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
   job; no price) and see, per eligible child, "Student AI for <child> -- offered by your school":
   what it includes, the months it covers (the months left in the school's academic year), and the
   terms: committed for the school year, can't be cancelled mid-year, part of the school fees, and
   "your school will tell you the price". **No price, total or amount** is sent to a parent
   (`GET /api/parent/student-ai` carries status, child, school, window dates, months and terms
   version only) or shown in the app (store rules: a digital service sold outside in-app purchase
   is never priced in the app).
3. **A parent joins** (`studentAi:optIn`, PARENT only; never ORG_ADMIN): linked to the child,
   window open and including the child, terms accepted (`acceptTerms`, else 422
   `AI_OPTIN_TERMS_REQUIRED`) in their current version (`termsVersion` = `AI_OPTIN_TERMS_VERSION`,
   else 409 `AI_OPTIN_TERMS_CHANGED`). No price is echoed by the app; the server snapshots the
   price in force on the opt-in for billing and returns the opt-in without it. Recorded with who,
   when and the terms version.
   It cannot be undone. Parents with children at several schools have an account per school (the
   account switcher), so each school's offer is its own.
4. **Or the school records it on the parent's behalf** (single, bulk, or a CSV column of school
   admission numbers -- never a government ID), with a required note; same window, eligibility and
   price. Audited.
5. **Seats follow** (below). The child's parents get `AI_OPTIN_CONFIRMED`; school leadership gets a
   daily `AI_OPTIN_SUMMARY` of new opt-ins (16:00 UTC run).

**Late opt-in** is allowed while a window is open: priced for the remaining months only, starting
this month (`aiOptInPeriod`). Months always follow the school's academic year, counted by the one
month rule (`academicYearMonths` in `@studafy/license-pricing`: a calendar month counts when the year
covers at least half of it), the same months the tuition line and the revenue share's instalment
periods count.

**Opt-ins are per academic year.** Parents choose again each new year: a new year's window takes new
opt-ins, and a licence renewal (or a new licence) never carries last year's over.

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

## Revenue share engine (phase 5, migration 000237)

The share Studafy pays a school on what it actually collects for Student AI seats. Every number comes
from the programme values the licence carries (its signed version and override); nothing is
hard-coded.

### The calculation (`@studafy/license-pricing`, `revenue-share.ts`)

`computeRevenueShare(values, { conversionBps, uploadConsistencyBps, seats, commitment, baseMinor })`:

- **Conversion share**: the conversion tier of the month's locked conversion, raised to the
  large-school floor when the students the school provides Student AI to that month reach
  `largeSchoolMinSeats`.
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

One amount per ledger entry (a payment's part of one instalment for one month), so a licence's
total share can differ from the share of its total by at most half a minor unit per entry. The
worked example is a test: 350 of 500 (70% -> 10%) + uploads 85% (+3%) = 13% of $14,000 (= $4 x 350 x 10) = $1,820, as ten monthly shares of $182 whether paid monthly or at once; so is an 8-month school
at its own price.

**Monthly, approved (owner, 2026-11-18; migration 000250).** Conversion is measured every month;
every share is per month; and nothing is credited or paid out before a super admin approves it on
the school's weekly statement. See "Monthly conversion" and the `awaiting_approval` status below.

### Conversion snapshots (`app.ai_programme_conversion_snapshots`)

- A licence's **measurement periods are its months** (000250): every month it counts by THE month
  rule over its whole span, renewals included (an accepted extension moves its end). Measurement day =
  the month's first day, or the licence's first day in a month it starts inside
  (`conversionMeasureDay`). `measurementOffsetDays` is no longer used.
- The workers' hourly licence lifecycle job (step 6, its own transaction) measures each month on its
  measurement day -- enrolled students and Student AI holders as of that day -- and **locks** it
  (`source = scheduled`). One locked row per period; nothing is measured for a locked period again. A
  measurement day more than 31 days back is locked only when a share waits for it (no back-measuring
  of old licences on deploy).
- Before the lock, the super admin can re-measure now, with a reason (`source = super_admin`,
  audited): a provisional figure; the lock still happens on the day.
- Enrolled = students with status `enrolled` who existed and were admitted by the end of the day.
- Student AI holders = `countStudentAiHolders(tx, schoolId, licenseId, month, onDate)` in
  `packages/billing/src/ai-revenue-share/measures.ts` (stored as `opted_in_count`): enrolled students
  with a phase 2 opt-in covering the month (taken by the end of the day, not released from that
  month, not ended by then) **or** a student seat the school assigned and still held at the end of the
  day, each student once. A student's own in-app purchase is not a school seat and does not count.
  Only students counted as enrolled that day count, so conversion never passes 100%. Opt-ins are
  **per academic year**: parents choose again each new year.
- **Only licences in the programme earn a share**: a licence with at least one opt-in window or
  programme opt-in (`licenceInProgramme`). A licence without either gets no ledger entries and no
  conversion measurement. A payment recorded before the licence's first window opens earns nothing
  either (the test is made when the payment is recorded).

### The ledger (`app.ai_programme_revenue_share_entries`)

Recording a payment (the console's "Record a transfer") writes one entry per instalment it paid
**and month that instalment pays for** (000250: an instalment for several months -- yearly, at once,
custom -- is split by `monthSlices`: every whole month weighs the same, a part of a month its share
of the month's days, the money split exactly with `splitByWeight`; each month gets its own
conversion): collected, the Student AI part (`base`), the period that instalment pays for (monthly: the term's
k-th month by the one month rule -- `academicYearMonths`, a calendar month counts when the term covers
at least half of it, the same months the parent's opt-in and the tuition line count -- the first
stretched back to the term's start and the last on to its end; yearly: licence year k; at once: the
term; custom: due date to the day before the next), the licence's programme versions, commitment
(`school_licenses.commitment`, the one `LICENSE_COMMITMENTS` list), conversion (locked snapshot),
upload consistency over that period (`uploadConsistencyForPeriod`: phase 4's measure, once the
period's last day has passed in the school's timezone -- until then the bonus stays pending and the
hourly job works it out; a finished period with no class to measure is 0%), bonus, cap, multiplier,
total and amount.

| Status              | Meaning                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pending`           | conversion not locked or bonus not known: provisional, worked out again (each payment, the console's recompute, the hourly job) |
| `awaiting_approval` | final (`final_at`); waits for a super admin's approval on the school's weekly statement -- never credited or paid before        |
| `owed`              | approved; to be credited on the school's next licence invoice                                                                   |
| `zero`              | final and 0 (under the first tier, month-to-month at 0%)                                                                        |
| `credited`          | an `ai_share_credit` line on the next invoice (`credit_invoice_id`)                                                             |
| `payout_due`        | payout mode, or the licence ended with no open next invoice                                                                     |
| `paid_out`          | in a recorded payout (`app.ai_programme_revenue_share_payouts`, with the transfer reference)                                    |
| `forfeited`         | its instalment was not paid by its cutoff (decision 11, below)                                                                  |
| `void`              | its payment was voided before the share was given                                                                               |
| `rejected`          | a super admin rejected it (`rejected_at`): never given                                                                          |

A final share goes to `awaiting_approval` (or `zero`), never straight to owed or payout due.
Approving it (`approveShares`) makes it `owed`, or `payout_due` in payout mode; rejecting it
(`rejectShares`, with a reason) makes it `rejected`. Shares already final when 000250 applied (owed
or payout due, not yet given) were moved to `awaiting_approval`.

The figures of a final entry never change and rows are never deleted (trigger). A pending entry keeps
the versions it was recorded under. A voided payment whose share was already credited or paid out gets
a `reversal` entry (negative), netted against the next credit or payout.

### Credit on the next invoice, payout

`app.settle_ai_revenue_share(as_of)` (SECURITY DEFINER, the armed school only; returns every change
for the caller to audit) runs after a payment is recorded or voided, after an invoice is issued
(including a school accepting a quote), on the console's recompute, and hourly:

1. **Forfeit** (below) -- shares awaiting approval included.
2. **Credit**: owed (approved) shares go on the school's open invoices issued after their own invoice, earliest
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

Integrated on 2026-11-18 (feat/ai-revshare-settings): `countOptedInStudents` reads phase 2's
`app.ai_optins`, `uploadConsistencyForPeriod` reads phase 4's upload consistency (moved into
`packages/billing/src/ai-revenue-share/upload-consistency.ts` so the workers can measure too), and
`licenceCommitment` reads `school_licenses.commitment` directly.

- **Activation by a credit** (`packages/billing/src/ai-revenue-share/activation.ts`): one rule,
  `licencesToPutInForce`, decides which licences are now due to be in force (a draft or
  awaiting-payment licence with an invoice whose first instalment is paid, or paid in full; a licence
  stopped for non-payment with nothing past its cutoff; never while another licence is active). The
  API's settle (`settleShares`) puts them in force with `activateLicenseFor` / `resumeIfSettled`. The
  hourly job applies the same rule to invoices a credit went on and activates with `activateLicence`
  (status, audit, entitlements), except when a seat holder still pays personally: the overlap credit
  and renewal stop need the payment providers, so that licence is left to the API's next settle for
  the school (logged, `licensesAwaitingApiActivation`).
- **Concurrent payments**: recording or voiding a payment, and the hourly revenue share step, run
  again on a serialization failure or deadlock (`withTransactionRetry`, up to 3 tries).

## Dashboards (phase 6)

One read of a school's standing, `aiProgrammeDashboard` (`apps/api/src/modules/licensing/ai-dashboard.ts`),
serves every role; the pure figures are `@studafy/license-pricing` `ai-dashboard.ts`
(`conversionStanding`, `optInsToReach`, `contentBonusAimBps`, `studentAiMarginOf`, `paidPartOf`,
`studafyNetOf`). Values come from the core resolver `resolveAiProgrammeValues` on the licence's stamp.
The school's read runs as the system role armed for the caller's own school (aggregates over opt-ins
and tuition lines, which the runtime role's row policies show to leadership only); it carries no
student, parent or teacher names.

| Who (permission)                                         | Where                                                                                                                                      | What                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Super admin (`platform:read`, writes `platform:manage`)  | `/portal/platform/ai-programme/schools` (`GET /api/platform/ai-revenue-share/schools`)                                                     | Every school in the programme: opted in / enrolled, conversion in force (locked, re-measured or today's), uploads, share rate, the year's collected / pending / owed / credited / paid out / forfeited, Studafy's net in total and per seat. Sortable, filterable.        |
| Super admin                                              | `/portal/platform/ai-programme/schools/:schoolId` (`GET .../schools/{id}/ai-revenue-share/summary`, the ledger, licence and upload routes) | The same figures; conversion measurements with re-measure (reason) before the lock; the ledger by status with each share's working; recompute; payouts and recording one; upload consistency per teacher and class; links to the school's licence and programme settings. |
| Finance, school admin, principal (`aiRevenueShare:read`) | `/portal/finance/student-ai` (`GET /api/school/ai-revenue-share/summary` and `/api/school/ai-revenue-share`)                               | Owed and paid to Studafy (the licence's invoices); the share per period, collected -> conversion % + bonus % = total % -> amount, and where it went (credited on which invoice, paid out, forfeited); payouts; the year's earnings.                                       |
| School admin, principal (`license:read`)                 | `/portal/license/student-ai/results`, and a Student AI tile on both dashboards                                                             | Enrolled vs opted in, conversion and the tier it earns, "Add N more seats -> unlock X%" (and the large-school floor when it pays more, saying which is closer), the year's earnings, upload consistency per teacher and per class with those below the target marked.     |
| Parents                                                  | the app's Student AI line only (phase 3)                                                                                                   | Never the licence price, the share or the conversion: no route they hold returns them.                                                                                                                                                                                    |

**What "earnings" counts** (the school's, for the academic year covering today):

- Revenue share earned: the year's share entries (their period starts in the year) that are final:
  owed, credited, payout due or paid out. Pending shares are shown apart; forfeited ones never count.
- Margin on the Student AI line: per line, (the parent's monthly price, fixed on the line) - (the
  licence's price per seat per month, from the values it was signed with) x months. Knowable only
  from lines Studafy billed: for a line on the fee schedule, the months on ERPNext invoices, as far
  as the parent paid that invoice (pro rata for a part-paid one, from the invoice cache). A line the
  school bills itself (auto-billing off) is **estimated**: its months charged, as if paid in full.
- Total = share earned + margin collected + margin estimated; the page says when part is estimated.
- Studafy's net (console only): the year's Student AI part of what Studafy collected - the share
  (earned and pending), per licence student seat (half up). The worked example: $14,000 - $1,820 =
  $12,180, $34.80 a seat; on an 8-month year $11,200 - $1,456 = $9,744, $27.84 a seat.

**"Add N more seats -> unlock X%".** N = ceil(next tier's threshold x enrolled / 10,000) - opted in
(conversion rounds down, as the engine's). The next tier is the first above the current conversion
that pays more than the share now (tiers the large-school floor already beats are skipped). The
floor is offered when it pays more and the licence is below its seats: seats needed = its minimum minus the licence's seats.

**Teachers below target.** The target is the next content-bonus tier that pays something above the
school's upload consistency, or the top tier's threshold once the school is in it (60% / 80% with the
defaults).

**Payments before the licence entered the programme.** The programme gate is tested when a payment
is recorded, so a payment made before the licence's first opt-in window earned nothing. Opening the
first window now records those payments' shares (`recordEarlierPaymentShares` in `@studafy/billing`):
the licence's non-voided payments with no ledger entry, on invoices whose term starts in the current
licence period, each split over its instalments by replaying the invoice's payments in order -- as
`recordPayment` would have, pending or final, and forfeited when the money came after the
instalment's cutoff. New entries only; nothing is rewritten, and it is idempotent. It runs after the
window's transaction commits, as the system role (the ledger is never the school's to write); a
failure is logged at error level, and the console's recompute records whatever is missing.
