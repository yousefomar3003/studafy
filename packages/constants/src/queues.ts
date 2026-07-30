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
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
