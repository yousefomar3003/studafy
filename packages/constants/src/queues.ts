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
