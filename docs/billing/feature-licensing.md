# Paid features and school licensing

The plan for Studafy's paid-features and school-licensing system, and the record of what each
session has built. **Later sessions read this document first**, then
[ADR-018](../adr/0018-feature-licensing.md) for the reasoning behind the foundation.

Paid features are sold two ways:

- **to individuals**: in-app purchases (App Store, Google Play) and web purchases (Tap, Stripe), as
  the AI add-on is sold today;
- **to schools**: a seat-based license that the super admin manages and the school pays by bank
  transfer.

## The rule every feature follows

A future paid feature plugs in with three changes and nothing else. No migration, no billing change
and no admin-page change is needed per feature.

1. **Register it.** Add one entry to `FEATURES` in
   [`packages/constants/src/features.ts`](../../packages/constants/src/features.ts): key, audience
   (`student` | `teacher` | `parent`), usage unit (or `null`), default monthly limit (or `null` for
   unlimited) and i18n name key. The API inserts the key into `app.features` at its next boot.
2. **Guard its routes.** Put `requireFeature("<key>", { meter })` on each API route
   ([`apps/api/src/modules/features/middleware.ts`](../../apps/api/src/modules/features/middleware.ts)).
   `meter` is how many units the request uses (omit it for routes that are checked but not counted).
3. **Check it in the app.** Read `GET /api/me/features` and show, hide or upsell the feature.

Then the super admin adds the feature to tiers in the console (session 4). A tier with
`includes_all_features` picks it up immediately at the code's default limit.

```ts
// A route file, once the feature exists:
routes.use("/api/notebook/:lessonId/pages", requireFeature("notebook", { meter: 1 }));
```

## Features

| Key            | Audience | Unit        | Default monthly limit | Status                                                                   |
| -------------- | -------- | ----------- | --------------------- | ------------------------------------------------------------------------ |
| `ai_tutor`     | student  | messages    | 300                   | Built: ask, generate, search                                             |
| `study_tools`  | student  | generations | 100                   | Built: summaries, key concepts, explanations, quizzes, flashcards, exams |
| `notebook`     | student  | pages       | 50                    | Registered only                                                          |
| `auto_grading` | teacher  | submissions | 500                   | Registered only                                                          |
| `family_plus`  | parent   | none        | unlimited             | Registered only                                                          |

The default limit applies only where a tier includes a feature without stating its own limit. Every
existing AI subscriber is on the `ai_addon` tier, whose limits are unlimited (see
[Compatibility](#compatibility-with-the-ai-add-on)).

## Decisions

These are the product decisions the whole system is built to. Sessions 2–6 implement them; they are
not reopened without the product owner.

### Seats

- A license has a **seat count per audience** (students, teachers, parents) and a **tier per
  audience**.
- The school assigns seats to specific people: individually, or in bulk by grade, section or class,
  or "everyone" while seats last. The school can unassign or reassign.
- **Only assigned people are covered.** Being in the school is not enough.
- **Assigned seats can never exceed purchased seats.** This is enforced in the database, not only in
  the API.
- The super admin can also assign seats.

### Family+

- The school chooses **per license** whether to include Family+ (parent seats).
- When included, the school assigns parent seats. A covered parent gets Family+ **for their children
  at that school only**.
- Children at other schools still need the parent's own Family+.

### Tiers

- Features are sold in **tiers per audience** (for example Student Basic / Plus / Pro).
- The super admin defines tiers: which features, at what limits, at what price.
- There is **no picking of single features** per school. A school buys tiers.

### People who already pay personally and then receive a school seat

1. **Access is the best of both, feature by feature** (already implemented by the resolver).
2. **The school pays less for that seat** until the personal subscription's period ends: a
   **prorated credit for the overlapping days**, shown as its own invoice line.
3. **Renewal of the personal subscription is turned off** so the person never pays twice:
   - Tap and Stripe: cancel at period end.
   - Google Play: cancel through the Play Developer API
     (`purchases.subscriptions.cancel`, added to
     [`store/google.ts`](../../apps/api/src/modules/subscriptions/store/google.ts) in session 2).
   - Apple: renewal cannot be stopped from our server. Notify the user in the app with instructions
     to turn it off in their Apple ID settings.
   - No automatic refunds.
4. When the personal subscription ends, the person continues on the school seat **with no gap**,
   and the school pays **full price** for that seat from then on.

### Payment for licenses (bank transfer)

1. Quote.
2. Invoice, with the platform's bank details and a **unique payment reference**.
3. The school transfers and **can upload a receipt**.
4. The super admin records the payment: amount, date, bank reference, receipt. **Partial payments
   are allowed** and the balance is tracked.
5. The license activates when **fully paid**, OR the super admin **activates it early** with a
   payment due date.

Overdue invoices trigger reminders. **Suspension is a manual super admin decision, never
automatic.**

### Pricing

- Each tier has a **price per seat per month, per currency** (the existing `app.currencies`).
- **Volume discount brackets** by seat count, editable by the super admin (for example 1–99: 0%,
  100–499: 10%, 500+: 20%).
- **Duration discounts** (for example 12 months: 10%, 24 months: 15%).
- The **overlap credit** (above).
- A **manual adjustment** with a **mandatory reason**.

The super admin's calculator turns these into a quote for the school.

## Session plan

| Session | Scope                                                                                                                                            | Status   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 1       | Foundation: feature list, tiers, personal subscriptions table, usage meters, resolver, `requireFeature`, `GET /api/me/features`, AI routes moved | **Done** |
| 2       | Licenses, seats and seat assignment; overlap with personal subscriptions                                                                         | **Done** |
| 3       | Pricing calculator, quotes, invoices, bank-transfer payments, expiry and reminder jobs                                                           | **Done** |
| 4       | Super admin web UI                                                                                                                               | **Done** |
| 5       | School admin web UI                                                                                                                              | **Done** |
| 6       | Web and mobile feature gating for students, teachers and parents                                                                                 | **Done** |

## What session 1 built

### Data model (migrations 000161, 000162)

| Table / object                                      | Scope     | Purpose                                                                                                                                                                                                                                           |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.features`                                      | global    | One row per registered key: `display_name`, `status` (`active` / `paused` / `hidden`). Synced from code at boot, insert-only, never deleted.                                                                                                      |
| `app.plans` + 3 columns                             | global    | A plan with an `audience` is a **tier**. `rank` orders Basic < Plus < Pro within an audience (unique among active tiers). `includes_all_features` makes a top tier pick up features registered later. School plans (`free`) keep `audience` NULL. |
| `app.plan_features`                                 | global    | `(plan_id, feature_key, monthly_limit)`. NULL limit is unlimited.                                                                                                                                                                                 |
| `app.user_subscriptions`                            | tenant    | A personal purchase of a tier by any user: provider (`app_store` / `google_play` / `tap` / `stripe`), status (`app.subscription_status`), period, `auto_renew`, `provider_reference`.                                                             |
| `app.feature_usage_meters`                          | tenant    | Units used per `(school, user, feature, calendar month)`.                                                                                                                                                                                         |
| `app.entitlement_subject`                           | enum      | Gains `user`: the version counter for one person's grants.                                                                                                                                                                                        |
| `app.student_user_id()`, `app.user_student_id()`    | functions | SECURITY DEFINER id mappings, so the userless resolver can map a student to their user and back under the students table's role-scope policy.                                                                                                     |
| `idx_outbox_events_school_user_entitlement_pending` | index     | The workers invalidator's claim path for `userEntitlement.changed` (000162, built concurrently).                                                                                                                                                  |

The existing `ai_addon` plan is now the first student tier (rank 1) and includes `ai_tutor`,
`study_tools` and `notebook` with **no unit limit**.

### Who has what: the resolver

`FeatureService.resolveFeatures(schoolId, userId)`
([`modules/features/service.ts`](../../apps/api/src/modules/features/service.ts)) returns, for every
feature:

```ts
{ active, source: "purchase" | "school_license" | "trial" | null, sources, limit, used, periodEnd, reason }
```

- **Rule:** the school is active AND some live grant covers the person with a tier that includes the
  feature.
- **Several grants:** the person gets the best of them, feature by feature: active if any grant
  includes it, the **highest limit** (unlimited beats any number), the **latest period end**. Every
  contributing grant is listed in `sources`; `source` and the period are those of the latest-ending
  one.
- **`reason`:** `school_inactive`, `paused` (super admin kill switch), `not_included`, `expired` (a
  grant included it and has ended), or `limit_reached` (still active, this month's units used up).
- **Grants** come from adapters in
  [`modules/features/grants.ts`](../../apps/api/src/modules/features/grants.ts):
  `aiAddonGrants` (`app.ai_subscriptions`), `userSubscriptionGrants` (`app.user_subscriptions`)
  and, since session 2, `licenseSeatGrants` (`app.license_seats`). `trialing` reports
  `source: "trial"`. A grant is live when its status
  is in `LIVE_STATUSES` (trialing, active, past_due, grace_period), exactly as the AI add-on is today.
- The merge itself is pure ([`modules/features/resolve.ts`](../../apps/api/src/modules/features/resolve.ts))
  and unit-tested.

**Caching.** Every grant read goes through the ST-133 entitlement service, so it is served from the
version-guarded Redis cache and changes apply immediately:

| Key                  | Holds                                           | Invalidated by                  |
| -------------------- | ----------------------------------------------- | ------------------------------- |
| `ent:{schoolId}`     | the school (active, plan)                       | `subscription.statusChanged`    |
| `ent:ai:{studentId}` | the AI add-on (now also the student's user id)  | `aiSubscription.statusChanged`  |
| `ent:usr:{userId}`   | the person's other grants, and their student id | `userEntitlement.changed` (new) |

The AI and user entries are trusted only against the school version in force, so a school change
that touches no grant still takes effect. The catalog (features + tiers) is global and cached per
process for 30 seconds: a tier or status edit reaches every pod within that window.

**Every writer of a grant must call `publishUserEntitlementChange(tx, { schoolId, userId })`** in the
transaction that writes the grant. It bumps the person's `user` version and emits
`userEntitlement.changed`; the API subscriber and the workers invalidator then floor
`ent:usr:{userId}`.

### Enforcing it: `requireFeature`

```
requireFeature(key, { meter?, subject?, codes? })
  1. school active                   -> 403 AI_SCHOOL_INACTIVE (today's code and status)
  2. feature active for the person   -> 402 FEATURE_NOT_INCLUDED | FEATURE_EXPIRED
  3. `meter` units within the month  -> 429 FEATURE_LIMIT_REACHED, Retry-After: next 1st (UTC)
```

- Units are consumed **before** the handler with one conditional upsert, so concurrent requests can
  never pass the limit (integration-tested with 20 concurrent requests). They are **given back** if
  the handler fails or answers 4xx/5xx.
- Usage resets on the **1st of the calendar month, UTC**, whatever the grant's billing period: a
  person can hold several grants with different periods, and a license can run for years.
- The verdict is left on the context (`getFeatureGate(c)`) for what runs after it.
- The service is put on every `/api` request by `provideFeatures` in `app.ts`, so a route only names
  its feature.

### The AI routes

The ST-155 AI entitlement gate is gone. Each AI route now carries `requireFeature` and then
`aiTokenBudget()` ([`modules/ai/gate/token-budget.ts`](../../apps/api/src/modules/ai/gate/token-budget.ts)),
which keeps the monthly AI token budget exactly as it was. The consent gate is unchanged and still
runs first.

| Route (`/api/ai/students/{studentId}/…`)                                                         | Feature       | Units                          |
| ------------------------------------------------------------------------------------------------ | ------------- | ------------------------------ |
| `ask`, `generate`                                                                                | `ai_tutor`    | 1                              |
| `search`                                                                                         | `ai_tutor`    | 0 (the tutor's retrieval step) |
| `summarize`, `concepts`, `explain`                                                               | `study_tools` | 1                              |
| `quizzes`, `decks`, `exams` (generate)                                                           | `study_tools` | 1                              |
| `quizzes/{id}/grade`, `decks/{id}/review`, `exams/{id}`, `exams/{id}/start`, `exams/{id}/submit` | `study_tools` | 0                              |

`/api/ai/usage` reports the token budget of whichever AI feature is active. Consent, reporting,
moderation and metrics are not behind `requireFeature`, as they were not behind the old gate.

### Compatibility with the AI add-on

Existing AI subscribers keep exactly the same access and quotas:

- **Access:** the `ai_addon` tier includes both AI features, a grant is live on exactly the statuses
  the old gate accepted, and the school rule is the same AND. A test runs every school state × every
  add-on status through the new chain and asserts the old answer (`token-budget.test.ts`), and an
  integration test checks the resolver against `resolveAiEntitlement` on real rows.
- **Quotas:** unit limits on the `ai_addon` tier are unlimited, so the token budget remains the only
  quota. The token budget keys on the add-on's own billing window, so the Redis counter key, budget
  and hold sizes are identical and in-flight counters carry across the deploy.
- **Subject:** the AI routes resolve the **student in the path**, not the caller, as the old gate did.
- **Error codes:** the AI routes keep answering `402 AI_SUBSCRIPTION_INACTIVE` (instead of
  `FEATURE_NOT_INCLUDED` / `FEATURE_EXPIRED`) and `403 AI_SCHOOL_INACTIVE`, because the mobile app
  in the stores maps those codes to its paywall states. This mapping (`AI_REFUSAL_CODES`) is removed
  in session 6, once the minimum supported app version reads the `FEATURE_*` codes.
  `FEATURE_LIMIT_REACHED` is new on these routes but cannot occur for an `ai_addon` subscriber.

### `GET /api/me/features`

Every feature with the caller's verdict: `key`, `name` (the super admin's display name), `nameKey`,
`audience`, `unit`, `active`, `source`, `sources`, `limit`, `used`, `periodEnd`, `reason`. A
feature the super admin has **hidden** is listed only to people who hold it.

## What session 2 built

### Data model (migrations 000163, 000164)

| Table / object                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.school_licenses`                                | One license: `status` (draft, awaiting_payment, active, expired, cancelled, suspended), `starts_at`/`ends_at`, a tier (`*_plan_id`) and seat count per audience (parents only with `include_family_plus`), `currency_id`, `notes`, `created_by`, `activated_at`. At most one active per school (`uq_school_licenses_one_active`). A trigger checks every tier is a tier of its audience. |
| `app.license_seats`                                  | One seat: `(school, license, audience, user)`, `student_id` for student seats, `assigned_at`/`assigned_by`/`assigned_by_platform`, `unassigned_at`/`unassigned_by`. One active seat per person per audience per license. A seat can only ever be unassigned (trigger); history is the table.                                                                                             |
| `app.license_seat_overlaps`                          | A seat given to someone who pays personally: which personal subscription, provider, overlap period and days, the tier's monthly seat price, the daily price, the credit (minor units), and the renewal action and its status. Session 3 invoices from it.                                                                                                                                |
| `app.license_change_requests`                        | The school asks the super admin for different seat totals and/or Family+, with a note; the super admin resolves or declines.                                                                                                                                                                                                                                                             |
| `app.ai_subscriptions.cancel_at_period_end`          | Renewal off for an AI add-on. The Tap renewal worker now honours it (it lets the period end instead of charging).                                                                                                                                                                                                                                                                        |
| `app.license_seat_eligible(audience, user, student)` | The one eligibility rule (see below), used by the seat trigger and the eligible-people list.                                                                                                                                                                                                                                                                                             |
| `app.ai_store_purchases(student_ids)`                | Which AI add-ons were bought in an app store, and the store reference (from `app.billing_events`, which is admin-only).                                                                                                                                                                                                                                                                  |
| `LICENSE_SEAT_APPLE_RENEWAL`                         | Notification type (000164) with en/ar templates.                                                                                                                                                                                                                                                                                                                                         |

**Enforced by the database**, so they hold for every writer and under concurrency:

- **Seat cap.** `trg_license_seats_before_insert` locks the license row (`FOR UPDATE`) and counts
  the active seats of the audience before every insert; two transactions racing for the last seat
  serialize on that lock and the second is refused (`ck_license_seats_capacity`). A license update
  that would drop a seat count below the seats assigned is refused
  (`ck_school_licenses_seats_assigned`). Tested with raw concurrent inserts and with two concurrent
  service calls.
- **Eligibility.** A student seat needs an `enrolled` student whose record is the seat's
  `student_id`; a teacher seat an `active` or `on_leave` teacher; a parent seat a user linked to an
  enrolled student of the school; every holder a user of the school with status `invited` or
  `active` (`ck_license_seats_eligible`).
- **Open license.** Seats are added only on draft, awaiting-payment or active licenses.

Trigger refusals carry their constraint name and are mapped to coded errors in
[`modules/licensing/context.ts`](../../apps/api/src/modules/licensing/context.ts).

### Resolver

`resolveUserEntitlement` also reads the person's assigned seats on licenses that have been in force
(active, suspended, expired, cancelled), cached with their subscriptions under `ent:usr:{userId}`.
`licenseSeatGrants` turns each into a grant of the license's tier for the seat's audience over the
license period:

| License                         | Grant                                                      |
| ------------------------------- | ---------------------------------------------------------- |
| active, inside its period       | live (`source: "school_license"`)                          |
| active, past `ends_at`          | ended (`FEATURE_EXPIRED`), even before the expiry job runs |
| active, not started             | none (the license covers nobody yet)                       |
| suspended / expired / cancelled | ended                                                      |
| draft / awaiting payment        | not read                                                   |

Grant adapters now receive the clock, so a cached entry stops covering exactly at the end date. The
best-of-both merge with personal subscriptions is unchanged from session 1.

**Family+** is per school by construction: users, students, parent links and seats are all keyed by
school, so a parent with children at two schools has an account at each, and a Family+ seat at one
school does not cover the account at the other (integration-tested).

**Propagation.** Every change that alters coverage bumps `entitlement_versions` and emits
`userEntitlement.changed` in its transaction: each seat assigned or unassigned bumps its holder; a
status change, tier or Family+ change or extension of a license in force bumps every seat holder
(`publishUserEntitlementChanges`, one statement). After commit the flow also floors the changed
`ent:usr:*` entries directly when Redis is configured, ahead of the outbox invalidators.

### Overlap with personal subscriptions

When a seat starts covering someone (assigned on an active license, or every seat when a license is
activated or resumed), [`modules/licensing/overlap.ts`](../../apps/api/src/modules/licensing/overlap.ts)
looks for their live personal subscriptions of the seat's audience. These are both
`app.user_subscriptions` and the per-student AI add-on (`app.ai_subscriptions`), since every
personal purchase so far is an add-on. For each one it does three things:

1. **Records the credit:** overlap = from max(now, license start) to min(personal period end,
   license end), whole days rounded up; daily price = the tier's monthly seat price in the license
   currency (`app.plan_prices`, monthly) × 12 / 365; credit = days × daily, rounded to the minor
   unit. A trial earns no credit. A tier without a price in that currency records the days with a
   NULL amount, for session 3 to price.
2. **Turns renewal off**, by provider:

   | Provider    | How it is identified                                                 | Action                                                             |
   | ----------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
   | Stripe      | `provider`, or `ai_subscriptions.stripe_subscription_id`             | `scheduleCancellation` after commit, then the local flag           |
   | Tap         | `provider`, or `ai_subscriptions.tap_payment_agreement_id`           | the local flag only: our own renewal worker reads it               |
   | Google Play | `provider`, or the add-on's billing event (`app.ai_store_purchases`) | `purchases.subscriptions.cancel` after commit, then the local flag |
   | App Store   | `provider`, or the add-on's billing event                            | in-app notification with instructions; nothing else changes        |

   The local flag is `user_subscriptions.auto_renew = false` or
   `ai_subscriptions.cancel_at_period_end = true`. A provider failure is recorded on the overlap
   (`renewal_status = failed`, `renewal_error`) and does not undo the seat.

3. **Writes audit rows** for the overlap insert and for each flag change (old and new values).

Unassigning a seat never touches the personal subscription; the overlap row stays for the invoice.

### APIs

School (`license:read` to read, `license:manage` to change; ORG_ADMIN and PRINCIPAL):

| Route                                       |                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/school/license`                   | The current license (active, else awaiting payment, else the latest suspended/expired/cancelled): tier, purchased and assigned seats per audience, dates, Family+, this month's usage per feature over the seat holders, open change requests                     |
| `GET /api/school/license/seats`             | Seats, filtered by audience and status, searchable, paged; each with its overlap, if any                                                                                                                                                                          |
| `POST /api/school/license/seats`            | Assign: `userIds`, or a `scope` (`grade` / `section` of the active academic year, `class`, `all`), filled in name order until seats run out. Result: `assigned`, `notAssigned` with reasons (`already_assigned`, `not_eligible`, `no_seats_left`), `renewalStops` |
| `DELETE /api/school/license/seats/{seatId}` | Unassign                                                                                                                                                                                                                                                          |
| `GET /api/school/license/eligible`          | People of an audience without a seat (optionally in a grade, section or class), with `hasPersonalSubscription`                                                                                                                                                    |
| `POST /api/school/license/change-requests`  | Ask the super admin for seat totals / Family+, with a note                                                                                                                                                                                                        |

Super admin (`platform:read` / `platform:manage`, web channel), under
`/api/platform/schools/{schoolId}/`:

| Route                                                               |                                                                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET`, `POST licenses`                                              | List; create a draft                                                                                                       |
| `GET`, `PATCH licenses/{licenseId}`                                 | Read; edit (everything while draft or awaiting payment; tiers, seats, Family+ and notes while active or suspended)         |
| `POST licenses/{licenseId}/status`                                  | `awaiting_payment`, `draft`, `active` (activate or resume), `suspended`, `cancelled`; `allowedTransitions` lists the moves |
| `POST licenses/{licenseId}/extend`                                  | Move the end date later                                                                                                    |
| `GET`, `POST licenses/{licenseId}/seats`, `DELETE …/seats/{seatId}` | Seats on the school's behalf                                                                                               |
| `GET license-requests`, `POST license-requests/{requestId}/resolve` | The school's change requests                                                                                               |

Super admin writes are audited twice (system actor in the school, operator in their home school),
the platform console's convention.

## How session 3 plugged in (session 2's notes)

- **Invoice credit lines** come from `app.license_seat_overlaps` (`credit_minor`, `currency_id`),
  one line per row; rows with a NULL credit need the new pricing tables to price them.
- **Expiry job:** set `status = 'expired'` past `ends_at` and call
  `publishUserEntitlementChanges` for the seat holders (coverage already stops at `ends_at`).
- **Activation on payment** is `transitionLicense(..., "active")`: overlaps and renewal stops come
  with it.
- **Failed renewal stops** (`renewal_status = 'failed'`) need a retry action in the console
  (session 4).

## What session 3 built

### Pricing: `@studafy/license-pricing`

A pure package ([`packages/license-pricing`](../../packages/license-pricing)), like the grading
engine: no database, no clock. `calculateLicensePrice(input)` is the one place a seat price is
multiplied; the console's calculator, quotes and invoices all go through it.

**Input:** currency; term in whole `months` (1-120, picks the duration discount); optional
`prorateDays` (charge by the day instead, for the rest of a term); Family+; per audience the tier,
the seats charged, the list price per seat per month and optionally `volumeSeats` (the count that
picks the volume bracket); the price settings; overlap credits; a manual adjustment with a reason.

**Output:** a line per audience (list amount, volume and duration discount in basis points and minor
units, line amount, price per seat-month before and after, savings, and the **next volume bracket**:
how many seats to add to reach it and the price per seat there), a line per credit, the adjustment
line, and the totals (`listTotalMinor`, `discountTotalMinor`, `seatsSubtotalMinor`,
`creditTotalMinor`, `adjustmentMinor`, `totalMinor`, `savingsMinor`, `savingsBps`).

**Rounding rules.** Money is whole minor units of the currency throughout; products are taken in
BigInt; every division rounds once, half up:

1. list amount = list price × seats × months; prorated, list price × seats × days × 12 / 365
   (session 2's daily rate);
2. volume discount = list amount × volume bps / 10 000;
3. duration discount = (list amount − volume discount) × duration bps / 10 000 — the two compound;
4. line amount = list amount − both discounts (so lines always add up exactly);
5. credits come off the seats subtotal in order and never take it below zero (a credit with no
   room left shows its full value and an applied amount of 0);
6. the adjustment is added (either sign); a total below zero is refused.

The displayed price per seat-month is the line amount ÷ (seats × months), rounded; the line amount is
what is charged.

**Brackets.** Volume brackets are `{ audience | null, minSeats, discountBps }`: the highest threshold
at or below the seat count applies. An audience with brackets of its own uses only those; the others
use the `null` ones. `volumeBasis` says what is counted: each audience's seats (`per_audience`) or
the license's total (`overall`). Duration discounts are `{ minMonths, discountBps }`, highest
threshold at or below the term. A "next bracket" at the same rate is skipped (it is not a better
offer). Worked examples, with bracket edges at 99/100, 499/500, 11/12 and 23/24 months, are the
package's tests.

### Data model (migrations 000165, 000166)

| Table / object                     | Scope              | Purpose                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.license_price_settings`       | global, admin-only | Per currency: `volume_basis`.                                                                                                                                                                                                                                                                     |
| `app.license_price_brackets`       | global, admin-only | The currency's volume (`threshold` = seats, optional audience) and duration (`threshold` = months) brackets, `discount_bps` 0-10 000. One per (currency, kind, audience, threshold).                                                                                                              |
| `app.license_invoice_counters`     | global, admin-only | Gapless invoice numbers per year, via `app.next_license_invoice_number(issue_date)` (SECURITY DEFINER): `LIC-2026-000042`.                                                                                                                                                                        |
| `app.license_quotes`               | tenant             | `kind` (`new`, `seat_increase`, `extension`), the license it prices, `status` (draft, sent, accepted, expired, withdrawn), the period, months, `prorate_days`, the resulting tiers and seat totals, adjustment, totals, `breakdown` (the calculator's result, JSONB), `priced_at`, `valid_until`. |
| `app.license_invoices`             | tenant             | Number (unique), `payment_reference` (unique, `STF-XXXX-XXXX`), license, quote (one invoice per quote), issue and due dates, subtotal, credits, adjustment, total, `paid_minor`, `balance_minor` (generated), status (issued, partially_paid, paid, void), `overdue_at`, void reason.             |
| `app.license_invoice_lines`        | tenant             | Seats per audience (all the calculator's figures), `overlap_credit` (one `license_seat_overlaps` row each), `adjustment`.                                                                                                                                                                         |
| `app.license_payments`             | tenant             | A bank transfer: amount, received at, bank reference, method `bank_transfer`, optional receipt file, recorded by, note; voided with a reason, never deleted (a trigger allows nothing but the one void).                                                                                          |
| `app.license_payment_receipts`     | tenant             | A receipt the school uploaded (file, note, uploaded by), `pending` until matched to a payment.                                                                                                                                                                                                    |
| `app.license_reminders`            | tenant             | Which reminder (kind, subject) the workers have sent; makes each go out once.                                                                                                                                                                                                                     |
| `license.bank.*` platform settings | global             | Bank name, account name, IBAN, SWIFT, currency: written by the console (`PUT /api/platform/licenses/bank-details`), printed on every invoice. `license.quote_validity_days` (30) and `license.invoice_due_days` (30) are seeded.                                                                  |
| 4 notification types (000166)      | enum               | `LICENSE_EXPIRING`, `LICENSE_INVOICE_DUE`, `LICENSE_INVOICE_OVERDUE`, `LICENSE_RECEIPT_UPLOADED`, en/ar templates.                                                                                                                                                                                |

The CHECKs make an inconsistent invoice unstorable whoever writes it: `total = subtotal − credits +
adjustment`, `0 ≤ paid ≤ total`, and the status is the one the amounts imply (issued: nothing paid;
partially_paid; paid: all of it; void: nothing paid). A school (studafy_app) reads its quotes,
invoices, lines, payments and receipts, may accept a quote (update it, insert the invoice and lines)
and insert receipts; it cannot record or change payments or read the price list. Every change is
audited (the console's two rows for a super admin; price settings and bank details in the
operator's home school).

### The flow

1. **Quote.** The super admin prices terms (`POST /api/platform/licenses/quote` previews without
   saving) and saves a draft:
   - `new`: a term from `startsAt` for `months`, for a draft or awaiting-payment license, or a new
     license on acceptance;
   - `seat_increase`: the license's new seat totals; the added seats are charged by the day for the
     rest of the term, at the volume bracket of the **new total** and the duration discount of the
     license's term;
   - `extension`: `months` more at the license's seats and tiers.

   Every open overlap credit of the school in the quote's currency becomes a credit line (unless
   `includeOverlapCredits: false`); one recorded without an amount is priced now at days × monthly
   price × 12 / 365.

2. **Send.** The quote is valid for `license.quote_validity_days`. The school sees sent, accepted and
   expired quotes — never drafts or withdrawn ones.
3. **Accept** (the school, `license:manage`, or the super admin for the school, even a draft): in one
   transaction the license is created (awaiting payment) or its terms set, seats added, or end date
   moved; the invoice is issued from the quote's lines, due after `license.invoice_due_days`.
   Refused when the quote has expired, when its license changed after it was priced, or when another
   invoice has claimed its credits in the meantime (`LICENSE_QUOTE_STALE`: price a new one). An
   invoice with nothing to pay is issued paid and activates the license.
4. **Pay.** The school transfers with the payment reference and may upload the receipt. The super
   admin records each transfer (partial payments allowed, never above the balance), optionally
   matching a receipt or attaching a file of their own. When the invoice is paid in full the license
   activates — if it is not active yet and the school has no other active license.
5. **Early activation.** The super admin can activate before payment with the date payment is now
   due; the invoice stays open.
6. **Voids.** A payment is voided with a reason: the balance and status follow, a receipt matched to
   it returns to pending, the license is untouched. An invoice with no payments can be voided; its
   overlap credits become available to the next quote.

Nothing suspends a license automatically. Suspension stays the super admin's decision
(`POST .../licenses/{licenseId}/status`).

### APIs

School (`license:read` to read, `license:manage` to accept and upload; ORG_ADMIN and PRINCIPAL):

| Route                                                    |                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/school/license/quotes`, `…/{quoteId}`          | Sent, accepted and expired quotes, with the breakdown                                                                                                                          |
| `POST /api/school/license/quotes/{quoteId}/accept`       | Accept: applies it and issues the invoice                                                                                                                                      |
| `GET /api/school/license/invoices`, `…/{invoiceId}`      | Invoices (filter `status`: all, issued, partially_paid, paid, void, unpaid, overdue); one with lines, payments, receipts, the bank details and the payment reference           |
| `POST /api/school/license/invoices/{invoiceId}/receipts` | Upload a receipt: the file goes first through `POST /api/storage/uploads/request-upload` (content class `license.receipt`: PDF, JPEG, PNG, 10 MiB), then its `storageKey` here |
| `GET /api/school/license/payments`                       | Payment history, voided ones included                                                                                                                                          |
| `GET /api/school/license/receipts/{receiptId}/file`      | A short-lived download URL                                                                                                                                                     |

Super admin (`platform:read` / `platform:manage`, web channel):

| Route                                                                                                       |                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/platform/licenses/price-settings`, `PUT …/price-settings/{currencyCode}`                          | Price settings per currency                                               |
| `GET`, `PUT /api/platform/licenses/bank-details`                                                            | The bank details on invoices                                              |
| `POST /api/platform/licenses/quote`                                                                         | The calculator (with `schoolId`: that school's license and credits)       |
| `GET /api/platform/licenses/invoices`                                                                       | Across schools: `status` (as above), `schoolId`, `from`/`to` issue dates  |
| `GET /api/platform/licenses/receipts`                                                                       | Receipts waiting to be matched, across schools                            |
| `GET /api/platform/licenses/finance`                                                                        | Per currency: received this month, outstanding, overdue; pending receipts |
| `GET`, `POST /api/platform/schools/{schoolId}/license-quotes`; `GET`, `PUT …/{quoteId}`                     | Quotes; `PUT` re-prices a draft                                           |
| `POST …/license-quotes/{quoteId}/send`, `/accept`, `/withdraw`                                              |                                                                           |
| `GET /api/platform/schools/{schoolId}/license-invoices/{invoiceId}`, `POST …/void`, `POST …/activate-early` |                                                                           |
| `POST …/license-invoices/{invoiceId}/payments`, `POST …/license-payments/{paymentId}/void`                  | Record and void payments                                                  |
| `POST …/license-payments/upload-url`, `GET …/license-payments/{paymentId}/receipt-file`                     | The super admin's own receipt files                                       |
| `POST …/license-receipts/{receiptId}/match`, `GET …/license-receipts/{receiptId}/file`                      | Match a school's receipt to a payment                                     |

### Jobs (apps/workers, billing queue)

| Job                      | When                 | Does                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run-license-lifecycle`  | hourly at :05 UTC    | Active or suspended licenses past `ends_at` → `expired`, bumping each seat holder's `user` version with `userEntitlement.changed`; sent quotes past `valid_until` → `expired`; unpaid invoices past their due date → `overdue_at`.                     |
| `run-license-reminders`  | hourly at :20 UTC    | In-app notifications, each once (`app.license_reminders`): a license ending in 30 and in 7 days, an invoice due today, an invoice overdue — to the school's ORG_ADMINs and PRINCIPALs and every super admin; a receipt uploaded — to the super admins. |
| `run-usage-period-start` | 00:05 UTC on the 1st | Opens the month's zero meter for every seat holder of an active license and each metered feature of their tier.                                                                                                                                        |

Each runs school by school in its own system tenant transaction, audits with no actor, and is
idempotent. None suspends anything.

## What session 4 built

The super admin's license console in the web app, under `/portal/platform`, and the console routes
it needed beyond sessions 2 and 3.

### Pages

All in [`apps/web/src/features/platform/licensing`](../../apps/web/src/features/platform/licensing),
linked from `PlatformNav`, styled with `platform.css` plus a small `licensing.css` on the same design
tokens, and built from `@studafy/ui` components only.

| Page (`/portal/platform/…`)           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features`                            | Every registered feature: audience, unit, default limit, how many tiers include it, status. Edit the display name and status (`paused` is the kill switch, `hidden` stops selling it).                                                                                                                                                                                                                                                      |
| `tiers`                               | Per audience, the tiers side by side (features down, tiers across: each limit, "includes all future features", the seat price per currency, how many licenses and personal subscriptions use it). Create a tier (code, name, rank, features with monthly limits, prices) or replace one's settings; retire one with "active" off.                                                                                                           |
| `pricing`                             | Per currency: the volume basis (per audience or the whole license), volume brackets (optionally per audience), duration discounts. The bank details printed on every invoice.                                                                                                                                                                                                                                                               |
| `quotes`                              | The calculator: pick a school, what to price (new term, more seats, extension), the license (for a change, or a draft/awaiting-payment license to re-price in place), currency, months, start, Family+, tier and seats per audience, overlap credits on or off, an adjustment with its reason. The breakdown is priced live. Then the school's quotes.                                                                                      |
| `licenses`                            | The seat change request inbox (open / resolved / declined; price it, resolve or decline with a note), then every school's license, filtered by status, ending within 30 days, seats nearly full (any audience at 90%+) and unpaid balance.                                                                                                                                                                                                  |
| `payments`                            | Totals per currency (received this month, outstanding, overdue), the receipts schools uploaded waiting to be matched, and every invoice filtered by state (all, unpaid, partially paid, overdue, issued, paid, void), school and issue dates.                                                                                                                                                                                               |
| `payments/:schoolId/:invoiceId`       | One invoice: lines with their discounts, total / paid / balance, payment reference and bank details; payments (open the file, void with a reason); the school's receipts (record a transfer from one, or match it to a recorded payment). Record a transfer (amount up to the balance, date, bank reference, note, receipt or file), activate early with a due date, void the invoice, print.                                               |
| `schools/:schoolId` (license section) | The current license: tier and seats used / purchased per audience, Family+, dates, status, unpaid balance, this month's usage per feature. Actions from the server's `allowedTransitions` (activate, resume, suspend, cancel), activate early, extend, change seats or tiers (opens the calculator). Seats with assign / unassign on the school's behalf. The school's quotes, invoices, payments and licensing history from the audit log. |
| `ai` (new section)                    | Paid-feature usage this month per feature and per school, next to each school's AI cost (the existing metrics) and its license payments this month and in total.                                                                                                                                                                                                                                                                            |

**Data layer.** `queries.ts` and `mutations.ts` follow the platform console's React Query pattern.
Every key sits under `["platform", "licensing"]` and every write invalidates that prefix: the figures
are linked (a payment moves the invoice, the license, the totals and the school page), and the
console is small enough that a full refresh is cheap. The calculator's preview is a query on
`POST /api/platform/licenses/quote` (it saves nothing), debounced 300 ms, keeping the last breakdown
on screen while the next one is priced.

**Strings** are in a new namespace `platformLicensing` (`locales/en|ar/platformLicensing.json`,
pseudo-locale regenerated), loaded with every console page because the nav and the school page use it.

### Console routes (`modules/licensing/console-routes.ts`)

The session 1–3 routes had no way to list or edit features and tiers, or to read across schools.
Super admin only (`platform:read` / `platform:manage`, web channel), pinned in the four route gates:

| Route                                                  |                                                                                                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/platform/features`                           | Every registered feature: code facts (audience, unit, default limit), the super admin's settings, and how many tiers include it   |
| `PATCH /api/platform/features/{featureKey}`            | Display name and/or status                                                                                                        |
| `GET`, `POST /api/platform/tiers`                      | Tiers with features, limits, monthly seat prices per currency and use; create one                                                 |
| `PUT /api/platform/tiers/{planId}`                     | Replace a tier's settings, features and prices (code and audience are fixed; a currency left out is switched off, not deleted)    |
| `GET /api/platform/licenses`                           | Licenses across schools with balance, days left and seat use; filters `status`, `expiringWithinDays`, `seatsNearlyFull`, `unpaid` |
| `GET /api/platform/licenses/change-requests`           | The inbox: every school's change requests (`status`, open by default), oldest first                                               |
| `GET /api/platform/licenses/usage`                     | This month's units per metered feature per school, and license payments received this month and in total per currency             |
| `GET /api/platform/schools/{schoolId}/license-console` | A school's current license, this month's usage, its payments and the latest 100 licensing entries of its audit log                |

Features, tiers and prices are global tables, written in a system transaction and audited once in
the operator's home school; the feature catalog cache (30 s per process) carries the change to every
pod. Integration-tested in `apps/api/tests/licensing/console.integration.test.ts`.

### Tests

| File (`apps/web/src/features/platform/licensing/`) | Covers                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CalculatorPage.test.tsx`                          | The priced terms, every breakdown figure, the next-bracket offer, an adjustment needing a reason, saving and sending a quote, re-pricing a draft in place      |
| `InvoicePage.test.tsx`                             | Lines and how to pay, recording a transfer (never above the balance; in a 3-decimal currency), recording from a receipt, matching a receipt, voiding a payment |
| `SchoolLicenseSection.test.tsx`                    | Seats used / purchased and usage, the actions per status (suspend, resume, activate, activate early, extend, change seats), assign and unassign seats          |
| `LicensesPage.test.tsx`                            | The license list and its four filters, the change request inbox (what is asked, price it, resolve with a note, decline, switch status)                         |

## How session 5 plugged in (session 4's notes)

- The school admin UI reads the `/api/school/license*` routes (sessions 2 and 3). The console's
  `format.ts` (money in minor units, percentages, the currency's decimals), the status pills, the
  seat meter and the invoice layout are the pieces to reuse; the school's receipt upload goes through
  `POST /api/storage/uploads/request-upload` (content class `license.receipt`).
- Bulk seat assignment by grade, section or class (`scope` on the assign route) is the school's
  screen; the console offers only "everyone eligible" and picked people.
- Still open from earlier sessions: a retry action for failed renewal stops (session 2), and push or
  email delivery of the reminders (session 3, decision 9).

## What session 5 built

The school's side of its license in the web app, under `/portal/license`, for the school's
ORG_ADMINs and PRINCIPALs, and the three reads and one write it needed beyond sessions 2 and 3.

### Pages

All in [`apps/web/src/features/license`](../../apps/web/src/features/license). Every route is gated
on `license:read` (`RequirePermission` in `app/routes.tsx`); every change is shown only to
`license:manage` (`usePermissions()` in the page). Both roles hold both today, so the read-only view
is for a future role. The area is a "License" item in the portal sidebar and a License tile on the
admin and principal dashboards (both behind `license:read`). Styled with the principal pages'
tokens in `license.css`, built from `@studafy/ui` components only.

| Page (`/portal/license…`)    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (overview)                   | Status, dates, Family+ included or not, balance due (over unpaid invoices); per audience the tier, seats used / purchased and **what they get** (each feature of the tier with its monthly limit); this month's usage per feature; the open change requests. "Request more seats or a different tier" opens the request form (`?request=1` opens it too).                                                                                                                                                                                                                                                 |
| `/seats`                     | A tab per audience (Parents only with Family+). Everyone with their seat status (seat since…, no seat, can't hold a seat) and personal subscription end date; search, show (everyone / with a seat / without / paying personally), grade → section → class. A seats-left counter. Assign or unassign one person, a selection, or everyone eligible in the grade, section or class shown (or the whole school). When seats run out, the people left without one are listed by reason. The renewal stop and the reduced price for personal subscribers are explained on the page and again when confirming. |
| `/quotes`, `/quotes/:id`     | Sent, accepted and expired quotes; one quote's full breakdown (list price, volume and duration discounts, credits, adjustment, total, price per seat before and after) and "you save". Accept a sent, unexpired quote: the license is updated, the invoice issued, and its page opens.                                                                                                                                                                                                                                                                                                                    |
| `/invoices`, `/invoices/:id` | Invoices with due date, balance and status (filter all, unpaid, overdue, paid, void) and the payment history. One invoice: its lines, totals, the bank details and the payment reference with a copy button, upload of a transfer receipt (PDF, JPEG, PNG up to 10 MB), each receipt's status (waiting / matched), its payments, print.                                                                                                                                                                                                                                                                   |

**Banners**, on every license page: the license ends within 30 days, an invoice is overdue (with a
link to it), an audience's seats are 90% used or more (with a link to the request form).

**Data layer.** `queries.ts` and `mutations.ts` follow the React Query pattern of the other
features; every key sits under `["school-license"]` and every write invalidates it (a seat moves
the counter, the people list and the banners; accepting a quote moves the license, the quotes and
the invoices). The money helpers are the console's (`platform/licensing/format.ts`).

**Strings** are a new namespace `schoolLicense` (`locales/en|ar/schoolLicense.json`, Arabic with
all six plural forms, pseudo-locale regenerated), loaded with the license pages and, for the tile,
with the two dashboards. `nav.license` is in the root catalogs.

### API additions

| Route / object                             |                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/school/license/people`           | Everyone of an audience on the current license with their seat (`seatId`, `assignedAt`), whether they `eligible`, and `personalSubscriptionEndsAt`; `gradeLevelId` / `sectionId` / `classId`, `search`, `show` (`all`, `seated`, `unseated`, `personal`, echoed), paged. Empty without a license.            |
| `GET /api/school/license/tiers`            | Every active tier, and any retired tier the school's license still uses, with its features and monthly limits (an `includes_all_features` tier lists every feature of its audience at the code's default where it states none). No prices; hidden features are left out.                                     |
| `POST /api/school/license/change-requests` | Now also takes `studentPlanId` / `teacherPlanId` / `parentPlanId`: an active tier of that audience, or null for no change (422 `LICENSE_TIER_INVALID` otherwise). Every change request now returns `studentTier` / `teacherTier` / `parentTier` (`LicenseTierRef` or null), so the console inbox shows them. |
| Migration 000168                           | `license_change_requests.{student,teacher,parent}_plan_id` (FK to `app.plans`), with a trigger refusing a tier of another audience (`ck_license_change_requests_tier_audience`), as `school_licenses` does.                                                                                                  |

The people list is the session 2 `candidates()` query (the one that fills bulk assignments)
extended with the seat and the personal subscription's end date, so the screen and the assignment
agree on who is in a grade, section or class and who is eligible. Both reads use `license:read`
and are pinned in `document.test.ts` and the OpenAPI benchmark list; the clients were regenerated
(OpenAPI, TypeScript, Dart; `flutter analyze` clean). Integration-tested in
`apps/api/tests/licensing/school-side.integration.test.ts`.

### Tests

| File (`apps/web/src/…`)                          | Covers                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/license/SeatsPage.test.tsx`            | Seats left, the explanation and statuses; Parents only with Family+; assigning one person, a personal subscriber (confirmed), a selection, a whole grade, all eligible; seats running out (who was left out and why); unassigning; read-only without `license:manage` |
| `features/license/InvoiceDetailPage.test.tsx`    | Lines and how to pay, copying the reference, receipt statuses, the receipt upload (request-upload → PUT → attach), refusing a wrong file type, no upload without `license:manage`                                                                                     |
| `features/license/QuoteDetailPage.test.tsx`      | The breakdown and the saving, accepting (and landing on the invoice), no Accept on an expired or accepted quote or without `license:manage`                                                                                                                           |
| `features/license/LicensePage.test.tsx`          | Facts, what each group gets, usage, open requests, the three banners, the request form with a tier, no form without `license:manage`                                                                                                                                  |
| `app/router.test.tsx`, `layouts/portal/*.test.*` | `/portal/license` redirects a session without `license:read`; a principal reaches it; the sidebar item per role                                                                                                                                                       |

## How session 6 plugged in (session 5's notes)

- Students, teachers and parents read `GET /api/me/features` (session 1) to show, hide or upsell
  each feature; the AI routes still answer the legacy `AI_*` codes until the minimum app version
  reads `FEATURE_*` (session 1, decision 7).
- `GET /api/school/license/tiers` already describes each tier's features and limits in the
  super admin's names; the student and parent apps can reuse its shape for "what your school
  gives you".
- Still open: a retry action for failed renewal stops (session 2), push and email delivery of the
  reminders (session 3, decision 9), and AI cost per feature (session 4, decision 9).

## What session 6 built

What a student, teacher or parent sees of a paid feature, on mobile and web, decided from one
verdict: `GET /api/me/features`.

### The states

Every paid screen and entry point shows one of these, decided in one place per client
(`apps/mobile/lib/src/core/features/feature_gate.dart`, `apps/web/src/lib/features/gate.ts`, the
same rules, the same tests):

| State                      | When                                                                                                                                       | Shows                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Covered by a school seat   | active; every grant is `school_license`                                                                                                    | the feature, "Provided by <school>", usage against the limit; no purchase anywhere                                                                               |
| Covered personally         | active; only `purchase` / `trial` grants                                                                                                   | the feature, usage against the limit                                                                                                                             |
| Covered by both            | active; a seat and a personal grant                                                                                                        | "Your school now covers this. Your subscription won't renew after <date>." — and, for an App Store subscription, how to turn renewal off in Settings (text only) |
| Limit reached              | covered, `reason: limit_reached`                                                                                                           | "Monthly limit reached, resets on <date>" (the 1st of next month, UTC)                                                                                           |
| Ask your school for a seat | not covered, and the caller holds a seat of the audience (`schoolSeat`) or the school sells one that includes the feature (`schoolOffers`) | "Ask your school for a seat" — never a purchase button                                                                                                           |
| Purchasable                | not covered, nothing from the school                                                                                                       | the existing paywall (mobile: App Store / Google Play offer; web: the checkout button); "Your access ended on <date>" if it expired                              |
| School inactive            | `reason: school_inactive`                                                                                                                  | the school's plan is not active                                                                                                                                  |
| Unavailable                | `reason: paused`, or the feature is not listed (hidden)                                                                                    | temporarily unavailable                                                                                                                                          |

**A seat holder is never shown a store purchase** (App Store / Google Play rules): the gate never
answers "purchasable" to someone with `schoolSeat`, the mobile AI tab shows the store offer only
for "purchasable" (and nothing while the verdict is unknown), and the web checkout refuses a
seat holder server-side (`409 AI_SUBSCRIPTION_COVERED_BY_SCHOOL`).

**Refusal codes** map to friendly messages in both clients (`featureErrorMessageKey`):
`FEATURE_NOT_INCLUDED` / `AI_SUBSCRIPTION_INACTIVE`, `FEATURE_EXPIRED`, `FEATURE_LIMIT_REACHED`
(with the reset date where shown inline), `AI_SCHOOL_INACTIVE` / `SCHOOL_SUSPENDED`, and
`AI_SUBSCRIPTION_COVERED_BY_SCHOOL`. The four AI controllers (Ask AI, quizzes, flashcards, exam
mode) gained a `featureLimitReached` error and map `FEATURE_NOT_INCLUDED` / `FEATURE_EXPIRED`.

### API additions

| Change                                                  |                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me/features`                                  | Now also: `schoolName`; per feature `schoolSeat` (the caller holds a seat of its audience on the license in force), `schoolOffers` (that license sells a seat of its audience whose tier includes it), `renewalStop` (`{ provider, action, status }` of the personal subscription a seat turned off, or null). |
| `GET /api/subscriptions/ai/offer`                       | Each student now has `schoolSeat` and `schoolOffers` (for the AI tutor), so the web page never offers a seat holder the add-on.                                                                                                                                                                                |
| `POST /api/subscriptions/ai/checkout`                   | Refuses a student holding a seat on the license in force: `409 AI_SUBSCRIPTION_COVERED_BY_SCHOOL` (new code, en/ar messages).                                                                                                                                                                                  |
| Realtime gateway (`apps/realtime/src/event-routing.ts`) | Routes `userEntitlement.changed` to `school:{schoolId}:user:{userId}` — that person's own sockets only, never a role broadcast. Routes now receive the payload.                                                                                                                                                |

The license context (school name, the tiers the license in force sells, the asked-about people's
seats and renewal stops) is read per request by `FeatureService.licenseContext`
(`modules/features/license-context.ts`), not cached: only the feature list and the purchase offer
ask for it, never a gated route.

### Mobile (`apps/mobile/lib/src/core/features/`)

- **`myFeaturesProvider`** reads `GET /api/me/features` through `authenticatedDio` (unchanged); it
  is rebuilt on sign-in and sign-out. `featureGateProvider(key)` gives one feature's state.
- **`featuresAutoRefreshProvider`**, watched by the app root, re-reads it on app resume, on a
  `userEntitlement.changed` event for this user (the app had no entitlement listener; this adds
  one on the existing realtime client), and when the socket (re)connects (events sent while it was
  down are not replayed). A completed store purchase invalidates it too (`AiStoreController`).
- **`FeatureGate`** wraps every paid entry point: Ask AI (`ai_tutor`), quizzes, exam mode,
  flashcards, summaries and key concepts (`study_tools`) — in the router and the material viewer.
  Covered shows the screen; "purchasable" shows the existing paywall (`AiPaywall`: the not-active
  card and the store offer); the rest show their notice.
- **The AI tab** shows "Provided by" / the renewal notice / usage above the hub when covered, "ask
  your school" instead of the store when the school provides it, and the store only when the gate
  says the student may buy.
- **Family+** (parent home, `FamilyPlusCoverageCard`): who covers it, the children at this school
  by name, and that children at other schools need the personal Family+ or a seat from their own
  school; the renewal notice and App Store steps when both apply; "ask your school" when the
  school sells Family+. Nothing is sold there (Family+ has no store product).
- Notebook and auto-grading have no screens yet; when they ship, their entry points take a
  `FeatureGate` with their key (see "How to add a new paid feature").
- Strings: `features.*` and `familyPlus.*` in `assets/translations/en.json` and `ar.json`.

### Web (`apps/web/src/lib/features/`)

- **`useFeatures()`** (`["me", "features"]`, refetched on window focus) and `useFeatureGate(key)`;
  `featureGateState()` and `FeatureNotice` render the states above.
- The realtime layer invalidates `["me", "features"]` and `["ai-offer"]` on
  `userEntitlement.changed` (and, like every mapped key, on reconnect).
- **The AI add-on page** (`/account/ai`, the one paid surface on the web): per student, "Provided by
  <school>" for a seat holder and "ask the school" where the school sells a seat — no purchase
  button for either; a signed-in student also sees their own coverage notice (renewal, limit); a
  refused checkout is explained in words.
- Strings: `site.features.*` in `locales/en|ar/site.json`; pseudo-locale regenerated.

### Tests

| Where                                                                               | Covers                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/test/core/features/feature_gate_test.dart`                             | Parsing; every gate state; reset date; refusal-code messages                                                                                              |
| `apps/mobile/test/core/features/features_providers_test.dart`                       | The provider and gate; re-read on this user's `userEntitlement.changed` (not another's), on reconnect (real `RealtimeClient`, fake socket), on app resume |
| `apps/mobile/test/core/features/feature_gate_view_test.dart`                        | `FeatureGate` and the banner in every state (and in Arabic); no purchase control outside the paywall                                                      |
| `apps/mobile/test/features/ai/presentation/ai_hub_screen_test.dart`                 | Store only when purchasable; ask the school; seat holder never sees the store; unknown verdict shows no store; "Provided by" above the hub                |
| `apps/mobile/test/features/parent/presentation/family_plus_coverage_card_test.dart` | School seat (children named, other schools not covered), personal, both, ask the school, not covered                                                      |
| `apps/mobile/test/features/ai/application/ask_ai_controller_test.dart`              | `FEATURE_LIMIT_REACHED` / `NOT_INCLUDED` / `EXPIRED` mapping                                                                                              |
| `apps/web/src/lib/features/gate.test.ts`, `FeatureNotice.test.tsx`                  | Every state and message, no purchase control                                                                                                              |
| `apps/web/src/features/billing/AiSubscriptionPurchasePage.test.tsx`                 | Seat holder and "ask the school" rows have no buy button; a student covered by both; the 409 explained                                                    |
| `apps/realtime/src/event-routing.test.ts`, `outbox-fanout.test.ts`                  | `userEntitlement.changed` reaches only that user's room                                                                                                   |
| `apps/api/tests/licensing/feature-gating.integration.test.ts`                       | End to end, below                                                                                                                                         |

### End to end

`apps/api/tests/licensing/feature-gating.integration.test.ts` runs the whole API (`createApp` with
every middleware) against a freshly migrated PostgreSQL and the local Redis (the entitlement cache
and the AI routes are live only with Redis), driven over HTTP as the apps drive it — the school
admin through `/api/school/license/seats`, the student and parent through `GET /api/me/features`,
`GET /api/ai/usage` (a real `requireFeature`-gated route) and the AI offer and checkout:

1. A student with a seat gets access with no purchase: before the seat, `ai_tutor` is not active
   with `schoolOffers: true` and `/api/ai/usage` answers 402; after it, active from
   `school_license`, "Provided by" the school's name, 200; the offer marks them `schoolSeat`.
2. Unassigning the seat removes access immediately: the next request (no wait, the cache primed
   beforehand) is inactive and 402; `userEntitlement.changed` events for the student are queued for
   the realtime gateway.
3. A personal subscriber who gets a seat keeps the best of both: a Tap AI add-on (unlimited) plus a
   seat (300) resolves unlimited with both sources; renewal is turned off
   (`ai_subscriptions.cancel_at_period_end = true`, `renewalStop.action = cancel_at_period_end`);
   an App Store subscriber gets `renewalStop.action = notify_user`; a web checkout for the seat
   holder is refused with 409.
4. A Family+ parent with a seat at one school is covered there (`family_plus` from
   `school_license`), and the same person's account at their other child's school is not.

Run with `TEST_DATABASE_URL` and `REDIS_URL` set. The mobile and web halves are covered by their
unit and widget tests against the same JSON; no device run was part of this session.

## How to add a new paid feature

Everything that decides access, sells it, licenses it and shows it is generic. A new paid feature
is these steps, in this order, and nothing else — no migration, no billing change, no console or
school change.

1. **Register it** in `FEATURES` (`packages/constants/src/features.ts`): key, audience
   (`student` | `teacher` | `parent`), usage unit (or `null`), default monthly limit (or `null`),
   name key. Rebuild `@studafy/constants`. The API inserts it into `app.features` at its next boot.
2. **Guard its routes** with `requireFeature("<key>", { meter })`
   (`apps/api/src/modules/features/middleware.ts`): `meter` is the units one request uses; omit it
   for a route that is checked but not counted. Routes answer `402 FEATURE_NOT_INCLUDED` /
   `FEATURE_EXPIRED` and `429 FEATURE_LIMIT_REACHED`; the clients already word them.
3. **Name it for people**: `features.<key>.name` strings where the clients show feature names, and
   its unit if it is a new one (`features.units.*` on mobile, `site.features.units.*` on web).
4. **Gate its entry points.** Mobile: add the key to `FeatureKeys` and wrap each screen or entry
   point in `FeatureGate(featureKey: FeatureKeys.x, child: …)` — pass `whenPurchasable` only if the
   feature is sold in the app's store; show `FeatureCoverageBanner` where usage matters. Web:
   `useFeatureGate("<key>")` and `<FeatureNotice state={…} />`, and hide any purchase control unless
   the state is `purchasable`.
5. **Sell it.** In the console (`/portal/platform/tiers`) add it to the tiers that should include
   it, at a limit; a tier with "includes all future features" already has it at the default limit.
   Schools get it with their seats at once (the catalog cache is 30 s). Personal sale needs a store
   or web product only if it is not part of a tier already sold personally (`ai_addon` today).
6. **Test** the routes' gating (an integration test with a seat and without, like
   `feature-gating.integration.test.ts`) and the entry points' states (the gate tests above cover
   the rules; a new screen needs only "covered shows it, not covered shows the notice").

Pausing a feature (`status: paused` in `/portal/platform/features`) refuses everyone at once and
shows "temporarily unavailable" in both apps; hiding it stops selling and listing it while holders
keep it.

## Repo rules

Copied from the brief; every session follows them.

- Hono + `@hono/zod-openapi`; postgres.js tagged templates (no interpolated `.unsafe`).
- Give nested OpenAPI schemas explicit unique `.openapi("Name")` names (the Dart generator collides
  on inline names).
- In `.use()` paths, use `:param`, not `{param}`.
- Write each route as a literal `createRoute({ ... path: "..." })` and each `.use()` with a literal path:
  the coverage gates find routes and their guards by scanning source text, so a wrapper function or
  a template-literal path hides a route from them.
- Name every query enum and make it appear in a response body; keep **nullable** enum properties
  inline (a nullable reference to a named enum generates Dart that does not compile), and echo list
  filters with an `all` value rather than null. Run `flutter analyze` after `mobile:client:generate`.
- Add new routes to the pinned gates: `apps/api/tests/audit-coverage.test.ts`,
  `tests/permission-guard-coverage.test.ts`, `src/openapi/document.test.ts` and
  `tests/security/route-guard-wiring.test.ts`. (The first two pin mutating routes only.)
- Audit-log rows: an insert has no old values; an update has old and new; a delete has old only.
- After API changes run `bun run openapi:generate`, `bun run client:generate` (then build
  `packages/api-client`), and `bun run mobile:client:generate`.
- Another Claude session may be working in the same working tree: never run `git checkout`, `stash`
  or `reset`; don't commit unless asked.
- Run the real tests (integration tests need `TEST_DATABASE_URL` like the existing ones). Report exact
  pass/fail counts and never claim tests passed without running them. List every decision made.
- Database: forced RLS through `app.apply_tenant_isolation`, composite school-keyed foreign keys,
  indexes that lead with `school_id`, explicit grants (no DELETE unless needed), and audit. Avoid
  JSONB; if it is unavoidable, add it to the allowlist in `db/policies/rls-coverage.ts` and
  `docs/testing/rls-policy-coverage.md`. A new global table goes in `approved_globals` there too.
- Use the next free migration number, checked right before creating the file.
- Reading `app.students` from a userless transaction (the resolver, a worker) needs a SECURITY
  DEFINER helper: the role-scope policy shows a userless `studafy_app` no students.

## Session 1 decisions

Decisions made while building the foundation, beyond the brief:

1. **Tiers are `app.plans` rows** with `audience`, `rank`, `includes_all_features`; plan prices stay in
   `app.plan_prices`. School plans keep `audience` NULL. Rank is unique among **active** tiers of an
   audience, so a retired tier keeps its rank. A retired (inactive) tier keeps serving grants that
   point at it.
2. **Feature settings vs code facts.** `app.features` holds only display name and status; audience,
   unit and default limit live in code. Status semantics: `paused` refuses everyone (kill switch);
   `hidden` is not sold or listed but keeps working for holders.
3. **The `ai_addon` tier has unlimited units** for all three student features, so the token budget
   stays the only quota for today's subscribers. `notebook` is included as the brief asks.
4. **Usage periods are calendar months in UTC**, not grant billing periods.
5. **Units are consumed before the handler and refunded on failure**; a streamed answer counts once
   the stream opens.
6. **Unit assignment on AI routes:** generation routes count 1; search, grading, review and exam
   start/submit/poll are checked but not counted. `generate` counts as an `ai_tutor` message.
7. **AI routes keep their old error codes** (`AI_SUBSCRIPTION_INACTIVE`, `AI_SCHOOL_INACTIVE`) for
   the installed mobile app; other features use `FEATURE_*`. School-inactive answers
   `403 AI_SCHOOL_INACTIVE` for every feature ("as today"); a paused feature answers
   `402 FEATURE_NOT_INCLUDED`.
8. **AI routes resolve the student in the path**, as before; every other feature resolves the caller
   unless its route passes a `subject`.
9. **The AI token budget is a separate middleware** (`aiTokenBudget`) after `requireFeature`, keyed on
   the reported grant's window. For a student covered only by a personal tier, the budget window is
   that subscription's.
10. **A new entitlement subject `user` and event `userEntitlement.changed`** carry grant changes, with
    their own outbox index built concurrently in a separate non-transactional migration (000162)
    rather than rebuilding the 000080 index.
11. **The catalog is cached per process for 30 s**, not versioned; grants are versioned.
12. **Boot-time sync is insert-only and not audited** (no actor, no school). A sync failure is logged,
    not fatal.
13. **Personal subscriptions are unique per `(school, provider, provider_reference)`** and keep
    current state only, like `app.subscriptions`.
14. **No new purchase flow this session.** Store/Tap/Stripe purchases still write
    `app.ai_subscriptions`; nothing writes `app.user_subscriptions` yet.
15. **i18n display names** (`features.<key>.name`) are keys only; the strings are added with the
    client work in session 6.

## Session 2 decisions

1. **One active seat per person _per audience_ per license**, not per license. A teacher who is also a
   parent at the school can hold a teacher seat and a Family+ parent seat. Each counts against its
   own purchased seats. (The brief said "per person per license"; this was read as per seat type.)
2. **Seat cap by row lock in a trigger**, not seat-slot rows: the trigger locks the license row and
   counts. Simpler than slot tables and equally safe under concurrency (tested).
3. **Eligibility:** students `enrolled`; teachers `active` or `on_leave` (not `pending`); parents
   linked to at least one enrolled student; users `invited` or `active`. Defined once in
   `app.license_seat_eligible`.
4. **Seats can be prepared on draft and awaiting-payment licenses.** The school sees and assigns
   on its current license (active, else awaiting payment); drafts are the super admin's only.
5. **Overlap and renewal stops happen when the seat starts covering**, at assignment on an active
   license or at activation, never earlier. That way a license that is never paid never costs anyone
   their renewal.
6. **No gap:** renewal is only stopped if the personal period reaches the license start; otherwise
   it keeps renewing (and the overlap records 0 days).
7. **Personal subscriptions include the AI add-on** (`app.ai_subscriptions`). Its provider is read
   from its Stripe or Tap id, or from its app-store billing event. A new
   `ai_subscriptions.cancel_at_period_end` carries "renewal off", and the Tap worker honours it.
8. **Overlap credit:** whole days rounded up; daily price = monthly list price × 12 / 365 (no volume or
   duration discounts yet, which arrive with session 3's pricing); trials earn no credit; an unpriced
   tier records days with a NULL amount.
9. **Provider calls run after commit**, never inside the transaction. A failure is recorded on the
   overlap row and does not roll back the seat.
10. **The Apple notice** is an optional, immediate notification in the school's language
    (`school_settings.locale`); users have no language of their own.
11. **Expiry is by date at read time**, and the status `expired` is left to session 3's job. The
    super admin cannot set `expired` by hand. A shorter end date is a cancellation, not an
    "extension".
12. **License-wide changes bump every seat holder's `user` version**, in one statement, rather than
    the school version (which would invalidate every token in the school).
13. **Bulk scopes:** grade and section use the active academic year's sections; class uses active
    enrollments; teachers of a class are its lead teacher and timetable teachers; parents are those
    linked to students in scope. Bulk results report already-seated people but not ineligible ones
    (only named people are reported as `not_eligible`).
14. **School usage** on `GET /api/school/license` is this month's units summed over the current seat
    holders only.
15. **`created_by`, `assigned_by`, `unassigned_by`, `resolved_by` have no foreign key:** a super admin
    is a user of another school. `requested_by` (always a school member) has one.
16. **The super admin can list and resolve change requests** (two routes beyond the brief), so a
    request has somewhere to go before the console UI exists.

## Session 3 decisions

1. **The calculator is a package** (`@studafy/license-pricing`), pure, BigInt inside, numbers out.
   Discounts compound (volume, then duration on the remainder), each rounded half up once; lines add
   up exactly; credits never take the seats below zero; a negative total is refused.
2. **Volume brackets are configurable both ways:** `volume_basis` per currency (`per_audience` or
   `overall`), and brackets per audience that override the general ones. A seat increase is
   discounted at the license's **new total** (`volumeSeats`), so adding seats can reach a better
   bracket.
3. **Price settings are two global tables** (settings + brackets) rather than JSONB. The only JSONB is
   the quote's `breakdown`, a snapshot of what the school was shown; invoice lines are relational.
4. **Quote kinds:** `new`, `seat_increase`, `extension`. A seat increase keeps the license's tiers
   (an audience without one may get its first) and is charged by the day to the end of the term; an
   extension charges whole months at the current seats. Tier upgrades mid-term are not priced.
5. **Changes apply on acceptance**, not on payment: added seats and a later end date are usable at
   once and the invoice is due later — the same trust as early activation. A new license is created
   awaiting payment and activates when paid in full (or early).
6. **Staleness:** accepting refuses a quote whose license changed after `priced_at`, or whose credits
   another invoice claimed (credits are row-locked on acceptance). Expiry is checked at acceptance as
   well as by the job.
7. **The super admin may accept a draft** on the school's behalf (recorded as
   `accepted_by_platform`, and `sent_at` is stamped then). The school sees only sent, accepted and
   expired quotes.
8. **Overlap credits:** any open credit of the school in the quote's currency, from any license, goes
   on its next quote; a credit recorded without an amount is priced at quoting with session 2's
   formula; voiding an invoice releases its credits.
9. **Reminders are in-app notifications**, written by the worker in the recipient's school and
   language — the same delivery as session 2's App Store notice. Super admins are found school by
   school (tenant isolation) and notified in their home school within the same transaction as the
   claim. Push/email would need dispatcher resolvers (left for later). The receipt reminder goes to
   super admins only.
10. **Jobs run hourly**, not daily, so a license expires and an invoice goes overdue within the hour;
    the 30/7-day expiry reminders are each sent once (a license already within 7 days gets only the
    7-day one).
11. **"Start new usage periods"** opens the month's zero meter rows for seat holders. Usage already
    resets by calendar month without it (session 1); the job makes the period visible from its first
    minute and is otherwise a no-op.
12. **Invoice numbers** are gapless per year (`LIC-<year>-<6 digits>`), from a counter row locked by
    the issuing transaction; **payment references** are random (`STF-XXXX-XXXX`, Crockford base32
    without I, L, O, U), unique by constraint, retried on a collision.
13. **Overdue is a timestamp, not a status**: the invoice statuses stay issued / partially_paid /
    paid / void, and `overdue_at` records when it went overdue; moving the due date later (early
    activation) clears it.
14. **Bank details are five platform settings** written through their own console route (a text
    setting cannot be empty, so nothing is seeded); until saved, invoices show `bankDetails: null`.
    Quote validity and invoice due days are seeded settings (30 and 30 days).
15. **Receipts use the storage gateway**: content class `license.receipt` (PDF, JPEG, PNG, 10 MiB,
    `license:manage`), confirmed by the licensing module; the super admin's files use a console
    upload route into the school's prefix. Receipts count toward the school's storage but are never
    refused for the cap. Without object storage the receipt routes answer 503.
16. **A receipt is pending or matched**, nothing else; voiding its payment returns it to pending. A
    receipt matches only a payment on its own invoice.
17. **Paying in full activates** the license only if it is draft or awaiting payment and the school
    has no other active license; otherwise the payment is recorded and nothing else changes.
18. **The calculator and upload-URL routes declare `auditAction`** though they write nothing, as the
    other upload-URL routes do, for the audit coverage gate. Nullable enum properties stay inline in
    the OpenAPI schemas, and list filters echo an `all` value instead of null: a nullable reference
    to a named enum generates Dart that does not compile.

## Session 4 decisions

1. **Tiers get a sibling page** (`/portal/platform/tiers`) rather than extending `PlansPage`: plans
   are what a school pays for Studafy itself (`audience` NULL); tiers are audience plans with
   features and limits, and the comparison table needs the whole width.
2. **The console needed routes of its own** (`console-routes.ts`, eight rows above). The feature
   catalog and tiers had no read or write route, and every license, request and invoice route was
   per school. Rather than have the browser walk schools, the cross-school reads walk them on the
   server (`forEachSchool`, one system transaction, each school's scope armed in turn) and filter in
   memory. This is fine at today's school count; paging in SQL is the step when it is not.
3. **"Expiring"** is an active license ending within 30 days; **"seats nearly full"** is any audience
   at 90% of its seats or more; **"unpaid"** is an open balance on any of the license's invoices.
4. **Money on screen:** amounts stay in minor units end to end. A figure is shown with its
   response's `minorUnit`; where the API sends none (the calculator's breakdown, receipts), the
   currency's ISO 4217 decimals from `Intl` are used (`app.currencies` holds the ISO values). Typed
   amounts are parsed in the currency's decimals, so KWD/BHD/OMR (3) and JPY (0) are correct.
5. **The calculator prices live and saves only on request:** the preview route saves nothing; "Save
   as draft quote" stores it; sending and accepting are buttons on the quote. A new term can target
   a draft or awaiting-payment license, which accepting then rewrites in place instead of creating a
   second license; more seats and extensions target an active or suspended one.
6. **"Change seats or tiers"** opens the calculator: a seat increase for a license in force, a new
   term for a draft or awaiting-payment one. On a seat increase the tiers an audience already has are
   locked, because mid-term tier changes are not priced (session 3, decision 4); a tier change for a
   license in force is priced as the next term.
7. **Activate early** from the school page uses the license's oldest open invoice; from an invoice,
   that invoice. Plain "activate" (without payment) is offered only when `allowedTransitions` has it.
8. **Print / download is the browser's print**, with a print stylesheet that leaves only the invoice
   (print to PDF downloads it). No server-side PDF.
9. **AI cost is per school, not per feature.** `ai_usage_meters` records tokens per student and
   subscription, with no feature, so the AI page shows units per feature (`feature_usage_meters`)
   and the existing AI cost per school, next to license payments received. Cost per feature needs
   the AI ledger to record the feature first.
10. **A change request is answered by a quote**, not by resolving it: "Price it" opens a seat
    increase for the request's license; resolve and decline only close the request, with an
    optional note to the school.
11. **Seats on the school's behalf:** the console assigns to people picked from the school's members
    of the audience's role, or to everyone eligible; the API reports who was not assigned and why.
    Bulk scopes by grade, section or class are left to the school's screen (session 5).
12. **Receipt and payment files** open in a tab opened on the click and pointed at the short-lived
    URL once it arrives, so popup blockers allow it.
13. **The invoice list's school filter searches** the paged school list instead of listing schools.

## Session 5 decisions

1. **The license area is a top-level `/portal/license`**, not under `/portal/admin` or
   `/portal/principal`: both ORG_ADMIN and PRINCIPAL hold `license:*`, and their consoles are gated on
   other permissions. Links match by prefix, so a top-level path keeps the sidebar honest.
2. **Three API gaps were filled** rather than worked around in the browser: a people list with seat
   status and personal subscription end dates (the existing lists were seats only, or unseated
   people only, with a yes/no for personal subscriptions), a tier catalog the school may read (the
   license view names its tiers but not their features), and a tier in change requests (the request
   had seat counts and Family+ only). The tier is a column per audience (migration 000168), not text
   in the note, so the console can price it.
3. **The people list reuses the bulk-assignment query**, so "everyone in Grade 7" on screen is
   exactly who a Grade 7 assignment would fill, in the same name order.
4. **The tier catalog has no prices**: a school sees prices on its quotes (session 3). Retired tiers
   are listed only while the school's license uses them; hidden features are not listed.
5. **A requested tier must be an active tier of its audience**, checked by the API (422) and, for the
   audience, by a trigger whoever writes it.
6. **Confirmation is asked when it matters**: one person without a personal subscription is
   assigned at once; a personal subscriber, a selection, a whole scope and any bulk unassign are
   confirmed, with the renewal stop and the reduced price explained and the people paying
   personally named.
7. **Running out of seats is shown, not prevented**: the server fills in name order until seats run
   out and reports who was left out and why (no seats left, not eligible, already seated); the page
   lists them and warns before a selection larger than the seats left.
8. **Banners**: ending within 30 days (active licenses), any overdue invoice, any audience at 90% of
   its seats — the same thresholds as the console's filters (session 4, decision 3).
9. **The balance due** is the sum of the open (issued or partly paid) invoices' balances, linked to
   the invoices page.
10. **Receipt files are checked in the browser** against the `license.receipt` rules (type and
    10 MB) before anything is uploaded; the server checks them again.
11. **Unassigning several seats is one request per seat**, as the route frees one seat; the
    selection is small and each request is audited on its own.
12. **The money helpers are shared with the console** (`platform/licensing/format.ts`), so a
    3-decimal currency is shown and parsed the same on both sides.

## Session 6 decisions

1. **The API carries the school context, the clients decide nothing alone**: `GET /api/me/features`
   gained `schoolName`, per-feature `schoolSeat`, `schoolOffers` and `renewalStop`, so both apps
   show the same answer from the same verdict and the rule lives in one tested function per client.
2. **"Ask your school" covers two cases**: the school sells a seat whose tier includes the feature,
   or the person already holds a seat (of that audience) whose tier does not. A seat holder is never
   sold the feature personally, whatever their tier lacks.
3. **Fail closed on purchases**: while the verdict is unknown (loading, offline), the mobile AI tab
   shows the not-active notice without the store offer. A gated screen whose verdict cannot load is
   shown anyway — the API refuses what the person does not hold, so a failed read never locks out
   someone who has access.
4. **The web checkout refuses a seat holder** (`409 AI_SUBSCRIPTION_COVERED_BY_SCHOOL`), so a stale
   page or a direct call cannot buy what the school provides. The mobile store purchase is not
   refused server-side: the store controls that flow, and the app never offers it to a seat holder.
5. **Entitlement changes reach the apps through the realtime gateway**, as a per-user route
   (`userEntitlement.changed` → the person's own room) rather than a role broadcast: the event names
   one person, and only that person's sockets need it. `EventRoute` now receives the payload.
6. **Mobile refresh triggers**: app resume, this person's `userEntitlement.changed`, a socket
   (re)connect, a completed store purchase, and sign-in/out. Web: window focus, the same event and
   reconnects through the existing invalidation table.
7. **App Store renewal steps are text, not a link**: the store-compliance suite forbids new outbound
   launches, and Settings has no stable deep link. They are shown for an App Store subscription
   (`renewalStop.action = notify_user` or provider `app_store`) whichever device the person uses.
8. **Family+ across schools is stated, not listed**: a parent's accounts are per school and the app
   has one school session at a time, so the card names this school's covered children and says
   that children at other schools need the personal Family+ or a seat from their own school. Listing
   the other schools' children would need a cross-tenant read the data model does not offer.
9. **Notebook and auto-grading have no entry points yet**: nothing to gate; the generic
   `FeatureGate` and the "How to add a new paid feature" steps cover them when they ship.
10. **The limit-reached error on a screen** carries the reset date where the screen words it
    (mobile), and says "the 1st of next month" in the web's generic error message.
