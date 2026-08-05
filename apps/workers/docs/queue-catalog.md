# Queue catalog

Source of truth for queue names: `QUEUE_NAMES` in
[`packages/constants/src/queues.ts`](../../../packages/constants/src/queues.ts). Nothing in this
repo should hardcode a queue name string — import `QUEUE_NAMES` (or `QueueName`) instead, so a
rename can't silently split a queue in two.

Some processors in [`src/registry.ts`](../src/registry.ts) are still placeholders that log and
resolve — they exist so the worker bootstrap has a real job to process end-to-end (see
`scripts/smoke-test.ts`), and `ai-ingestion`, `outbox-relay` and `provisioning` are still in that
state. `notifications`, `reports`, `imports`, `scan` and `billing` carry real logic. The table below
records what each queue is _for_ and its starting concurrency.

| Queue           | `QUEUE_NAMES` key | Concurrency | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-ingestion`  | `AI_INGESTION`    | 2           | Ingests course/content material for AI processing (e.g. embeddings, content analysis). Kept low: jobs are expected to call slow, rate-limited external AI services.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `notifications` | `NOTIFICATIONS`   | 10          | Delivers `NOTIFICATION_TYPES` (see `packages/constants/src/notifications.ts`) to their channels (email, push, in-app). High-volume, low-cost-per-job — safe to run with high concurrency.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `reports`       | `REPORTS`         | 3           | Generates attendance and ERPNext-backed finance exports. `generate-finance-report` owns the durable finance job lifecycle, fixed ERPNext report selection, CSV/PDF or JoInvoice rendering, S3 upload, and 24-hour signed URL persistence. CPU/IO-bound and typically long-running, so kept moderate.                                                                                                                                                                                                                                                                                                                              |
| `imports`       | `IMPORTS`         | 2           | Bulk data imports (e.g. roster/enrollment imports). Kept low to bound the load a single large import puts on the database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `scan`          | `SCAN`            | 2           | **Malware scanning of confirmed materials** (`file-scan`). One `scan-material` job per confirmed upload: the worker streams the object from S3 into clamd, flips clean materials to `ready`, quarantines infected ones (copy to `quarantine/`, notify the uploader, delete the served copy), and fails closed — material marked `failed`, never served — on scan errors after retries. Concurrency of 2 because each scan holds a clamd connection and streams the object once; the availability budget for clean files is dominated by scan latency, so a small pool bounds clamd oversubscription on a Fargate-sized container. |
| `billing`       | `BILLING`         | 1           | **ERPNext invoice generation.** `generate-invoice` creates a single Sales Invoice via ERPNext API; `generate-batch-invoices` processes a grade/class cohort with 10-way inner concurrency. Concurrency of 1 by design — ordering per school matters. Each batch job manages its own parallelism via an in-process worker pool.                                                                                                                                                                                                                                                                                                    |
| `outbox-relay`  | `OUTBOX_RELAY`    | 5           | Relays the transactional outbox (domain events captured in the database, see `packages/constants/src/events.ts`) to downstream consumers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `provisioning`  | `PROVISIONING`    | 2           | Tenant provisioning work following school registration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Dead-letter queues

`DEAD_LETTER_QUEUE_NAMES` in `packages/constants/src/queues.ts` is a **separate** constant with a
separate type, and that separation is deliberate: `QUEUE_NAMES` means "queues this process runs a
`Worker` for", and `QueueDefinition.name` is typed `QueueName`. Putting a dead-letter name in
`QUEUE_NAMES` would make attaching a worker to a parking lot a valid program — and a parking lot
with a consumer is just a sixth retry. `registry.test.ts` asserts both halves: one registry entry
per `QUEUE_NAMES` value, and no registry entry for any `DEAD_LETTER_QUEUE_NAMES` value.

| Dead-letter queue   | Origin queue    | Durable record                  |
| ------------------- | --------------- | ------------------------------- |
| `notifications-dlq` | `notifications` | `app.notification_dead_letters` |

The Redis queue is a reserved name for a future operator replay tool; nothing writes to it today.
The record of a terminal failure is the database row, written by a BullMQ `failed` listener — see
[`docs/architecture/SAD_21_notification_dispatch_flow.md`](../../../docs/architecture/SAD_21_notification_dispatch_flow.md)
for why that listener keys on `job.finishedOn` rather than on an attempt count.

## Adding a queue

1. Add the name to `QUEUE_NAMES` in `packages/constants/src/queues.ts`.
2. Add a matching entry to `QUEUE_REGISTRY` in `apps/workers/src/registry.ts` with a concurrency
   and a processor.
3. Add a row to the table above explaining what the queue is for and why it has that concurrency.

## Verifying locally

`bun run smoke-test` (from `apps/workers`) requires a real Redis at `REDIS_URL` (defaults to
`redis://localhost:6379`). It starts the full worker bootstrap, enqueues one job on the first
registered queue, and waits for it to complete — this is the closest thing in this repo to an
end-to-end check of "workers start, register queues, and process a test job."
