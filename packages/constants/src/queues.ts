/**
 * BullMQ queue names. The single source of truth for queue identifiers — producers (API routes,
 * other workers) and the workers app's queue registry must import these rather than hardcoding
 * strings, so a typo or rename can't silently split one queue into two.
 */
export const QUEUE_NAMES = {
  AI_INGESTION: "ai-ingestion",
  NOTIFICATIONS: "notifications",
  REPORTS: "reports",
  IMPORTS: "imports",
  BILLING: "billing",
  OUTBOX_RELAY: "outbox-relay",
  PROVISIONING: "provisioning",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * Parking lots for jobs that exhausted their retries. Deliberately NOT in QUEUE_NAMES.
 *
 * QUEUE_NAMES is the set of queues apps/workers runs a BullMQ `Worker` for, and
 * `QueueDefinition.name` is typed `QueueName` — so keeping dead-letter names in a separate constant
 * with a separate type makes "attach a worker to a dead-letter queue" a compile error rather than a
 * review comment. That is stricter than the runtime bijection registry.test.ts already enforces,
 * and it keeps that bijection meaning what it says: a queue in QUEUE_NAMES has a real processor.
 *
 * The durable dead-letter record is app.notification_dead_letters (000074), not a Redis list. A
 * queue with no worker never completes a job, so `removeOnComplete` never fires and it grows without
 * bound; BullMQ's own failed set already retains the job data, `failedReason` and per-attempt
 * stacks for the 30-day `removeOnFail` window, and already supports `job.retry()`. This constant
 * reserves the name for the operator replay tool that drains it.
 */
export const DEAD_LETTER_QUEUE_NAMES = {
  NOTIFICATIONS: "notifications-dlq",
} as const;

export type DeadLetterQueueName =
  (typeof DEAD_LETTER_QUEUE_NAMES)[keyof typeof DEAD_LETTER_QUEUE_NAMES];

/**
 * BullMQ job names, for queues that carry more than one kind of work.
 *
 * A queue name says which worker picks the job up; a job name says what it is. The `notifications`
 * queue carries several unrelated jobs, and its processor dispatches on these — so producer and
 * consumer live in different apps and must agree on the string. Same reasoning as QUEUE_NAMES:
 * a typo here would silently route a job to the fallback branch instead of failing.
 */
export const JOB_NAMES = {
  EVALUATE_ATTENDANCE_ALERTS: "evaluate-attendance-alerts",
  GENERATE_ATTENDANCE_EXPORT: "generate-attendance-export",
  GENERATE_FINANCE_REPORT: "generate-finance-report",
  GENERATE_INVOICE: "generate-invoice",
  GENERATE_BATCH_INVOICES: "generate-batch-invoices",
  // Notification dispatch (ST-139). DISPATCH resolves recipients and decides what each of them
  // should receive; DELIVER carries one already-decided message to one recipient on one channel.
  // They are separate jobs because the fan-out is transactional and idempotent while the delivery
  // is an external call — retrying the second must not re-run the first.
  DISPATCH_NOTIFICATION: "dispatch-notification",
  DELIVER_NOTIFICATION: "deliver-notification",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
