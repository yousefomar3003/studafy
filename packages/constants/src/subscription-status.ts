/**
 * Subscription lifecycle status values. Mirrors the `app.subscription_status` PostgreSQL
 * enum and serves as the single source of truth for TypeScript code.
 *
 * The lifecycle state machine (SAD §11):
 *
 *   trialing ──→ active       (trial converts, payment succeeds)
 *   trialing ──→ grace_period (trial expires, grace window opens)
 *   active   ──→ grace_period (renewal payment fails)
 *   grace_period ──→ active   (payment recovered within grace window)
 *   grace_period ──→ closed   (grace window exhausted)
 *   *        ──→ closed       (terminal — no transitions out)
 *
 *   AI subscriptions only:
 *   *      ──→ paused  (the student's school was suspended)
 *   paused ──→ active  (the school was reactivated — resumable, unlike `closed`)
 *
 * `paused` is a distinct state from `closed` on purpose: `closed` is terminal (SAD §11), so a
 * suspension that needs a resume path cannot reuse it without giving `closed` an outgoing edge
 * every other document says it does not have. See packages/billing/src/state-machine.ts for the
 * transition table (school subscriptions never enter `paused`).
 */
export const SUBSCRIPTION_STATUSES = {
  TRIALING: "trialing",
  ACTIVE: "active",
  PAST_DUE: "past_due",
  GRACE_PERIOD: "grace_period",
  CANCELED: "canceled",
  EXPIRED: "expired",
  CLOSED: "closed",
  PAUSED: "paused",
} as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[keyof typeof SUBSCRIPTION_STATUSES];
