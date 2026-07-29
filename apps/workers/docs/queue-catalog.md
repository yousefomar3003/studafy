# Queue catalog

Source of truth for queue names: `QUEUE_NAMES` in
[`packages/constants/src/queues.ts`](../../../packages/constants/src/queues.ts). Nothing in this
repo should hardcode a queue name string — import `QUEUE_NAMES` (or `QueueName`) instead, so a
rename can't silently split a queue in two.

This is a scaffold. Every processor in [`src/registry.ts`](../src/registry.ts) is currently a
placeholder that logs and resolves — it exists so the worker bootstrap has a real job to process
end-to-end (see `scripts/smoke-test.ts`). The table below records what each queue is _for_ and its
starting concurrency; the actual processing logic lands in separate tickets, one per queue.

| Queue           | `QUEUE_NAMES` key | Concurrency | Purpose                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai-ingestion`  | `AI_INGESTION`    | 2           | Ingests course/content material for AI processing (e.g. embeddings, content analysis). Kept low: jobs are expected to call slow, rate-limited external AI services.                                                                                                                                                            |
| `notifications` | `NOTIFICATIONS`   | 10          | Delivers `NOTIFICATION_TYPES` (see `packages/constants/src/notifications.ts`) to their channels (email, push, in-app). High-volume, low-cost-per-job — safe to run with high concurrency.                                                                                                                                      |
| `reports`       | `REPORTS`         | 3           | Generates exports and reports (e.g. analytics, certificates). CPU/IO-bound and typically long-running, so kept moderate.                                                                                                                                                                                                       |
| `imports`       | `IMPORTS`         | 2           | Bulk data imports (e.g. roster/enrollment imports). Kept low to bound the load a single large import puts on the database.                                                                                                                                                                                                     |
| `billing`       | `BILLING`         | 1           | **ERPNext invoice generation.** `generate-invoice` creates a single Sales Invoice via ERPNext API; `generate-batch-invoices` processes a grade/class cohort with 10-way inner concurrency. Concurrency of 1 by design — ordering per school matters. Each batch job manages its own parallelism via an in-process worker pool. |
| `outbox-relay`  | `OUTBOX_RELAY`    | 5           | Relays the transactional outbox (domain events captured in the database, see `packages/constants/src/events.ts`) to downstream consumers.                                                                                                                                                                                      |

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
