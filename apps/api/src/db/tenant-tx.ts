import type { Database } from "./client";
import type { TransactionSql } from "postgres";

export interface TenantContext {
  schoolId: string;
  userId?: string;
  requestId?: string;
}

export async function withTenantTx<T>(
  database: Database,
  context: TenantContext,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.begin(async (tx) => {
    // Assume the fixed application role and set every supplied context value in one round trip.
    // set_config(..., true) has the same transaction-local lifetime as SET LOCAL, including for
    // PostgreSQL's special role setting. The explicit branches preserve the existing behavior for
    // omitted optional GUCs instead of setting them to an empty sentinel.
    if (context.userId !== undefined && context.requestId !== undefined) {
      await tx`
        SELECT set_config('role', 'studafy_app', true),
               set_config('app.school_id', ${context.schoolId}, true),
               set_config('app.user_id', ${context.userId}, true),
               set_config('app.request_id', ${context.requestId}, true)
      `;
    } else if (context.userId !== undefined) {
      await tx`
        SELECT set_config('role', 'studafy_app', true),
               set_config('app.school_id', ${context.schoolId}, true),
               set_config('app.user_id', ${context.userId}, true)
      `;
    } else if (context.requestId !== undefined) {
      await tx`
        SELECT set_config('role', 'studafy_app', true),
               set_config('app.school_id', ${context.schoolId}, true),
               set_config('app.request_id', ${context.requestId}, true)
      `;
    } else {
      await tx`
        SELECT set_config('role', 'studafy_app', true),
               set_config('app.school_id', ${context.schoolId}, true)
      `;
    }
    result = await fn(tx);
  });
  return result as T;
}
