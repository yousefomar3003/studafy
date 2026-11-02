/**
 * Resolves a real admin user to act as while dumping/erasing a whole tenant (ST-268).
 *
 * `withSystemTenantTx` arms `app.school_id` and `SET LOCAL ROLE studafy_admin` but leaves
 * `app.user_id` unset, which is correct for the narrow, table-specific queries most system jobs run
 * (dunning-sweep.ts, seat-reconciliation.ts). This pipeline is different: it walks every discovered
 * tenant table (tenant-tables.ts), and several of them layer a `role_scope_visibility` RESTRICTIVE
 * policy on top of `tenant_isolation` whose backing functions (`app.can_read_class`,
 * `app.teaches_class`, ...) call `app.current_user_id()`, which raises `unrecognized configuration
 * parameter` the moment `app.user_id` was never set -- table empty or not. infra/tools/tenant-restore
 * hit this exact error building the sibling ST-267 tool and documents it in its README's "Known
 * gaps"; this resolves the same way that tool does: a real ORG_ADMIN (or, failing that, SUPER_ADMIN)
 * of the school, so every row a genuine administrator could see is what the pipeline sees.
 *
 * `app.teacher_evaluations`' `teacher_evaluation_visibility` policy has no admin escape hatch at all
 * (db/migrations/000014) -- no session identity this function can produce makes that table's rows
 * fully readable for a school. That gap is inherited here exactly as tenant-restore's README
 * documents it, not solved by this module.
 */

import type { TransactionSql } from "postgres";

export class NoAdminActorError extends Error {
  constructor(schoolId: string) {
    super(`school ${schoolId} has no ORG_ADMIN or SUPER_ADMIN user to act as for this pipeline`);
    this.name = "NoAdminActorError";
  }
}

/**
 * Finds an admin user of the school and returns their id, or throws NoAdminActorError. Read before
 * `app.user_id` is set (the query itself needs no role-scope visibility -- app.user_roles/app.users
 * carry only `tenant_isolation`, the same fact dunning-sweep.ts's `sendDunningReminders` already
 * relies on to read ORG_ADMIN recipients under a bare `withSystemTenantTx`).
 */
export async function resolveAdminActor(tx: TransactionSql, schoolId: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    SELECT u.id
    FROM app.user_roles AS ur
    JOIN app.users AS u ON u.id = ur.user_id
    WHERE ur.school_id = ${schoolId}::uuid
      AND ur.role IN ('ORG_ADMIN'::app.user_role, 'SUPER_ADMIN'::app.user_role)
    ORDER BY (ur.role = 'ORG_ADMIN'::app.user_role) DESC, u.created_at ASC
    LIMIT 1
  `;
  if (!row) throw new NoAdminActorError(schoolId);
  return row.id;
}

/** Arms `app.user_id` for the remainder of the current transaction. See this module's header. */
export async function armAdminActor(tx: TransactionSql, adminUserId: string): Promise<void> {
  await tx`SELECT set_config('app.user_id', ${adminUserId}, true)`.execute();
}
