import type { Database, DatabasePools } from "./client";
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
  rollback: () => Promise<void>;
}

export interface TenantTxOptions {
  useReadReplica?: boolean;
}

function selectDatabase(database: Database | DatabasePools, options: TenantTxOptions): Database {
  if (typeof database === "function") return database;
  return options.useReadReplica ? database.readReplica : database.primary;
}

export async function withTenantTx<T>(
  database: Database | DatabasePools,
  context: TenantContext,
  fn: (tx: TransactionSql) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  const selected = selectDatabase(database, options);
  let result: T | undefined;
  await selected.begin(async (tx) => {
    if (options.useReadReplica) {
      await tx`SET TRANSACTION READ ONLY`;
    }
    await configureTenantTx(tx, context);
    result = await fn(tx);
  });
  return result as T;
}

/**
 * A transaction for work the system does on nobody's behalf, with the tenant not yet known.
 *
 * The API's one caller is the payment-provider webhook processor, and its shape is genuinely
 * different from every other route's. A webhook is deduplicated by `(provider, provider_event_id)`
 * *before* its payload has been read closely enough to say which school it concerns -- that
 * ordering is the whole reason `app.billing_events` is global rather than tenant-isolated (see the
 * header of 000016) -- so there is no `school_id` to hand `withTenantTx` at BEGIN time. There is
 * also no acting user: Stripe is not a person.
 *
 * `studafy_admin` is required rather than convenient: `app.billing_events` revokes every privilege
 * from `studafy_app` and its only policy names `studafy_admin`. The elevation is transaction-local
 * (`SET LOCAL ROLE` ends at COMMIT), which is what keeps it safe under PgBouncer transaction
 * pooling, exactly as the GUC-setting in `configureTenantTx` is.
 *
 * Tenant isolation is *not* armed here, because there is nothing to arm it with yet. The caller
 * must call `setTenantScope` before touching any tenant-isolated table -- notably
 * `app.subscriptions`, `app.ai_subscriptions` and `app.audit_logs`, all of which are FORCE-d and
 * would otherwise match zero rows under a policy comparing against an unset GUC. Reach for
 * `withTenantTx` for anything acting for a user, and for anything that knows its tenant up front.
 */
export async function withSystemTx<T>(
  database: Database | DatabasePools,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const selected = selectDatabase(database, {});
  let result: T | undefined;
  await selected.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

/**
 * Arm tenant isolation on an already-open transaction, once the tenant is known.
 *
 * The deferred half of `withSystemTx`. `set_config(..., true)` is transaction-local wherever it is
 * called from, so setting the GUC mid-transaction binds every subsequent statement in that
 * transaction and evaporates at COMMIT -- the same lifetime the GUCs set at BEGIN have.
 *
 * `app.user_id` is deliberately left unset: the actor is the system, and the role-scope helpers
 * (`app.can_read_student`, `app.teaches_class`) returning false is the correct default for an
 * unattended process. `emitAuditLog` reads that same GUC and writes a NULL `actor_id`, which is how
 * a webhook-driven audit row identifies itself as machine-made.
 */
export async function setTenantScope(
  tx: TransactionSql,
  schoolId: string,
  requestId?: string,
): Promise<void> {
  if (requestId !== undefined) {
    await tx`
      SELECT set_config('app.school_id', ${schoolId}, true),
             set_config('app.request_id', ${requestId}, true)
    `.execute();
    return;
  }
  await tx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
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

    return {
      tx,
      initial: initialResult.value as T,
      commit: () => close("COMMIT"),
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
