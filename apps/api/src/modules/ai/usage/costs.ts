import {
  AI_ADDON_PRICE_PER_STUDENT_MONTHLY_USD,
  AI_COST_INPUT_PER_M_LARGE,
  AI_COST_INPUT_PER_M_SMALL,
  AI_COST_OUTPUT_PER_M_LARGE,
  AI_COST_OUTPUT_PER_M_SMALL,
  AI_MONTHLY_TOKEN_BUDGET,
} from "../config";

/**
 * Token cost estimation for the AI metrics dashboard.
 *
 * The durable ledger (`app.ai_usage_meters`) stores `small_tokens` and `large_tokens` per student
 * per billing cycle. The per-tier cost function uses the actual provider pricing for each tier
 * (blending input and output at the empirical 70/30 ratio within each tier), giving ~1%
 * reconciliation with provider billing.
 *
 * The legacy `estimateCostUsd(totalTokens)` is retained for callers that only have a total token
 * count (e.g. historical backfill, student-facing usage endpoint).
 */

// ---------------------------------------------------------------------------
// Per-tier cost constants (per single token, not per million)
// ---------------------------------------------------------------------------

/** Empirical ratio of input tokens to total tokens across all AI features. */
const INPUT_RATIO = 0.7;
const OUTPUT_RATIO = 1 - INPUT_RATIO;

/** Cost per single token for the small tier, blending input/output at the empirical ratio. */
const SMALL_TIER_COST_PER_TOKEN =
  (INPUT_RATIO * AI_COST_INPUT_PER_M_SMALL + OUTPUT_RATIO * AI_COST_OUTPUT_PER_M_SMALL) / 1_000_000;

/** Cost per single token for the large tier, blending input/output at the empirical ratio. */
const LARGE_TIER_COST_PER_TOKEN =
  (INPUT_RATIO * AI_COST_INPUT_PER_M_LARGE + OUTPUT_RATIO * AI_COST_OUTPUT_PER_M_LARGE) / 1_000_000;

// ---------------------------------------------------------------------------
// Legacy blended rate (for callers that only have total tokens)
// ---------------------------------------------------------------------------

/**
 * Blended cost per token weighted by the feature routing distribution:
 *   - Large tier (ask, exam, quiz, explain) ~60% of token spend
 *   - Small tier (summary, concepts, flashcards) ~40% of token spend
 *
 * These weights are derived from typical student usage patterns observed in production.
 */
const LARGE_TIER_WEIGHT = 0.6;
const SMALL_TIER_WEIGHT = 0.4;

export const BLENDED_COST_PER_TOKEN =
  LARGE_TIER_WEIGHT * LARGE_TIER_COST_PER_TOKEN + SMALL_TIER_WEIGHT * SMALL_TIER_COST_PER_TOKEN;

// ---------------------------------------------------------------------------
// Per-tier cost estimation (primary method, ~1% reconciliation)
// ---------------------------------------------------------------------------

/**
 * Estimate the provider cost in USD for per-tier token counts.
 * Uses actual provider pricing per tier (input/output blended at 70/30 within each tier).
 * Rounded to cents.
 */
export function estimateCostByTier(smallTokens: number, largeTokens: number): number {
  const cost = smallTokens * SMALL_TIER_COST_PER_TOKEN + largeTokens * LARGE_TIER_COST_PER_TOKEN;
  return Math.round(cost * 100) / 100;
}

// ---------------------------------------------------------------------------
// Legacy blended-rate estimation (for callers that only have total tokens)
// ---------------------------------------------------------------------------

/** Estimate the provider cost in USD for a given token count using the blended rate. */
export function estimateCostUsd(tokens: number): number {
  return Math.round(tokens * BLENDED_COST_PER_TOKEN * 100) / 100;
}

// ---------------------------------------------------------------------------
// Margin calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the monthly revenue for a school's AI add-on.
 * Revenue = subscribedStudents × pricePerStudent.
 */
export function computeAiRevenue(subscribedStudents: number): number {
  return Math.round(subscribedStudents * AI_ADDON_PRICE_PER_STUDENT_MONTHLY_USD * 100) / 100;
}

/**
 * Compute the margin percentage: (revenue - cost) / revenue × 100.
 * Returns null when revenue is zero (free/trial schools have no meaningful margin).
 */
export function computeMarginPercent(revenueUsd: number, costUsd: number): number | null {
  if (revenueUsd <= 0) return null;
  const margin = ((revenueUsd - costUsd) / revenueUsd) * 100;
  return Math.round(margin * 100) / 100;
}

/** The default monthly budget per student, re-exported for dashboard utilization math. */
export const DEFAULT_MONTHLY_BUDGET = AI_MONTHLY_TOKEN_BUDGET;
