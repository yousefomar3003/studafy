import type { Database } from "./client";
import type { TransactionSql } from "postgres";

export interface TenantContext {
  schoolId: string;
  userId?: string;
  requestId?: string;
}

export interface OpenTenantTransaction<T> {
  tx: TransactionSql;
  initial: T;
  commit: () => Promise<void>;
  commitWith: <TResult>(statement: Promise<TResult>) => Promise<TResult>;
  rollback: () => Promise<void>;
}

export async function withTenantTx<T>(
  database: Database,
  context: TenantContext,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.begin(async (tx) => {
    await configureTenantTx(tx, context);
    result = await fn(tx);
  });
  return result as T;
}

/**
 * Reserve one physical connection and pipeline BEGIN, tenant setup, and the caller's first query.
 * Rotation uses this because those commands are strictly ordered but do not require client-side
 * decisions between them; sending them together removes protocol waits without weakening RLS.
 */
export async function openTenantTx<T>(
  database: Database,
  context: TenantContext,
  initialQuery: (tx: TransactionSql) => Promise<T>,
): Promise<OpenTenantTransaction<T>> {
  const reserved = await database.reserve();
  const tx = reserved as unknown as TransactionSql;

  try {
    // execute() starts each lazy postgres.js query immediately. The reserved connection preserves
    // FIFO order, while PostgreSQL still executes BEGIN, context setup, and the read serially.
    const begun = reserved.unsafe("BEGIN").execute();
    const configured = configureTenantTx(tx, context);
    const initial = initialQuery(tx);
    const settled = await Promise.allSettled([begun, configured, initial]);

    for (const item of settled) {
      if (item.status === "rejected") throw item.reason;
    }
    const initialResult = settled[2];
    if (!initialResult || initialResult.status !== "fulfilled") {
      throw new Error("tenant transaction initial query did not complete");
    }

    let closed = false;
    const close = async (command: "COMMIT" | "ROLLBACK"): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await reserved.unsafe(command);
      } finally {
        reserved.release();
      }
    };

    const commitWith = async <TResult>(statement: Promise<TResult>): Promise<TResult> => {
      if (closed) throw new Error("tenant transaction is already closed");
      const committed = reserved.unsafe("COMMIT").execute();
      const [workResult, commitResult] = await Promise.allSettled([statement, committed]);
      closed = true;
      reserved.release();

      if (workResult.status === "rejected") throw workResult.reason;
      if (commitResult.status === "rejected") throw commitResult.reason;
      return workResult.value;
    };

    return {
      tx,
      initial: initialResult.value as T,
      commit: () => close("COMMIT"),
      commitWith,
      rollback: () => close("ROLLBACK"),
    };
  } catch (error) {
    try {
      await reserved.unsafe("ROLLBACK");
    } finally {
      reserved.release();
    }
    throw error;
  }
}

function configureTenantTx(tx: TransactionSql, context: TenantContext): Promise<unknown> {
  // set_config(..., true) has the same transaction-local lifetime as SET LOCAL, including for
  // PostgreSQL's special role setting. Explicit branches preserve omitted optional GUC behavior.
  if (context.userId !== undefined && context.requestId !== undefined) {
    return tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${context.schoolId}, true),
             set_config('app.user_id', ${context.userId}, true),
             set_config('app.request_id', ${context.requestId}, true)
    `.execute();
  }
  if (context.userId !== undefined) {
    return tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${context.schoolId}, true),
             set_config('app.user_id', ${context.userId}, true)
    `.execute();
  }
  if (context.requestId !== undefined) {
    return tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${context.schoolId}, true),
             set_config('app.request_id', ${context.requestId}, true)
    `.execute();
  }
  return tx`
    SELECT set_config('role', 'studafy_app', true),
           set_config('app.school_id', ${context.schoolId}, true)
  `.execute();
}
