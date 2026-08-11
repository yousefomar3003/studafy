import type { TransactionSql } from "postgres";

/**
 * Record token usage in the durable per-student ledger (ST-155/ST-162/ST-164).
 *
 * The Redis meter the gate commits to is the quota decision surface;
 * `app.ai_usage_meters` is the durable record the design note reserves for the routes that
 * produce usage. The gate has already proven the student holds an AI subscription, so a missing
 * row is treated as an unchargeable no-op rather than an error.
 *
 * Shared by the hybrid-retrieval route (which records the query's embedding cost) and the LLM
 * gateway route (which records the provider's reported input + output tokens), so every AI surface
 * that consumes quota records the same tokens in the same table.
 */
export async function recordDurableUsage(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  tokens: number,
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
    SELECT app.upsert_ai_usage_tokens(${studentId}::uuid, ${subscription.id}::uuid, ${tokens})
  `;
}
