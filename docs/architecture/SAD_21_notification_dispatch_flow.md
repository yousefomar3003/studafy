# Notification dispatch flow (SAD §21)

How a published grade becomes a set of per-recipient notifications, and why each step is where it is.

## An assumption this document is built on

ST-139 cites **SAD section 21** as the source of this flow. The SAD is not in this repository —
`docs/architecture/SAD_28_logging_conventions.md` records the same gap for section 28,
`db/migrations/000018_create_partitioned_audit_logs.sql` for section 15, and
`docs/api/global-data-erd.md` for section 10. The design below is therefore taken from the ticket's
own stated requirements and from what the schema and the existing workers already establish. **This
document does not claim that the unavailable SAD text was inspected.** If the SAD later contradicts
it, a follow-up ticket reconciles the two.

Four parts of the ticket describe a system that does not exist here. Each is called out at the point
where this implementation diverges, with the reason.

## The path

```
  teacher approves a grade submission
            │
            ▼
  decideSubmission()  ── draft → submitted → approved → published, one transaction
            │
            ├──▶ emit(GRADES_PUBLISHED) ──▶ app.outbox_events ──▶ relay ──▶ Redis pub/sub
            │                                                  (inert in production — see below)
            │
            ▼  after COMMIT
  enqueueNotificationDispatch()  ──▶ BullMQ `notifications` / dispatch-notification
            │
            ▼
  processNotificationDispatch()
            │
            ├─ resolveGradeContext()      submission → gradebook → class → course, + grade summary
            ├─ resolveGradeRecipients()   the student's user + app.parent_child_links
            │
            └─ for each recipient × channel, one transaction:
                 ├─ preference?  app.notification_preferences   → suppressed_preference
                 ├─ quiet hours? app.user_notification_settings → suppressed_quiet_hours
                 ├─ reserve      app.notification_idempotency_keys
                 ├─ render       @studafy/notification-templates  (ar | en)
                 └─ deliver      in_app → app.notifications
                                 push/email → BullMQ deliver-notification
            │
            ▼  on terminal failure only
  deadLetterListener() ──▶ app.notification_dead_letters
                       └─▶ app.outbox_events (notification.dispatchFailed)
```

Sources: [enqueue-dispatch.ts](../../apps/api/src/modules/grades/enqueue-dispatch.ts) ·
[dispatcher.worker.ts](../../apps/workers/src/queues/notifications/dispatcher.worker.ts) ·
[recipient.resolver.ts](../../apps/workers/src/queues/notifications/resolvers/recipient.resolver.ts) ·
[quiet-hours.ts](../../apps/workers/src/queues/notifications/quiet-hours.ts) ·
[dead-letter.ts](../../apps/workers/src/queues/notifications/dead-letter.ts) ·
[000074](../../db/migrations/000074_notification_dispatcher_tables.sql)

## Why the API enqueues the job instead of the worker consuming the event

The natural design is for the dispatcher to consume `grades.published`. It cannot, for two
independent reasons.

There is no outbox-to-BullMQ bridge. The relay publishes to the Redis pub/sub channel
`events:{school_id}:{event_name}`, and the only subscriber is in `apps/api`. `QUEUE_NAMES.OUTBOX_RELAY`
has a placeholder processor.

And the relay does not run in production. `apps/workers/src/index.ts` starts it only when
`env.SCHOOL_IDS` is non-empty, and that variable is absent from the ECS task definition — the gap
`docs/architecture/alert-rules-engine.md` already records.

A dispatcher built on the event today would be correct and inert. So the API enqueues directly, which
is the pattern that demonstrably works here (`apps/api/src/modules/attendance/enqueue-alerts.ts`).
The outbox row is still written, so the event-driven path stays open to whoever fixes the relay — at
which point this producer becomes redundant rather than wrong.

The cost is stated plainly: the enqueue happens after COMMIT and never throws, so a crash between the
commit and the enqueue loses the notification for that publication. Failing the HTTP response instead
would tell a teacher their grade did not publish when it did.

## Why the job carries a submission id

> **Divergence.** ST-139 assumes the event carries `class_id`, `assessment_id` or `student_ids`.

The contract of record — `eventPayloadSchemas` in `apps/api/src/lib/events/schemas.ts`, exhaustive
over `DOMAIN_EVENTS` — is `{ submissionId, gradebookId, studentId, approvedByUserId }`. One
submission, one student.

Widening it was rejected. The event is already correct, it has a live subscriber, and the fields the
dispatcher wants are all derivable. An event says what happened, not what a consumer will need to say
about it. The resolver joins `grade_submissions → gradebooks → classes → courses` for the course name
and the graded student, then reads `parent_child_links` for the parents.

The submission id also **is** the event id in the idempotency key. Publication is a one-shot
`approved → published` transition, so that id is identical across a duplicate enqueue and a job
replay — exactly the property the key needs. A generated uuid would make every replay look like a new
event and notify everyone twice.

## Recipients

`{the graded student} ∪ {parents linked to them via app.parent_child_links}`, filtered to users whose
status is `active`.

The criterion "exactly the affected students and their linked parents" holds by construction rather
than by filtering afterwards: the query can only produce a student it was asked about, or a parent
with a link row to one of them. A classmate has no link. A parent of another child has no link.
`__tests__/dispatcher.test.ts` seeds both as negative controls, because a test that seeds only the
people who _should_ be notified cannot distinguish a correct query from `SELECT * FROM app.users`.

Non-active users are excluded here rather than downstream. `app.notification_preferences` is not
seeded until activation, so a suspended account would otherwise resolve to "every channel disabled"
and be logged as a preference suppression — a true row with a false reason.

## Preferences, and the table this ticket did not create

> **Divergence.** ST-139 asks for a `user_notification_preferences` table holding a
> `channels_enabled` JSONB blob.

`app.notification_preferences` has existed since 000017: one row per user × notification type ×
channel, seeded for every user at activation by `trg_users_seed_notification_preferences`, and
asserted against `pg_enum` by `packages/db/tests/notifications.test.ts`. Adding a second preference
table would have meant two sources of truth that disagree the first time either is written to, and
the blob shape is the wide repeating-group form 000017 argues against at length — it also cannot
express "email me about grades but not about attendance", which the existing table can.

So 000074 adds only what genuinely does not exist anywhere: `app.user_notification_settings`, holding
quiet hours, a per-user timezone, and a per-user locale override.

A channel with no preference row is treated as **enabled**. The seeding trigger's own default is
`true`, so a missing row means the channel enum gained a value after that user was activated.
Defaulting to disabled would silently mute every existing user the moment a channel is added.

## Quiet hours

Stored as two `time` values plus an IANA zone, not as timestamps: "do not disturb me between 22:00
and 07:00" is a wall-clock rule that must survive a daylight-saving transition unchanged, and an
instant cannot express that.

The recipient's current local time is computed **in SQL**:

```sql
(CURRENT_TIMESTAMP AT TIME ZONE coalesce(settings.timezone, school_settings.timezone, 'UTC'))::time
```

PostgreSQL ships and updates the IANA tz database; the Bun runtime's copy is whatever the base image
baked in, and a stale one is wrong precisely when a country changes its rules. What is left in
TypeScript is the comparison, which is pure and unit-tested.

> The window that wraps past midnight is the trap. `22:00–07:00` has `start > end` and is not an
> interval on one day, so the test flips from AND to OR. Getting it backwards yields a rule that is
> quiet all day except when the user asked for quiet — and it is completely silent.

Urgency is a code-level constant, not a column: it is a property of the notification _type_, and a
per-row column would let two notifications of the same type disagree about whether they may wake
someone up. Nothing is urgent today, which `quiet-hours.test.ts` asserts explicitly so that changing
it requires saying so.

## Idempotency: reserve, send, confirm

The key is `{event_type}:{event_id}:{recipient_id}:{channel}`, arbitrated by
`idx_notification_idempotency_unique (school_id, idempotency_key)`.

The channel is in the key because a recipient who should get both an email and a push is two
deliveries; keying without it would let the first channel's reservation swallow the second's — the
trap 000056 documents for `parent_user_id`.

`app.attendance_alert_logs` dedups with a bare `INSERT ... ON CONFLICT DO NOTHING`, and that is
correct _there_, because the claim and the notification commit together. This dispatcher is not in
that position for every channel:

| Channel        | Boundary                             | Transactions |
| -------------- | ------------------------------------ | ------------ |
| `in_app`       | a database write                     | one          |
| `push`/`email` | a Redis enqueue, then a delivery job | two          |

With a bare claim, a crash between the key insert and the enqueue would leave a committed key with
nothing sent. The retry would see the key, skip that recipient, and the job would then **succeed** —
a silent drop with no dead-letter row and no failed job. That is strictly worse than a duplicate.

So `reserved_at` claims and `dispatched_at` confirms, and a reservation older than the lease is
reclaimable. `dispatched_at IS NULL` means _the outcome is unknown_, not that nothing happened. Same
shape 000069 already uses for payment idempotency.

**The lease is two minutes, and both bounds are load-bearing.** It must exceed BullMQ's 30s
`lockDuration` plus the enqueue, or a merely slow worker has its reservation stolen and the recipient
is notified twice. It must fit inside the job's own retry window — five attempts with exponential
backoff from 5s is roughly 75s of delay — or no retry could ever reclaim a crashed attempt, and a
fifteen-minute lease would mean every retry skips the recipient it was retrying for.

**One transaction per recipient, never one per job.** A per-job transaction would roll back the
idempotency rows of recipients already sent to, turning a partial failure into guaranteed duplicates
— the exact outcome the ledger exists to prevent. It would also pin one PgBouncer server connection
across N external calls, ten deep at this queue's concurrency. The rule is already stated in
`attendance-alert.worker.ts`.

A **suppression claims no reservation**. Turning a channel back on has to be able to notify, and a
consumed key would prevent that forever.

## Templates

`@studafy/notification-templates`, lifted out of `apps/api` by this ticket because `apps/workers` has
no dependency edge to `apps/api` and the alternative — a second copy of nine types × three channels ×
two locales — would drift the first time either side was edited. `apps/api` re-exports it, so no API
call site changed.

Locale resolves recipient → school → `en`. Each candidate is **narrowed**, not trusted:
`school_settings.locale` enforces only a BCP-47 shape and the settings API accepts six locales, but
templates exist for two. A school set to `fr` falls through to English instead of indexing the
template map with `fr` and throwing at render time, one notification at a time, in production only.

The title comes from the `in_app` template and the body from the channel's own — the catalog stores
one string per channel and `app.notifications` needs two. `in_app` is the shortest of the three,
which is the right property for a title.

## Delivery

> **Divergence.** ST-139 names `push`, `email` and `sms`.

`sms` is not in `app.notification_channel` and has no template in `en.ts` or `ar.ts`. Adding it means
a `transaction=off` enum migration, three mirror lists, and eighteen new strings — for a channel with
no provider. Deferred.

More importantly: **there is no provider for any channel.** No SES, SendGrid or Resend; no
firebase-admin; no Twilio. `app.user_devices` has stored FCM tokens since 000017 and nothing has ever
read them.

So `in_app` is real — it writes `app.notifications`, which a user can see today — and `push`/`email`
are rendered, enqueued, and land in `delivery.worker.ts`, which resolves the recipient's routes and
logs `notification_delivery_no_provider` at `warn`. Their dispatch log stays at `enqueued` and is
never advanced to `delivered`.

That last point is the whole design of that file. Marking them `delivered` would make the audit trail
assert something false, and "the parents were never told" would become unanswerable from the data —
which is the one question `app.notification_dispatch_logs` exists to answer. A status of `enqueued`
that never advances is a visible gap; a `delivered` that never happened is a lie.

## Dead-lettering

> **Divergence.** ST-139 names a `notifications-dlq` BullMQ queue and an event
> `notification.dispatch.failed`.

**The durable record is `app.notification_dead_letters`, not a Redis list.** A queue with no worker
never completes a job, so `removeOnComplete` never fires and it grows without bound; BullMQ's own
failed set already retains job data, `failedReason` and per-attempt stacks for the 30-day
`removeOnFail` window, and already supports `job.retry()`. `notifications-dlq` is reserved in
`DEAD_LETTER_QUEUE_NAMES` — a constant deliberately separate from `QUEUE_NAMES`, so that attaching a
worker to a parking lot is a compile error rather than a review comment.

**The event is `notification.dispatchFailed`, with two segments.** `app.outbox_events.event_name`
carries `CHECK (event_name ~ '^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$')`. A three-segment name would be
rejected at INSERT time, inside the very transaction trying to record the failure — so the alert
would vanish in production and nowhere else. `packages/constants/src/events.test.ts` now asserts the
shape over every `DOMAIN_EVENTS` value, which is the gate that would have caught it at review.

**Detection keys on `job.finishedOn`, not on an attempt count**, for three reasons:

1. `attemptsMade` means opposite things in the two places it is read. Inside a processor it counts
   _prior_ attempts — hence `attemptsMade + 1 >= attempts` in `attendance-export.worker.ts`. BullMQ
   increments it at the end of `moveToFailed`, _before_ emitting `failed`, so in a listener the same
   field is already incremented.
2. A job whose worker was killed mid-dispatch stalls, and once past `maxStalledCount` BullMQ returns
   it to `wait` with a deferred-failure marker; the next worker fails it as an `UnrecoverableError`
   **without ever calling the processor**, at an attempt count below the limit. An in-processor check
   cannot see that path at all.
3. `finishedOn` is assigned only in the no-retry branch. It is exactly the question being asked, with
   no arithmetic and no coupling to `opts.attempts` — which the producer owns, not the worker.

The listener is attached in `createBullmqWorker`, not `startWorkers`: doing it there would require
widening `StoppableWorker` with `on(...)`, which every `{ close }` fake in `worker.test.ts` would
then fail to satisfy. `createBullmqWorker` already needs a live Redis and is already not unit-tested,
so the logic lives in a plain function the tests call directly.

**Stack traces never enter the outbox payload.** `outbox-relay/relay.ts` publishes payloads verbatim
to `events:{school_id}:{event_name}` with no redaction, and outbox rows are never reaped. A dispatch
stack routinely carries recipient addresses and provider request ids. The event carries correlation
handles only — `deadLetterId`, `jobId`, `errorClass`, `attemptsMade` — and the detail stays in the
tenant-isolated table. Message and stack are truncated in TypeScript, not left to the CHECK: a
constraint violation would abort the transaction recording the failure, trading the whole alert for
the tail of a stack trace.

## Row-level security

All four new tables are ENABLED + FORCED via `app.apply_tenant_isolation`, verified by
`bun run db:test:rls-coverage`.

`app.user_notification_settings` additionally takes a RESTRICTIVE owner policy mirroring
`notification_preferences_owner`, scoped `TO studafy_app`. The dispatcher reads other users' settings
because it runs under `withSystemTenantTx`, which elevates to `studafy_admin`; the policy names
`studafy_app`, so it does not apply. Tenant isolation still does — it is permissive and applies to
every role under FORCE ROW LEVEL SECURITY.

The other three take the tenant boundary only. `notification_dispatch_logs` is operational audit, not
an inbox: the question it exists to answer requires reading rows addressed to other people, so
fencing it per recipient would make it useless. The idempotency ledger and the dead-letter table are
worker-internal and no user-facing query reads them.

## What does not exist

- **`sms`.** Not in the channel enum, no templates, no provider.
- **Any real push or email delivery.** `delivery.worker.ts` logs `no provider configured`.
  `app.user_devices` FCM tokens still have no reader.
- **A DLQ replay tool.** The queue name is reserved; draining is an unimplemented operator action.
- **A working outbox relay in production.** `SCHOOL_IDS` is absent from the ECS task definition, so
  the `notification.dispatchFailed` row is written and never published. The structured log line in
  `handleDeadLetter` is therefore not garnish — it is currently the only alert path that reaches an
  operator.
- **A shared logger.** `apps/workers/src/log.ts` is a three-method NDJSON writer following SAD §28's
  wire format. Lifting `apps/api/src/logger.ts` into `packages/` is still the stated follow-up.

## Verifying

```bash
bun run db:up && bun run db:migrate
bun run db:test:rls-coverage
bun run db:migrate:validate

TEST_DATABASE_URL=postgresql://... bun test apps/workers/src/queues/notifications
bun test apps/workers/src        # pure suites run without a database

bunx turbo run lint check-types test build --filter=!@studafy/mobile
docker build -f infra/docker/workers.Dockerfile .
```

The pure suites — quiet-hours wrap-around, locale fallback, terminal-failure detection, key
construction — always run. The suites that prove an acceptance criterion skip unless
`TEST_DATABASE_URL` is set, because each of those guarantees _is_ a database object: the fan-out is a
join, and the idempotency is a unique index.
