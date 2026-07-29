/**
 * Tenant-scoped transactions for the workers process.
 *
 * Every table a worker touches has RLS ENABLED and FORCED, with policies keyed on
 * `current_setting('app.school_id')::uuid`. A query outside a transaction that has set that GUC
 * does not error — it returns **zero rows**, which is the failure mode most likely to be mistaken
 * for "no data" and shipped. This wrapper makes the GUC and the transaction inseparable.
 *
 * A port of apps/api/src/db/tenant-tx.ts rather than an import: apps/workers does not depend on
 * apps/api, and `@studafy/db` exports only the migration runner's single-connection admin client
 * (`max: 1`, primary-only), which is the wrong shape for a job processor. The block this replaces
 * was previously copy-pasted inline in bulk-invite-processor.ts and imports/worker.ts.
 */

import type { Sql, TransactionSql } from "postgres";

export interface TenantContext {
  schoolId: string;
  /**
   * The acting user, when there is one. Workers usually act on the system's behalf rather than a
   * person's, and the `app.user_id` GUC drives the role-scope helpers (`app.can_read_student`,
   * `app.teaches_class`). Leaving it unset makes those helpers return false, which is the correct
   * default for an unattended process: a worker sees what tenant isolation allows and no more.
   */
  userId?: string;
}

export async function withTenantTx<T>(
  sql: Sql,
  context: TenantContext,
  fn: (tx: TransactionSql) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (tx) => {
    if (options.readOnly) await tx`SET TRANSACTION READ ONLY`;
    await configureTenantTx(tx, context);
    result = await fn(tx);
  });
  return result as T;
}

/**
 * A tenant transaction for work the system does on a school's behalf, with no acting user.
 *
 * Tenant isolation still binds. Intra-tenant row scope does not. That distinction is the whole
 * point, and it is worth being precise about why it is safe:
 *
 * - `tenant_isolation` is PERMISSIVE, granted `TO PUBLIC`, and every table it guards is created
 *   with FORCE ROW LEVEL SECURITY — which extends RLS to the table's owner. `studafy_admin` owns
 *   these tables and has neither SUPERUSER nor BYPASSRLS, so it is still fully subject to
 *   `school_id = current_setting('app.school_id')`. A bug here cannot cross a tenant boundary.
 * - `role_scope_visibility`, `notifications_owner_select` and friends are RESTRICTIVE and granted
 *   `TO studafy_app` specifically. They resolve the *acting user* from `app.user_id`, and an
 *   unattended process has none.
 *
 * Without this, the alert engine reads zero rows and writes none — every one of its tables is
 * row-scoped, and a restrictive SELECT policy also gates `INSERT ... RETURNING`. That failure is
 * silent and indistinguishable from "nobody was absent", which is the worst possible way for an
 * alerting feature to break.
 *
 * `SET LOCAL ROLE` is transaction-local like the GUCs beside it, so the elevation ends at COMMIT.
 * Use `withTenantTx` for anything acting for a user; reach for this only where the actor genuinely
 * is the system.
 */
export async function withSystemTenantTx<T>(
  sql: Sql,
  context: Pick<TenantContext, "schoolId">,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (tx) => {
    // Order matters: the GUC is set first so tenant isolation is armed before the role changes.
    await tx`SELECT set_config('app.school_id', ${context.schoolId}, true)`.execute();
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await fn(tx);
  });
  return result as T;
}

/**
 * `set_config(..., true)` is transaction-local, exactly like SET LOCAL — including for the special
 * `role` setting. That is what makes this safe under PgBouncer transaction pooling: the settings
 * evaporate at COMMIT or ROLLBACK rather than leaking to whoever gets the connection next.
 *
 * The branches are explicit rather than built by string concatenation so each variant stays a
 * parameterised query.
 */
function configureTenantTx(tx: TransactionSql, context: TenantContext): Promise<unknown> {
  if (context.userId !== undefined) {
    return tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${context.schoolId}, true),
             set_config('app.user_id', ${context.userId}, true)
    `.execute();
  }
  return tx`
    SELECT set_config('role', 'studafy_app', true),
           set_config('app.school_id', ${context.schoolId}, true)
  `.execute();
}
