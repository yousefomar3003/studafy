/**
 * Keeps the monthly-partitioned tables writable: app.audit_logs (000018) and the attendance family,
 * app.attendance_sessions and app.attendance_records (000012).
 *
 * Neither family has a default partition, by design, so an insert dated in a month that has no
 * partition fails. Migrations created partitions only through 2027-01, and the documented way to add
 * more was a manual command (`bun run db:audit:partitions`, `db:attendance:partitions`) that nothing
 * scheduled: from February 2027 every attendance write and every audited write would have failed.
 * This job runs the same SQL helpers those commands run, daily, keeping {@link MONTHS_AHEAD} months
 * ready.
 *
 * The helpers only create missing partitions, with the family's grants, RLS and indexes; they never
 * drop, detach or alter one, so running them every day is safe. They require studafy_admin. The
 * transaction takes the migration runner's advisory lock (packages/db/src/runner.ts), so it never
 * races a migration or a manual partition command; if that lock is held, this run is skipped and
 * the next day's run catches up.
 */

import type { Sql } from "postgres";

/** How many months beyond the current one to keep partitioned: the manual commands' default. */
export const MONTHS_AHEAD = 3;

/** packages/db/src/runner.ts ADVISORY_LOCK_KEY, shared by migrations and partition maintenance. */
export const PARTITION_ADVISORY_LOCK_KEY = "6004517954832980272";

export interface PartitionMaintenanceResult {
  /** False when a migration or another maintenance run held the lock. */
  ran: boolean;
  created: string[];
}

export interface PartitionLogger {
  info: (fields: Record<string, unknown>, message: string) => void;
}

const silentLogger: PartitionLogger = { info: () => undefined };

export async function ensureFuturePartitions(
  sql: Sql,
  log: PartitionLogger = silentLogger,
): Promise<PartitionMaintenanceResult> {
  const result = await sql.begin(async (tx) => {
    const [lock] = await tx<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${PARTITION_ADVISORY_LOCK_KEY}::bigint) AS locked
    `;
    if (!lock?.locked) return { ran: false, created: [] as string[] };
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [audit] = await tx<{ created: string[] | null }[]>`
      SELECT app.ensure_audit_log_partitions(${MONTHS_AHEAD}::integer) AS created
    `;
    const [attendance] = await tx<{ created: string[] | null }[]>`
      SELECT app.ensure_attendance_partitions(${MONTHS_AHEAD}::integer) AS created
    `;
    return { ran: true, created: [...(audit?.created ?? []), ...(attendance?.created ?? [])] };
  });
  log.info(
    { ran: result.ran, created: result.created },
    result.ran ? "table partitions ensured" : "table partition maintenance skipped: lock held",
  );
  return result;
}
