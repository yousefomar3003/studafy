/**
 * Which schools have outbox rows waiting for a given consumer — one statement, whatever the number
 * of schools.
 *
 * `app.outbox_events` is tenant-isolated and its policy reads `app.school_id` without `missing_ok`,
 * so "which tenants have pending rows" cannot be asked as one cross-tenant SELECT, and this schema
 * deliberately has no policy that would allow it. `app.outbox_pending_school_ids` (000200) instead
 * walks `app.schools` and, for each one, arms tenant isolation for that school and probes the
 * consumer's partial index — the same per-school scoping `withSystemTenantTx` gives a claim, batched
 * into one round trip. It is SECURITY INVOKER and executable only by `studafy_admin`, hence
 * `withSystemTx`.
 *
 * The consumers then open a claim transaction only for the schools this returns, rather than one
 * per school per cycle.
 */

import { withSystemTx } from "../db/tenant-tx";

import type { Sql, TransactionSql } from "postgres";

/** Must match the consumer names `app.outbox_pending_school_ids` accepts. */
export type OutboxConsumer = "relay" | "email" | "entitlement" | "notify" | "push";

/** For callers already inside a `withSystemTx` that want to add their own checks to the statement. */
export function pendingSchoolIdsFragment(tx: TransactionSql, consumer: OutboxConsumer) {
  return tx`ARRAY(SELECT pending.id::text FROM app.outbox_pending_school_ids(${consumer}) AS pending (id))`;
}

export async function discoverPendingSchools(db: Sql, consumer: OutboxConsumer): Promise<string[]> {
  return withSystemTx(db, async (tx) => {
    const [row] = await tx<{ school_ids: string[] }[]>`
      SELECT ${pendingSchoolIdsFragment(tx, consumer)} AS school_ids
    `;
    return row?.school_ids ?? [];
  });
}
