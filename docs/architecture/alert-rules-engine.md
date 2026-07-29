# Attendance Alert Rules Engine (ST-110)

How an absent mark becomes a parent notification, and why each step is where it is.

Attendance was insert-only and inert: `app.attendance_records` was written and nothing read it back.
This is the first reactive path over it — a student's absences are evaluated against per-school
thresholds, and every linked parent is told exactly once per breach.

It is also the platform's first production writer of `app.notifications`. That table has existed
since migration `000017`; until now only tests inserted into it.

## The path

```
POST /api/attendance/records/batch          (or PATCH /api/attendance/records/{id})
  └─ withTenantTx: write attendance          ← commits
  └─ notificationsQueue.add("evaluate-attendance-alerts", …)
        └─ BullMQ `notifications` queue, concurrency 10
              └─ processAttendanceAlert()
                    ├─ load rules            app.attendance_alert_rules
                    ├─ evaluate              app.student_absence_days()
                    ├─ resolve parents       app.parent_child_links
                    ├─ CLAIM                 app.attendance_alert_logs  ← dedup happens here
                    ├─ notify                app.notifications
                    └─ emit                  app.outbox_events → relay → apps/realtime
```

Sources: [attendance-alert.worker.ts](../../apps/workers/src/queues/notifications/attendance-alert.worker.ts),
[enqueue-alerts.ts](../../apps/api/src/modules/attendance/enqueue-alerts.ts),
[000056](../../db/migrations/000056_create_attendance_alert_rules.sql).

## Rules

| `rule_type`        | Meaning                                                              | `window_days` |
| ------------------ | -------------------------------------------------------------------- | ------------- |
| `consecutive_days` | Unbroken run of absent school days **ending on the triggering date** | must be NULL  |
| `period_count`     | Absent school days within a rolling window                           | required      |

One rule per type per school (`uq_attendance_alert_rules_school_type`). A school with no active
rules falls back to `DEFAULT_ALERT_RULES` — three consecutive days. A missing configuration row
means "not customised", not "disabled"; the same reasoning as
`DEFAULT_CORRECTION_WINDOW_HOURS` in ST-109.

There is deliberately **no admin API** for these rules yet. Adding routes would pull in four pinned
CI route-lists, and the ticket asked for the engine, not the settings screen. Rules are set by
direct insert until that surface exists.

### What counts as an absent day

A day is absent if the student missed **any** period that day (`bool_or`). Counting periods instead
would make a school with eight periods breach a three-day threshold before lunch.

Days with no session at all — weekends, holidays — produce no row, so they neither count as absent
nor break a consecutive run. A `cancelled` session is excluded: it was never taken, so its rows are
not evidence of anything.

A `consecutive_days` run must _end_ on the triggering date. Three absences last week are history,
not an alert.

## Why the absence query is a SECURITY DEFINER function

`app.attendance_records` carries no `attendance_date` and no `class_id` — both are functionally
dependent on the session (see `000012`). So every absence window joins records up to
`app.attendance_sessions` for `session_date`. Both tables are RANGE-partitioned monthly on
`created_at`, so both sides of that join carry a `created_at` lower bound **purely** so the planner
can prune partitions. `session_date` is the semantic filter; the `created_at` bounds narrow nothing
and exist only for the plan. Dropping either makes the planner read every monthly partition of that
table.

The bounds carry a month of slack because `created_at` and `session_date` are different clocks:
attendance recorded late, or a session opened in advance, puts them on different days.

The query lives in `app.student_absence_days(...)` as `SECURITY DEFINER` because
`attendance_records` has a `role_scope_visibility` policy resolving the acting user from
`app.user_id` — and an unattended worker has none. Under `studafy_app` it read **zero rows**, which
is indistinguishable from "nobody was absent": the worst possible failure mode for an alerting
feature, because it is silent. The function crosses row scope and nothing else; it re-asserts
`school_id = current_setting('app.school_id')` in its own body, so tenant isolation is not crossed.

## Why the worker elevates its role

Four of the tables the worker touches — `attendance_records`, `students`, `notifications`,
`attendance_alert_logs` — carry RESTRICTIVE policies granted `TO studafy_app`. A restrictive SELECT
policy also gates `INSERT ... RETURNING`, so the worker could neither read nor write.

`withSystemTenantTx` sets `app.school_id` and then `SET LOCAL ROLE studafy_admin` inside the
transaction. This is safe, and the reason is worth stating precisely:

- `studafy_admin` has **neither SUPERUSER nor BYPASSRLS**, and every table involved is created with
  **FORCE ROW LEVEL SECURITY**, which extends RLS to the table owner. `tenant_isolation` is granted
  `TO PUBLIC`, so it still binds completely. A bug here cannot cross a tenant boundary.
- The row-scope policies are granted `TO studafy_app` specifically, so they lift.

That is exactly the distinction wanted: a system actor sees its whole tenant and no more. Use
`withTenantTx` for anything acting on behalf of a user; `withSystemTenantTx` only where the actor
genuinely is the system.

## Deduplication

The acceptance criterion is zero duplicate alerts under BullMQ retries, duplicate enqueues, and
concurrent workers. Check-then-write cannot deliver that at any level of care — two processes can
both read "not yet sent" before either writes.

So the order is inverted. The worker **claims** the alert first:

```sql
INSERT INTO app.attendance_alert_logs (...)
VALUES (...)
ON CONFLICT ON CONSTRAINT uq_attendance_alert_logs_dedup DO NOTHING
RETURNING id
```

A returned row means "you own this alert, send it". No row means an earlier run already holds it.
**The unique index is the arbiter, not application logic** — which is what makes it correct under
concurrency rather than merely usually correct. This follows the repo's existing idiom
(`app.erpnext_webhook_dedup`, `000027`); there are no Redis locks anywhere in this codebase and
this does not introduce the first.

### The key includes `parent_user_id`

`uq_attendance_alert_logs_dedup (school_id, student_id, parent_user_id, dedup_key)`.

ST-110's specification proposed `(school_id, student_id, dedup_key)`. That is wrong for a table
that also has `parent_user_id`: one breach fans out to every linked parent, so the first parent's
row would swallow the second parent's insert and that parent would silently never be told. **The
dedup unit is the notification, not the breach.**

`dedup_key` is `<rule_type>:<threshold_value>:<boundary_date>`. School, student and parent are
columns of the table and stay out of the string rather than being duplicated inside it. The
threshold is part of the key deliberately: a school raising its bar is a different alerting
condition and should be able to re-alert.

### The cost: a visible orphan

Claiming before notifying means a crash in between leaves a log row with a null `notification_id`.
That is the right way round. An alert recorded but not delivered is a diagnosable gap; one
delivered twice is an angry parent and an unfixable record.

## The trigger, and its honest gap

The API enqueues **after** the attendance transaction commits — the pattern `bulk-invite-routes.ts`
and `import-routes.ts` already use. A job referencing rows that were rolled back is worse than a job
that was never queued.

The cost is real: **a crash between COMMIT and the enqueue loses the evaluation for that
submission.** Those absences are not evaluated until the student's next one triggers a fresh job.
`enqueueAttendanceAlerts` also swallows enqueue failures, logging at `warn` — alerting is downstream
of attendance, and a teacher must not get a 500 because Redis is unreachable when their register
committed fine.

The transactional alternative is the outbox, which is not used here because the relay has no BullMQ
fan-out (it only publishes to Redis pub/sub) and is driven by a `SCHOOL_IDS` env var that is empty
by default and absent from the production task definition. Building that fan-out is the right
follow-up if the gap ever matters.

Both write paths enqueue: recording a roster, and **correcting a record into `absent`** — a
correction can complete a run that the batch path, which only sees the day it was submitted, would
never notice. Correcting _away_ from `absent` enqueues nothing; alerts already sent stay sent, and
the log is immutable.

## Delivery

One `app.notifications` row per claimed parent (`notification_type = 'ATTENDANCE_ALERT'`, added to
the enum by `000057` in lockstep with `packages/constants`), plus **one**
`attendance.alertRaised` outbox event per breach — not per parent. Consumers care that the threshold
was crossed; the recipient list is a property of that fact. The relay publishes it and
`apps/realtime` pushes it to connected clients.

There are no push, SMS, or email pipelines in this repo to hand off to. When they exist, they
consume `attendance.alertRaised` rather than changing this worker.

> **jsonb payloads must use `tx.json(...)`, never `JSON.stringify(...)` + `::jsonb`.** With an
> explicit cast postgres.js infers the parameter type as jsonb and JSON-encodes the string it was
> given, producing a jsonb _string_ rather than an object. `ck_notifications_metadata` rejects that
> outright; `app.outbox_events` has no such CHECK and would store it silently, corrupting every
> consumer downstream. `bulk-invite-processor.ts` has this bug today.

## Deployment

`apps/workers` needs Postgres, which it did not have. The ECS task definition supplied only
`NODE_ENV` and `REDIS_URL`, so the process fell through to `postgres://localhost:5432/studafy` — the
alert engine could not have run in any deployed environment, and the outbox relay was already broken
for the same reason.

`infra/deploy/ecs/workers/task-definition.json.tpl` now supplies `DATABASE_HOST`/`PORT`/`NAME` and
the PgBouncer credentials, mirroring the API. `apps/workers/src/env.ts` accepts those discrete
variables and composes a URL via `databaseUrlFrom()`, preferring them over `DATABASE_URL` — which
still carries its localhost default, so preferring the URL would silently point a deployed worker at
nothing.

Two caveats worth knowing:

- `infra/docker/workers/healthcheck.ts` probes **only Redis**. A Postgres outage will not mark the
  container unhealthy.
- `SCHOOL_IDS` is still absent from the task definition, so the outbox relay remains inert in
  production and `attendance.alertRaised` will not reach WebSocket clients there until it is set.
  The notification rows are written regardless.

## SLA

The requirement is under two minutes from absent mark to parent notification. The budget is
dominated by queue latency, not by this worker: evaluation is one indexed function call plus a
handful of single-row writes per student, and the queue runs at concurrency 10. Measured on the
development container the whole evaluation is single-digit milliseconds per student.

## Testing

[attendance-alert.test.ts](../../apps/workers/src/queues/notifications/__tests__/attendance-alert.test.ts)
— 26 tests. The pure evaluation functions always run; everything proving the actual guarantee needs
a real database, because the guarantee _is_ a unique index.

The two that matter most:

- **replay** — running the same job twice writes nothing the second time.
- **concurrency** — two processors racing on the same breach produce exactly one notification per
  parent. This is what a BullMQ retry overlapping a slow first attempt actually looks like, and no
  amount of read-then-write could arbitrate it.

```bash
bun run db:up && bun run db:migrate
TEST_DATABASE_URL='postgresql://studafy_test:studafy_test@127.0.0.1:54329/postgres?sslmode=disable' \
  bun test src/queues/notifications --cwd apps/workers
```
