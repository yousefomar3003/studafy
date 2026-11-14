# Subscription and entitlement data model

Migration `000016_create_subscription_and_entitlement_tables.sql` adds three tables: the
school-owned `app.subscriptions` and `app.ai_subscriptions`, and the global `app.billing_events`.
SQL constraints are the source of truth; APIs must not weaken them or treat RLS as a substitute for
permission checks.

## What owns what

`app.subscriptions` and `app.ai_subscriptions` are **current-state** tables: one row per school (or
per student), updated in place as a payment provider's webhooks report renewals, plan changes,
cancellations, or lapses. Neither table is a history log -- that is exactly what `app.billing_events`
already is, so a school or student's subscription is never versioned as a new row per change. Keeping
one mutable row per tenant avoids the derived, duplicated-fact problem the
[normalization standard](./migration-policy.md#normalization-standard) warns about: the current
status is the current status, not something recomputed by scanning history at read time.

| Table              | Scope                     | Key columns                                                                        |
| ------------------ | ------------------------- | ---------------------------------------------------------------------------------- |
| `subscriptions`    | One row per school        | `plan_id`, `status`, `current_period_start`, `current_period_end`                  |
| `ai_subscriptions` | One row per student       | `status`, `current_period_start`, `current_period_end`                             |
| `billing_events`   | Global, mutable per event | `provider`, `provider_event_id`, `event_type`, `effective_at`, `status`, `payload` |

> **Amended by ST-132.** `billing_events` was append-only when 000016 created it, because it only
> ever recorded "seen it". Processing an event introduced retries, and
> [`000078_normalize_billing_events.sql`](../../db/migrations/000078_normalize_billing_events.sql)
> made the row mutable in place: `status`, `processed_at`, `attempt_count` and `last_error` change
> across attempts, while `(provider, provider_event_id)` stays the identity — because that unique
> constraint _is_ the deduplication guarantee, and a row-per-attempt model would have to give it up.
> `DELETE` is still withheld.

`ai_subscriptions` carries no `plan_id`. It is a single AI-feature entitlement toggle scoped to one
student, not a school-plan choice -- the ticket's own description distinguishes the two tables by
exactly this ("school-level: plan, status, period" versus "student-level, status, requires school
link"). A plan reference was not invented to make the tables symmetric.

## Storage add-on (000205)

`app.storage_subscriptions` holds one paid storage add-on per school (`uq_storage_subscriptions_school`):
its tier (`plan_price_id`, and `cap_bytes` copied from the tier when bought or changed), status,
period, Stripe subscription id, `cancel_at_period_end`, and the grace and Tap columns the other two
subscription tables have. It is the third `app.billing_subscription_type` (`storage`). The webhook
pipeline attributes an event to it by the `addon: "storage"` metadata the checkout writes. Without
that metadata, a storage payment would fall through to the school's own subscription. The
lifecycle is the school table's. As with the AI add-on, buying again after it ended restarts it on
the same row.

Billing never writes the school's cap. The upload quota takes the larger of
`app.subscriptions.storage_cap_bytes` (10 GiB included) and the `cap_bytes` of a live add-on. When
an add-on is canceled, expires or is closed after its 7-day grace period, it stops counting. No
file is ever deleted. A school over its cap keeps and reads everything, and only new uploads are
refused. The tiers are `app.plans` `storage_100gb` and `storage_1tb`, and their prices are
`app.plan_prices` rows: USD is seeded, and other currencies are added as more rows.

### One storage subscription per school, never two (000219)

A school pays for one storage add-on at a time. Changing tier moves the same Stripe subscription
to a new price, prorated (`POST /api/subscriptions/storage/change`). It never starts a second one,
and the checkout refuses to start a second purchase while Stripe holds a live one (#474). As a
safety net, if a second storage subscription still reaches Studafy:

- **Only events about the add-on row's own Stripe subscription move it.** An event naming another
  storage subscription is parked: a second subscription's renewal never rewrites the row's period,
  and its cancellation never ends the school's storage.
- **A second completed checkout: the newest purchase is kept.** The row moves to the new purchase's
  tier and subscription, with a placeholder period until that subscription's next event. The
  subscription it replaced is recorded in `app.storage_duplicate_subscriptions` as `pending`. The
  billing worker (`run-storage-duplicate-resolver`, every 10 minutes) then cancels it in Stripe at
  once. It also refunds the unused share of its period at the old price, capped at what its latest
  paid invoice took. Every later event of the retired subscription is recorded and finished with,
  including the cancellation the worker causes and late copies of its checkout. None of them touch
  the row. Which purchase is newest is the order the checkouts' completions arrive in.
- **A second live subscription seen without a completed checkout** (`source = 'event'`) is only
  flagged as `needs_review`. Studafy never cancels it on its own, because a new subscription's own
  events can arrive before its checkout completion. If that completion does arrive, the flag is
  dropped and the newest-wins move above runs.
- **Retries and review.** No transaction is held across a Stripe call. The refund amount is fixed
  before the refund is requested. The cancel and the refund carry idempotency keys derived from the
  row, and an earlier refund is found by its `storage_duplicate_id` metadata. A retry therefore
  never cancels or refunds twice. After 8 failed attempts (about a day) a row becomes
  `needs_review`.
- **Where the super admin sees it.** Every row not yet settled, and those settled in the last 30
  days, is listed on the platform's system-health page (`/portal/platform/health`), needing review
  first. A structured warning is also logged when one is found, and on every failed attempt.

## Subscription state machine

Both `subscriptions.status` and `ai_subscriptions.status` share one enum, `app.subscription_status`,
since both are the same lifecycle shape at different scopes:

```mermaid
stateDiagram-v2
  [*] --> trialing: subscription created
  trialing --> active: trial converts (payment succeeds)
  trialing --> canceled: trial ends without conversion
  active --> past_due: renewal payment fails
  past_due --> active: payment recovered
  past_due --> grace_period: dunning exhausted
  grace_period --> active: payment recovered in the grace window
  grace_period --> closed: grace window exhausted
  active --> canceled: voluntary cancellation
  active --> expired: period lapses without renewal
  canceled --> [*]
  expired --> [*]
  closed --> [*]
```

`trialing`, `active`, `past_due` and `grace_period` are the live states in which the school or
student retains access; `canceled`, `expired` and `closed` are terminal and have no outgoing edges.
Every transition is an `UPDATE` of the existing row driven by a processed `billing_events` row -- the
events table is the durable evidence of _why_ a transition happened; the subscription row only ever
reflects _what_ the current state is.

`grace_period` and `closed` were added by 000042 (ST-092) after this diagram was first written.
The full transition tables for both subscription types, the Stripe event vocabulary they are driven
by, the school→AI cascade, and what happens to an event that maps to no legal transition are in
**[stripe-webhook-state-machine.md](./stripe-webhook-state-machine.md)** (ST-132). This diagram is
the summary; that document is the specification.

## Keys and functional dependencies

- `subscriptions`: primary key `id`; candidate key `school_id` (one current subscription per
  school). `id` determines the plan, status, and period; `school_id` determines `id` 1:1.
- `ai_subscriptions`: primary key `id`; candidate key `(school_id, student_id)` (one current AI
  entitlement per student). `id` determines the status and period.
- `billing_events`: primary key `id`; candidate key `(provider, provider_event_id)`, the natural key
  a payment provider itself guarantees is unique per account/webhook endpoint -- not
  `provider_event_id` alone, since two different providers are not guaranteed to draw event ids from
  the same namespace.

All values are atomic (1NF). Neither school-scoped table has a composite primary key, so 2NF is
trivial. Plan facts stay on `app.plans`; student facts stay on `app.students`; `subscriptions` and
`ai_subscriptions` reference them by foreign key rather than copying plan names or student details
(3NF).

## Why `billing_events` has no `school_id`

A webhook delivery must be deduplicated by `(provider, provider_event_id)` before its payload is
parsed enough to know which school or student it concerns. Requiring a `NOT NULL school_id` would
make that dedup step depend on interpretation it hasn't done yet, and `app.apply_tenant_isolation`
already refuses any table without one. `billing_events` therefore stays a global table and does not
carry a foreign key toward either new table added here -- the application resolves which
subscription or ai_subscription a processed event affects from the payload itself, the same way
`erpnext_id_mappings` in `000015_create_finance_cache_tables.sql` resolves identity from its own
crosswalk rather than a rigid foreign key.

## RLS and grants

`subscriptions` and `ai_subscriptions` follow this repo's uniform tenant treatment: owned by
`studafy_admin`, granted CRUD to `studafy_app`, revoked from `PUBLIC`, and carrying the canonical
`FOR ALL TO PUBLIC` `tenant_isolation` policy via `app.apply_tenant_isolation`, with RLS enabled and
forced.

`billing_events` is different -- **global-admin scoped** -- because unlike the six pre-existing
global tables (`schools`, `plans`, `plan_prices`, `countries`, `currencies`, `platform_settings`,
all classified in `db/policies/tenant_isolation.sql`), it carries externally-sourced payment-provider
payloads rather than mostly-public reference data:

- The default CRUD grant `studafy_app` would otherwise receive by
  `ALTER DEFAULT PRIVILEGES FOR ROLE studafy_admin IN SCHEMA app` (`000002`) is explicitly revoked,
  the same way `000004` narrowed access for the six existing global tables.
- RLS is enabled and **forced** (this repo's uniform posture for every RLS-bearing table), with one
  policy, `global_admin_only`, naming `studafy_admin` explicitly rather than `PUBLIC`. Access
  therefore depends on both the grant and the policy, not either alone -- the same defense-in-depth
  reasoning `000002` gives for revoking `PUBLIC`'s schema/database defaults that were already absent.
- There is still no `BYPASSRLS` role anywhere in this schema
  (`db/migrations/000002_create_database_roles_and_grants.sql`); processing an inbound webhook is a
  controlled-maintenance write performed under `studafy_admin`, the same role migrations already use,
  not a new role. `docs/database/role-model.md` deliberately keeps to exactly two roles.

## Index rationale

- `uq_subscriptions_school`, `uq_ai_subscriptions_school_student`, and
  `uq_billing_events_provider_event_id` cover the one-current-row-per-tenant and dedup lookups
  respectively, and each already leads with (or is) the foreign key column(s) that need it.
- `idx_subscriptions_plan_id`: backs `plan_id`'s parent update/delete check, matching the precedent
  `idx_plan_prices_currency_id` sets in `000004` for a tenant/global-reference column with no other
  query need yet.
- No additional index is added to `ai_subscriptions` or `billing_events`: their unique constraints
  already cover every foreign key and the one documented access pattern each table has today. Adding
  more would be speculative.

## Known gaps

Not built here, and deliberately out of scope for this migration:

- No subscription history/versioning table. `app.billing_events` is the durable event history;
  duplicating it as a second, row-per-change subscription ledger would drift from it. If a future
  requirement needs "what was this school's plan on date X," it is answered by replaying
  `billing_events`, not by a new table.
- No webhook signature verification, retry/backoff, or processing-status column on `billing_events`.
  This migration is the dedup and storage layer only; verifying and processing a delivery is
  application/worker logic, the same restraint `000015` documents for `finance_sync_outbox`'s
  retry fields.
- No `plan_id` on `ai_subscriptions` and no AI-specific plan/price table. The ticket describes a
  single per-student entitlement, not a priced AI plan catalog; nothing in this repository's ADRs or
  existing plan model asks for one yet.
