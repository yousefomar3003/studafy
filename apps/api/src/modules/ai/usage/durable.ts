import type { AiModelTier } from "../llm/routing";
import type { TransactionSql } from "postgres";

/**
 * Token breakdown for durable usage recording.
 *
 * Most callers derive this from the provider's `generation.usage` object plus the resolved model
 * tier. The retrieval route (embedding cost) passes small_tokens only — embeddings are consumed as
 * input on the small tier and have no meaningful output split.
 */
export interface DurableUsageTokens {
  /** Total tokens (input + output), always stored for backward compatibility. */
  totalTokens: number;
  /** Tokens consumed on the small tier (summary, concepts, flashcards, embeddings). */
  smallTokens: number;
  /** Tokens consumed on the large tier (ask, quiz, explain, exam). */
  largeTokens: number;
}

/**
 * Record token usage in the durable per-student ledger (ST-155/ST-162/ST-164).
 *
 * The Redis meter the gate commits to is the quota decision surface;
 * `app.ai_usage_meters` is the durable record the design note reserves for the routes that
 * produce usage. The gate has already proven the student holds an AI subscription, so a missing
 * row is treated as an unchargeable no-op rather than an error.
 *
 * Shared by the hybrid-retrieval route (which records the query's embedding cost) and the LLM
 * gateway routes (which record the provider's reported input + output tokens), so every AI surface
 * that consumes quota records the same tokens in the same table.
 *
 * The tier breakdown (`smallTokens` / `largeTokens`) enables per-tier cost estimation in the
 * metrics dashboard, tightening the reconciliation with provider billing from ~5% to ~1%.
 */
export async function recordDurableUsage(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  tokens: DurableUsageTokens,
): Promise<void> {
  const [subscription] = await tx<{ id: string }[]>`
    SELECT id
    FROM app.ai_subscriptions
    WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!subscription) return;
  await tx`
    SELECT app.upsert_ai_usage_tokens(
      ${studentId}::uuid,
      ${subscription.id}::uuid,
      ${tokens.totalTokens},
      ${tokens.smallTokens},
      ${tokens.largeTokens}
    )
  `;
}

/**
 * Split total tokens by tier. For LLM generation routes that know which tier was used.
 *
 * Usage: `splitByTier(generation.usage.totalTokens, routed.tier)`
 */
export function splitByTier(totalTokens: number, tier: AiModelTier): DurableUsageTokens {
  return tier === "small"
    ? { totalTokens, smallTokens: totalTokens, largeTokens: 0 }
    : { totalTokens, smallTokens: 0, largeTokens: totalTokens };
}
