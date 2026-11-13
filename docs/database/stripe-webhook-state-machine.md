# Stripe webhook state machine

How an inbound Stripe webhook becomes a subscription status change, and what happens when it cannot.

Implementation: [`packages/billing/src`](../../packages/billing/src) (state machine, attribution,
fold, apply), [`apps/api/src/modules/subscriptions/stripe/webhook-processor.ts`](../../apps/api/src/modules/subscriptions/stripe/webhook-processor.ts)
(signature verification and transaction boundary),
[`apps/workers/src/queues/billing/billing-event.service.ts`](../../apps/workers/src/queues/billing/billing-event.service.ts)
(retry and dead-lettering). Schema:
[`000078_normalize_billing_events.sql`](../../db/migrations/000078_normalize_billing_events.sql).

See also [subscriptions-data-model.md](./subscriptions-data-model.md) for what the three tables own.

---

## Vocabulary

States are the seven values of `app.subscription_status`, shared by `app.subscriptions` and
`app.ai_subscriptions`. There is no separate AI status enum and no new states were invented here.

| State          | Live? | Meaning                                                             |
| -------------- | ----- | ------------------------------------------------------------------- |
| `trialing`     | yes   | Genesis. Created, not yet paid for.                                 |
| `active`       | yes   | Paid and current.                                                   |
| `past_due`     | yes   | A renewal charge failed; dunning is in progress. Access retained.   |
| `grace_period` | yes   | Dunning exhausted; the last window before lockout. Access retained. |
| `canceled`     | no    | Ended, by the customer or by the provider. Terminal.                |
| `expired`      | no    | The period lapsed without renewal. Terminal.                        |
| `closed`       | no    | Tenant fully locked. Terminal.                                      |

The ST-132 ticket writes these as "grace" and "suspended". The repository has said `grace_period`
and `closed` since ST-092 (SAD §11), and ST-134/ST-136 consume those names:

| Ticket text | This schema    |
| ----------- | -------------- |
| grace       | `grace_period` |
| suspended   | `closed`       |

`'suspended'` is a real value of `app.school_status`, `app.user_status`, `app.student_status` and
`app.teacher_status` — which is where the word comes from — but it has never been a subscription
status, and the JWT `subscriptionStatus` claim is validated with `z.enum(SUBSCRIPTION_STATUSES)`, so
a token could not carry it even if one were added.

The ticket also asks for a `suspended → canceled` edge. It is deliberately absent: `closed` is
defined as terminal by SAD §11 and by the header of
[`packages/constants/src/subscription-status.ts`](../../packages/constants/src/subscription-status.ts),
and an edge out of it here would make two documents disagree about one enum.

## Intents

The transition tables are keyed on `(from_state, intent)`, not on the raw Stripe event type. Stripe
sends `customer.subscription.updated` for a renewal, a failed payment, a pause and a cancellation
alike — the discriminator is the `status` field inside the payload. A table keyed on the event name
would have to map that one name to one target, which is exactly the ad-hoc inference this design
removes.

`deriveIntent(eventType, payload)` is the single place Stripe's vocabulary is read, and it returns
one of three things:

| Result       | Meaning                                       | Outcome                                                        |
| ------------ | --------------------------------------------- | -------------------------------------------------------------- |
| `transition` | The event means something for status.         | Folded (below).                                                |
| `ignored`    | A known event with no status meaning.         | Recorded, `status = 'processed'`, no transition, no audit row. |
| `unmapped`   | An event this processor does not know at all. | Parked (`status = 'dlq'`).                                     |

`ignored` is an allowlist, not a catch-all default. Silently ignoring anything unrecognised would
make a genuinely new Stripe event — the kind that should wake somebody up — indistinguishable from a
`charge.succeeded` nobody ever cared about.

### Event type → intent

Fixed by event type:

| Stripe event                                | Intent              |
| ------------------------------------------- | ------------------- |
| `checkout.session.completed`                | `activated`         |
| `customer.subscription.deleted`             | `canceled`          |
| `customer.subscription.paused`              | `dunning_exhausted` |
| `invoice.paid`, `invoice.payment_succeeded` | `activated`         |
| `invoice.payment_failed`                    | `payment_failed`    |
| `invoice.marked_uncollectible`              | `grace_exhausted`   |

Taken from the payload's `status` field, for `customer.subscription.created`, `.updated`
and `.resumed`:

| Stripe subscription status | Intent                |
| -------------------------- | --------------------- |
| `trialing`                 | `trial_started`       |
| `active`                   | `activated`           |
| `past_due`                 | `payment_failed`      |
| `unpaid`, `paused`         | `dunning_exhausted`   |
| `canceled`                 | `canceled`            |
| `incomplete_expired`       | `expired`             |
| `incomplete`               | _(none — ignored)_    |
| anything else              | _(unmapped — parked)_ |

`incomplete` means the customer opened Checkout and has not paid. Treating it as a transition would
move a subscription on the strength of an abandoned browser tab.

## School subscription transitions

`app.subscriptions.status`. Blank cells are illegal and park the triggering event.

| from \ intent  | `trial_started` | `activated` | `payment_failed` | `dunning_exhausted` | `grace_exhausted` | `canceled` | `expired` |
| -------------- | --------------- | ----------- | ---------------- | ------------------- | ----------------- | ---------- | --------- |
| `trialing`     | `trialing`      | `active`    | `past_due`       | `grace_period`      | —                 | `canceled` | `expired` |
| `active`       | —               | `active`    | `past_due`       | `grace_period`      | —                 | `canceled` | `expired` |
| `past_due`     | —               | `active`    | `past_due`       | `grace_period`      | —                 | `canceled` | `expired` |
| `grace_period` | —               | `active`    | `grace_period`   | `grace_period`      | `closed`          | `canceled` | `expired` |
| `canceled`     | —               | —           | —                | —                   | —                 | —          | —         |
| `expired`      | —               | —           | —                | —                   | —                 | —          | —         |
| `closed`       | —               | —           | —                | —                   | —                 | —          | —         |

The lifecycle the ticket asks for, in this vocabulary:

```
trialing ──activated──→ active ──payment_failed──→ past_due ──dunning_exhausted──→ grace_period
                          │                           │                                │
                          │                           └────────activated───────────────┤ (recovered)
                          │                                                            │
                          └───────────canceled───────────→ canceled            grace_exhausted
                                        (voluntary)                                    │
                                                                                       ↓
                                                                                     closed
```

Self-edges (`active + activated → active`) are legal on purpose. A renewal, a repeated failed charge
and a re-delivered event are all ordinary, and modelling them as legal no-ops is what stops the fold
from parking events that are merely unsurprising. They update the period and provider ids but write
no audit row — `app.audit_logs` records changes, and `active → active` would be noise.

## AI subscription transitions

`app.ai_subscriptions.status`. The Stripe-driven table is **identical** to the school table above.
Both columns are the same enum and both describe the same paid-access lifecycle. It is kept as a
separate binding (`AI_TRANSITIONS`) so ST-136 can diverge it without touching the school lifecycle.

What actually makes an AI subscription different is the cross-entity rule, which no Stripe event
expresses.

### Cross-entity: school → AI

ST-131 makes an active school subscription a precondition for buying an AI add-on, so the AI
entitlement cannot outlive its school's. Applied in the same transaction as the school's own change,
and audited per affected row.

| School transition                      | AI subscriptions for that school |
| -------------------------------------- | -------------------------------- |
| live → live (e.g. `active → past_due`) | unchanged                        |
| live → `canceled`                      | → `canceled`                     |
| live → `expired`                       | → `expired`                      |
| live → `closed`                        | → `closed`                       |
| non-live → anything                    | unchanged                        |

"Live" is `trialing`, `active`, `past_due`, `grace_period`.

Two asymmetries, both deliberate:

- **Recovery does not cascade.** A school going `past_due → active` does not resurrect AI
  subscriptions that were canceled with it. Re-entitling a student is a billing decision with a
  price attached, and inventing one here would silently grant paid access. ST-136 owns pause/resume.
- **Terminal AI rows are not dragged along.** A student whose AI subscription was already `canceled`
  stays `canceled` when their school closes — terminal states are absorbing here for the same reason
  they are in the transition table.

## Ordering: the fold

Stripe does not guarantee delivery order. State is therefore **re-folded from genesis over the whole
ordered history**, not patched onto the current value.

On every transition-bearing event:

1. Load every `processed` event for this subscription, plus the one being processed now, ordered by
   `(effective_at, provider_event_id)`. Served by `idx_billing_events_subscription_effective`.
2. Fold `resolveTransition` over that sequence, starting from `trialing`.
3. Write the result.

`effective_at` is Stripe's own `created` timestamp, never receipt time. `provider_event_id` is the
tiebreaker: two Stripe events can share a `created` second, and an ordering that is not total would
let the planner's row order decide the answer.

### Why not a watermark

The cheaper design — keep the newest `effective_at` applied and ignore anything older — is **not**
permutation-invariant. Take a cancellation at T1 and a renewal at T2 > T1, where the renewal cannot
legally follow a cancellation:

| Arrival order        | What happens                                                       | Final state |
| -------------------- | ------------------------------------------------------------------ | ----------- |
| cancel, then renewal | cancel applies; renewal hits an absorbing state and is parked      | `canceled`  |
| renewal, then cancel | renewal applies; cancel is older than the watermark and is skipped | `active`    |

Same two events, two different final states, decided by network timing. Re-folding has no such
freedom: the sequence handed to `foldStatus` is the same set sorted the same way whatever order the
deliveries arrived in, so the result is a pure function of the set. That is the property
`webhook-ordering.test.ts` asserts over all 120 permutations of a five-event sequence.

Only `processed` rows join the fold. A `failed` or `dlq` row never contributed to the current state,
and letting one join retroactively — because some later event happened to trigger a reload — would
apply an event that was explicitly rejected.

## Failure modes

Three ways an event can fail, and they are not the same thing.

|                                                         | Recorded?                                  | Retried?        | Recovery                               |
| ------------------------------------------------------- | ------------------------------------------ | --------------- | -------------------------------------- |
| **Rejected at the door** — missing or invalid signature | No                                         | No              | Caller fixes the secret. 400 + alert.  |
| **Parked** — `status = 'dlq'`                           | Yes, with `last_error` and full payload    | No              | A human.                               |
| **Failed** — `status = 'failed'`                        | Yes, with `last_error` and `attempt_count` | Yes, via BullMQ | Automatic; dead-letters on exhaustion. |

An unverified body never becomes a row. Recording them would let anyone fill the table.

Parked events are terminal because a retry produces the same verdict:

- **Unmapped event type.** Stripe added something we do not model.
- **Unattributable.** No `stripe_customer_id` match and no usable `metadata.school_id`, or the school
  has no subscription this event could apply to.
- **Illegal transition.** The `(from_state, intent)` pair has no target — a stray
  `customer.subscription.updated` claiming a canceled subscription is active, for instance.

Every parked and failed row keeps the verbatim provider payload in `payload`, so a manual replay has
everything the original delivery had except the raw bytes (which only mattered for the signature,
already verified once at intake).

Everything answers **200**, including parked events. A 4xx would make Stripe redeliver indefinitely —
the same reasoning [`apps/api/src/erpnext/webhook.ts`](../../apps/api/src/erpnext/webhook.ts)
documents for unknown doctypes.

## Idempotency and concurrency

The dedupe key is `app.billing_events.provider_event_id` — Stripe's **event** id (`evt_…`), never the
id of the object the event describes. Several events concern one subscription; keying on the object
id would make the second look like a replay of the first and silently drop it.

Claiming is one statement:

```sql
INSERT INTO app.billing_events (...) VALUES (...)
ON CONFLICT (provider, provider_event_id) DO NOTHING
RETURNING id
```

Zero rows returned means another delivery already claimed it. Under concurrent redelivery the second
transaction blocks on `uq_billing_events_provider_event_id` until the first commits, then returns
nothing — the loser exits cleanly, with no application-level mutex and no advisory lock. Per-event
granularity, unlike the global `pg_try_advisory_lock` the migration runner uses, and the same claim
shape `app.erpnext_webhook_dedup`, `app.email_deliveries` and `app.notification_idempotency_keys`
already rely on.

## Audit

Every status change writes one `app.audit_logs` row **inside the same transaction** as the change:
`action = 'update'`, `target_table` = `subscriptions` or `ai_subscriptions`, `target_id` = the row's
uuid, `old_values`/`new_values` = `{ "status": ... }`. The school→AI cascade writes one row per
affected student.

`actor_id` is NULL. The `app.user_id` GUC is deliberately left unset by the webhook's tenant scope,
because no person did this — a machine did.

If the audit write throws, the transaction rolls back and takes the status change _and the claim_
with it, so the next delivery of that event is a fresh attempt rather than a permanent hole. That
coupling is the mechanism, not a hazard: an unaudited billing transition is worse than an unapplied
one, because the transition can be reapplied and the audit cannot be reconstructed.

## Attribution

The school must be resolved before tenant isolation can be armed, and every subscription table is
RLS-forced — so attribution runs in two steps either side of that boundary.

1. **Before the tenant scope**, reading only global tables: `payload.customer` →
   `app.schools.stripe_customer_id`. Falls back to `metadata.school_id`, which our own Checkout call
   sets. `app.schools` is one of the six global, non-RLS tables, which is what makes this possible at
   all.
2. **`set_config('app.school_id', …, true)`**, mid-transaction. Transaction-local, so it evaporates
   at COMMIT — safe under PgBouncer transaction pooling.
3. **After the tenant scope**: the provider subscription id (`sub_…`) against
   `ai_subscriptions.stripe_subscription_id` then `subscriptions.stripe_subscription_id`; then
   `metadata.student_id` for a per-student AI row; then the school's single school subscription,
   which `uq_subscriptions_school` makes unambiguous.

`checkout.session.completed` carrying a `student_id` is the one event that _creates_ an AI
subscription row. Any later event naming a student we have no row for is a genuine inconsistency and
is parked rather than papered over by conjuring a paid entitlement out of an invoice.

`customer.created` and `customer.updated` short-circuit before attribution and repair
`app.schools.stripe_customer_id` when it is NULL. They concern a school that may not have bought
anything yet, so running them through attribution would fill the dead-letter queue with events
behaving exactly as intended.

## Schema decisions

Recorded in full in the header of
[`000078_normalize_billing_events.sql`](../../db/migrations/000078_normalize_billing_events.sql);
summarised here.

**Mutable per event, not append-only.** One row per `(provider, provider_event_id)`, updated across
retries. A row-per-attempt model would need a second identity, and losing the unique constraint would
take the dedupe guarantee with it — the constraint _is_ the arbiter. `DELETE` remains withheld. This
amends the "append-only" description in 000016's header.

**Not partitioned, deliberately.** `audit_logs` and `attendance_records` partition monthly because
their volume is per-actor and per-student-per-schoolday. `billing_events` is driven by subscription
lifecycle: order-of-a-dozen rows per school per year, comfortably under 10⁶ rows/year at 10,000
schools. Revisit past ~50M rows, or if a retention policy wants to drop old events by month.

**Global-admin scoped, not tenant-isolated.** Deduplication happens before the payload is understood
well enough to attribute a school, so the table cannot carry a `NOT NULL school_id` and cannot take
`app.apply_tenant_isolation`. `studafy_app` holds no privilege on it at all — stricter than the
ticket's suggested "INSERT/SELECT for the app role" — and the processor runs as `studafy_admin`.

**`processed` does not imply attributed.** Some provider events sit above the subscription level;
`customer.created` concerns a school, not any one subscription.
