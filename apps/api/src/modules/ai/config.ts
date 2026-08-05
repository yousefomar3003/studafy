/**
 * AI quota gate configuration (ST-155).
 *
 * These are the default ceilings until `app.plans` carries per-plan AI quotas. The gate accepts
 * overrides at construction time, so a plan-driven budget can be layered on without changing the
 * middleware's shape.
 */

/** Default monthly token budget per AI subscription, reset on each billing renewal. */
export const AI_MONTHLY_TOKEN_BUDGET = 1_000_000;

/** How many tokens a request reserves up front while it runs, before it has produced anything. */
export const AI_DEFAULT_RESERVE_TOKENS = 1_000;

/** Redis key prefix for AI quota counters. Keys look like `aiq:{schoolId}:{studentId}:{YYYY-MM-DD}`. */
export const AI_QUOTA_KEY_PREFIX = "aiq";

/**
 * How long past the billing period end a counter key is kept, so a commit that races the period
 * boundary still lands on the window it was reserved against instead of vanishing.
 */
export const AI_QUOTA_PERIOD_GRACE_SECONDS = 300;
