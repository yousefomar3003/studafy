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
  // Material thumbnail/preview derivation. Consumes one job per clean material, enqueued by the
  // file-scan worker after it flips the material to `ready`. Derived images are cosmetic — their
  // failures never affect material availability, so this queue must stay independent of the scan
  // verdict the moment it is made.
  DERIVATIONS: "derivations",
  // Exam-mode item-bank generation (ST-171). Consumes one job per app.exam_sessions row: loads the
  // requested materials' chunks, asks the LLM for a mixed mcq/short-answer item set grounded on
  // them, validates it the same three-layer way quiz generation does, and persists the result. Split
  // from ai-ingestion because this queue calls the LLM plane (a different failure mode and latency
  // budget than parse/OCR/embed) rather than only transforming already-ingested text.
  AI_EXAM_GENERATION: "ai-exam-generation",
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
  // Async CSV export of a school's audit log (ST-046x). Carries the durable job identity
  // (auditExportJobDataSchema); the resolved filter rides in app.audit_export_jobs.parameters,
  // which the store reads at claim time.
  GENERATE_AUDIT_EXPORT: "generate-audit-export",
  // Per-student term progress report (ST-176). One job per (student, term); the payload carries the
  // student/term ids and the report renders published grades, attendance and teacher comments.
  GENERATE_PROGRESS_REPORT: "generate-progress-report",
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
  // Thumbnail + first-page preview derivation of a clean material. Carried by the derivations
  // queue; enqueued by the file-scan worker right after a clean verdict. Carries only the material
  // id: the worker reads storage_key/mime_type from the row, so a retry never acts on stale payload
  // data. A duplicate job is a no-op (the worker only derives while thumbnail_key is NULL).
  DERIVE_MATERIAL_PREVIEWS: "derive-material-previews",
  // Scheduled purge of report artifacts whose 7-day window has elapsed. Carries no payload: the
  // sweep reads completed report rows older than the retention window from both report job tables
  // and deletes their stored objects. Registered on the reports queue via Job Scheduler.
  PURGE_EXPIRED_REPORTS: "purge-expired-reports",
  // Scheduled purge of abandoned student-CSV imports (ST-190 follow-up). Carries no payload: the
  // sweep reads app.student_imports rows still in 'uploaded'/'validated' status (i.e. never
  // confirmed) whose retention window has elapsed and deletes them, per school. Registered on the
  // imports queue via Job Scheduler.
  PURGE_ABANDONED_IMPORTS: "purge-abandoned-imports",
  // Ingestion of a confirmed, clean-scanned material (ST-161). Carries only the school and
  // material ids (aiIngestionJobDataSchema); the worker claims the material by its 'queued'
  // status and drives it parse -> (ocr) -> chunk -> embed -> ready. Enqueued by the scan worker
  // on a clean verdict and by the API on re-ingest / re-enable, with attempts + exponential
  // backoff so a saturated per-tenant concurrency slot retries instead of failing the job.
  INGEST_MATERIAL: "ingest-material",
  // Exam-mode item-bank generation (ST-171). Carries the resolved model/tier plus the generation
  // scope (materialIds, questionCount, questionTypes); the worker claims the app.exam_sessions row
  // by its `generating` status, so a retried job re-attempts the same generation rather than
  // creating a duplicate session.
  GENERATE_EXAM: "generate-exam",
  // Scheduled publish sweep for announcements (ST-194). Carries no payload: the sweep reads
  // app.announcements rows still `scheduled` whose scheduled_at is due, per school, and publishes
  // each via @studafy/announcements' publishAnnouncement — the same function the API calls
  // synchronously for an immediate send. Registered on the notifications queue via Job Scheduler,
  // since it is a notifications-shaped concern, not a report or import one.
  PUBLISH_DUE_ANNOUNCEMENTS: "publish-due-announcements",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * BullMQ job options for one material ingestion (ST-161). Shared by both producers — the file-scan
 * worker after a clean verdict and the API's AI re-enable route — so retry policy and retention
 * can't drift between them. `attempts` includes the first run: 5 tries with exponential backoff,
 * because parse/OCR/embed are long-running but transiently contended — an embedding 429 or a
 * saturated per-tenant concurrency slot should retry, not fail the file. Flattened as a plain
 * object rather than a `JobsOptions`-typed constant because @studafy/constants has no BullMQ
 * dependency; BullMQ accepts the shape structurally.
 */
export const INGESTION_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
} as const;

/**
 * BullMQ job options for one exam item-bank generation (ST-171). 3 attempts, not ingestion's 5: a
 * single LLM call is either transiently unavailable (worth a couple of retries) or its output fails
 * grounding validation (retrying rarely helps, same posture quiz generation's doc documents for its
 * own synchronous path) — there is no multi-stage pipeline here to make more retries pay for
 * themselves. Mirrors the finance report queue's `attempts: 3` for the same reason.
 */
export const EXAM_GENERATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
} as const;
