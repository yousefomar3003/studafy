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

/**
 * Default model ids for the LLM gateway (ST-164) small and large tiers. The routing table
 * (`llm/routing.ts`) owns the feature-to-tier mapping; these are the ids a deployment that sets no
 * `AI_LLM_SMALL_MODEL` / `AI_LLM_LARGE_MODEL` override gets. They are the catalog ids current when
 * ST-164 shipped — see docs/runbooks/anthropic-provider-config.md before changing them.
 */
export const AI_LLM_DEFAULT_SMALL_MODEL = "claude-3-5-haiku-20241022";
export const AI_LLM_DEFAULT_LARGE_MODEL = "claude-sonnet-4-20250514";

/**
 * Worst-case reservation the LLM gateway (ST-164) asks the gate to hold for one generation.
 *
 * The generate route's body caps the prompt and system hint at 8,000 characters each — roughly
 * 2,000 tokens each under the codebase's four-chars-per-token estimate — and caps `maxTokens` at
 * 16,384 output tokens. 24,000 covers that ceiling with margin, so the actual-usage commit (input +
 * output tokens reported by the provider) can never exceed the reservation, which the meter treats
 * as a programmer error.
 */
export const AI_LLM_MAX_RESERVE_TOKENS = 24_000;

/**
 * Retry-After value the generate route sends with 503 AI_LLM_UNAVAILABLE. Mirrors the circuit
 * breaker's default cooldown, so a client that honors it retries around the same time the breaker
 * lets a probe through.
 */
export const AI_LLM_RETRY_AFTER_SECONDS = 30;
