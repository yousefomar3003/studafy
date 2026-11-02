# Webhook DLQ drain

Failed jobs in a dead-letter state need an operator to decide their fate. This runbook covers the
two durable dead-letter surfaces in this repo — `app.notification_dead_letters` (notification
dispatch, one row per terminally failed job) and `app.billing_events.status = 'dlq'` (Stripe
webhook events, marked on the event row itself) — plus the two webhook _intake_ paths that have no
DLQ at all and depend on provider redelivery instead. A "drain" is deciding each parked job's fate
(replay, drop, or investigate) — not blindly re-running everything.

Mechanism source: `apps/workers/src/queues/notifications/dead-letter.ts`,
`apps/workers/src/queues/billing/billing-event.service.ts`,
[`packages/constants/src/queues.ts`](../../packages/constants/src/queues.ts),
`apps/api/src/email/webhook.ts` (SES/SNS), `apps/api/src/erpnext/webhook.ts` (ERPNext).

## Detection

- **The durable record, queried directly.** Every terminally failed notification-dispatch job
  writes a row to `app.notification_dead_letters` (`ON CONFLICT (school_id, queue_name, job_id) DO
NOTHING` — a re-run of the handler is a no-op, not a duplicate alert) and emits
  `notification.dispatchFailed` into the outbox. Every failed Stripe `process-billing-event` job is
  marked `status = 'dlq'` on its `app.billing_events` row with the reason in `last_error`.
- **The structured log lines.** `notification_dispatch_dead_lettered` /
  `billing_event_dead_lettered` are the unconditional, database-independent alert paths
  (`apps/workers`' CloudWatch logs, `event` field above). These fire even when the database write
  itself fails.
- **BullMQ metrics.** Prometheus `bullmq_job_outcomes_total{outcome="failed"}` per queue, and the
  failed-set depth (`bullmq_queue_jobs{state="failed"}`), both on the Workers dashboard
  (`docs/runbooks/metrics-dashboard-catalog.md`). A sustained failed rate with no corresponding
  dead-letter rows means the dead-letter _writes_ are failing — see "Write failure" below.

No CloudWatch alarm targets DLQ depth today; the standing signal is dashboard drift + the log
lines above. Known gap at the bottom.

## What is and isn't the dead-letter record

The durable record is the **Postgres row**, not a Redis list. `notifications-dlq` exists as a
_reserved name_ for a future replay tool and deliberately has no BullMQ `Worker` attached — a
queue with a worker is in `QUEUE_NAMES`, and dead-letter names are in a separate constant so
"attach a worker to a DLQ" is a compile error. BullMQ's own failed set is the backstop of record
for 30 days (`removeOnFail: { age: 30d }`), already retains `job.data`, `failedReason`, and
per-attempt stacks, and already supports `job.retry()`.

Consequence for a drain: **there is no replay tool yet.** Draining is done with `job.retry()` from
BullMQ's failed set, or by hand for billing rows. This runbook is honest about that, not a
substitute for the tool.

## Decision points

1. **Which surface?** Notification dead letters (row in `app.notification_dead_letters`) vs.
   billing events (`status='dlq'`) vs. **missing** dead letters for a job that visibly failed —
   the last is the "write failure" case (step 4), an infrastructure problem, not a drain.
2. **Replay, drop, or investigate?** Default by surface:
   - _Notifications_ — replay once after confirming the underlying cause is gone (Redis, SES,
     FCM): a dispatch whose failure was an outage is worth re-running; a dispatch whose failure
     was permanent (bad recipient token, dead device, malformed channel config) must be dropped,
     or replay just refills the DLQ.
   - _Billing_ — a `dlq` row is a _deliberate park_; `processStripeBillingEvent` refuses to
     re-run a `dlq` row ("only a human changes this outcome"). Replay only if the parked reason
     (unmapped event type, unattributable school) has since been fixed in code, then flip the row
     to `pending` and re-enqueue the job.
   - _Intake webhooks (email/ERPNext)_ — no DLQ at all; provider redelivery is the recovery path.
     Investigate only if redelivery is clearly exhausted (`app.email_events` gap for a known
     SendId, or a silent school-side gap for ERPNext).
3. **Is the cause one failing code path or a broad outage?** One `error_class` dominating a batch
   is a code bug (fix + report as a deploy issue); a spread across classes with a recent deploy is
   a regression (rollback per `deploy-rollback.md`); a spread across classes _without_ a deploy is
   an upstream outage (SES, FCM, Stripe) — wait for it, don't drain into it.

## Procedure

**1. Quantify the backlog.**

```sql
-- Notifications:
SELECT school_id, queue_name, job_name, error_class, count(*), max(created_at)
FROM app.notification_dead_letters
GROUP BY 1, 2, 3, 4 ORDER BY count(*) DESC;

-- Billing:
SELECT status, event_type, count(*)
FROM app.billing_events
WHERE status IN ('pending', 'failed', 'dlq')
GROUP BY 1, 2 ORDER BY count(*) DESC;

-- Intake webhooks, real gap or not? (email_events / billing_events / outbox_events
-- are the three projection sites; absence of a row where the provider says it sent one
-- is the gap to confirm against provider-side send history.)
```

**2. Read one representative failure per group.** Adult supervision, not automated: pull
`error_class`/`error_message`/`error_stack` from the dead-letter row (or `last_error` for billing),
cross-reference the queue's failed-job detail from BullMQ / the workers dashboard, and confirm the
cause in code before replaying a batch. This is the step that prevents "drain everything and
re-fill the DLQ."

**3. Replay the survivors.**

BullMQ failed set (notifications — the only surface with a queue-backed set):

```bash
# Node REPL / one-off script pointed at rediss://.../1 (queue DB), the same connection
# convention as apps/workers/src/connection.ts:
#   const { Queue } = require('bullmq');
#   const q = new Queue('notifications', { connection: {...} });
#   const failed = await q.getFailed(0, 1000);          // successful jobs are pruned by removeOnComplete
#   const kept = failed.filter(j => WHITELIST_OF_JOB_IDS_OR_DATA.includes(j.id));
#   await Promise.all(kept.map(j => j.retry()));
```

Filter **by data, not by failure** — a replayed job must be repairable. There is deliberately no
empty `retryAll`: it would re-run every permanently-failed dispatch.

Billing (no queue-backed survive-set; drive from the rows):

```sql
-- In a transaction, per replayed event, after the code fix ships:
UPDATE app.billing_events SET status = 'pending', last_error = NULL, updated_at = CURRENT_TIMESTAMP
WHERE provider = 'stripe' AND status = 'dlq' AND id = '<row-id>';
```

Then re-enqueue the `process-billing-event` job carrying only `{ providerEventId }` (the queue
job carries identity, the row carries the payload — `billing-event.service.ts`' header). Note
`reprocessClaimedEvent` races redelivery safely: `FOR UPDATE` on the row + the unique key makes a
concurrent retry fold history once.

**4. The "write failure" case.** A job is visibly failed in BullMQ but has no dead-letter row and
no `billing_event_dead_lettered` log line needs a different answer: the deceased handler exited on
its own connection (`deadLetterStripeBillingEvent` / `handleDeadLetter` open a fresh
`postgres(databaseUrl)`). The cause is that DB connection failing (`notification_dead_letter_write_failed`
/ `billing_dead_letter_write_failed` in logs). Fix the database connection, not the jobs; the
BullMQ failed set still holds the jobs, and the 30-day retention is the scheduling margin.

**5. Close the loop.** For `notification.dispatchFailed` dead letters, the outbox event carries a
`deadLetterId` for correlation; consumers that need more follow it to the row
(`apps/api/src/lib/events/schemas.ts`). If a replayed job re-dead-letters, it is not a flake —
return to step 2 with the failed stack, and do not drain the same group twice.

## Rollback / abort criteria

Abort the drain at step 3 if the failure cause is not yet understood (decision point 1). Draining
into a live outage only refills the dead letter. Stop replaying any group that re-fails with the
same `error_class` within one retry cycle.

## Known gaps

- **No replay tooling.** `DEAD_LETTER_QUEUE_NAMES.NOTIFICATIONS` is a reserved name for a tool
  that doesn't exist; every drain today is ad-hoc `job.retry()`/SQL. A
  `drain-dlq` CLI (siblings: `packages/db/src/cli.ts`) is the natural follow-up.
- **No alarm on DLQ depth.** The dead-letter write is alarmed-by-log only; nothing pages on a
  growing `app.notification_dead_letters` or a `dlq`-heavy `app.billing_events`. A Prometheus
  alert on the DB-backed counts is future work alongside the first real on-call surface.
- **Email/ERPNext intake failures have no durable record.** They fail open (5xx to the provider)
  and rely on SNS/ERPNext redelivery; there is no replay handle if the provider gives up. The SNS
  email path in particular (SES → SNS → `/email/webhooks/sns`) depends on SNS's retry schedule,
  which this repo does not control.
