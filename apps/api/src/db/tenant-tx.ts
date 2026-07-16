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
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${context.schoolId}, true)`;
    if (context.userId !== undefined) {
      await tx`SELECT set_config('app.user_id', ${context.userId}, true)`;
    }
    if (context.requestId !== undefined) {
      await tx`SELECT set_config('app.request_id', ${context.requestId}, true)`;
    }
    result = await fn(tx);
  });
  return result as T;
}
