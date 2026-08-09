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
  // Malware scanning of uploaded objects (ClamAV). Consumes one job per confirmed material; the
  // verdict decides whether the material becomes available (ready) or is quarantined.
  SCAN: "file-scan",
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
  SEND_DIGESTS: "send-digests",
  // Daily notification digest. Distinct from SEND_DIGESTS above, which is the parent-specific
  // attendance/fee digest — this one is the general, per-recipient digest driven by
  // app.notification_preferences.digest (ST-143).
  SEND_NOTIFICATION_DIGESTS: "send-notification-digests",
  // Notification dispatch (ST-139). DISPATCH resolves recipients and decides what each of them
  // should receive; DELIVER carries one already-decided message to one recipient on one channel.
  // They are separate jobs because the fan-out is transactional and idempotent while the delivery
  // is an external call — retrying the second must not re-run the first.
  DISPATCH_NOTIFICATION: "dispatch-notification",
  DELIVER_NOTIFICATION: "deliver-notification",
  // Stripe webhook retry (ST-132). Carries only a provider event id: the verified payload is already
  // durable in app.billing_events, and a job that carried a copy could disagree with it. Signature
  // verification is not repeated on retry — it happened once, at intake, over the raw bytes, which
  // is the only moment it can be done at all.
  PROCESS_BILLING_EVENT: "process-billing-event",
  // Grace-period dunning (ST-134). Scheduled job: drives the dunning email sequence, suspends
  // subscriptions whose grace window has elapsed, and stamps nothing itself — the deadline is set
  // by the state machine when a subscription enters `grace_period`. Carries no payload.
  RUN_DUNNING: "run-dunning",
  // Nightly seat reconciliation (ST-136). Scheduled job: reconciles each active subscription's
  // enrolled-student count against the billed Stripe seat quantity — prorated upgrade on drift up,
  // next-cycle downgrade on drift down, and a drift report to the school's ORG_ADMINs. Carries no
  // payload: the sweep reads every school's seats and Stripe state straight from the database.
  RUN_SEAT_RECONCILIATION: "run-seat-reconciliation",
  // Daily storage-quota reconciliation (ST-16x). Scheduled job: recomputes each school's
  // app.storage_usage_meters row from the bucket inventory, converging the drift (quarantine
  // deletions, lifecycle expirations, orphaned objects) that event-driven increments cannot see.
  // Carries no payload: the sweep reads every school's usage and the S3 bucket directly.
  RUN_STORAGE_QUOTA_RECONCILIATION: "run-storage-quota-reconciliation",
  // Malware scan of a confirmed material. Carries the material id, its permanent storage
  // key, and the user to notify if the verdict is not clean. One job per confirm, at most once:
  // the worker claims the material by its 'scanning' status and flips it to a terminal state.
  SCAN_MATERIAL: "scan-material",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
