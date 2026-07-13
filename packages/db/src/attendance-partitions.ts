// Administrative partition maintenance for the monthly-partitioned attendance tables (ST-040).
//
// Creates every missing monthly partition from the current UTC month through months-ahead months
// later, giving each new partition its owner, grants, forced RLS, canonical tenant policy, and the
// parent's indexes. It never drops, detaches, or alters an existing partition: retention is out of
// scope and deliberately not automated. See docs/database/attendance-partition-maintenance.md.
//
// This is not runtime code. It connects with the administrative/migration identity and runs as
// studafy_admin; studafy_app has no EXECUTE on the underlying helpers and cannot run it.
import { createClient } from "./client";
import { loadMigrationConfig, redact } from "./config";
import { MigrationExecutionError, MigrationLockError } from "./errors";
import { ADVISORY_LOCK_KEY } from "./runner";

import type postgres from "postgres";

// Partition DDL and schema migrations share one lock. A scheduled maintenance invocation must never
// race a migration that changes these parents or their helper functions, and two maintenance runs
// must not race each other.
export const PARTITION_ADVISORY_LOCK_KEY = ADVISORY_LOCK_KEY;

const DEFAULT_MONTHS_AHEAD = 3;
const MAX_MONTHS_AHEAD = 24;

export interface PartitionCommandOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

async function acquireLock(sql: postgres.ReservedSql): Promise<void> {
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${PARTITION_ADVISORY_LOCK_KEY.toString()}) AS locked
  `;
  if (!row?.locked) {
    throw new MigrationLockError(
      "Another migration or attendance partition maintenance process holds the lock",
    );
  }
}

export async function ensureAttendancePartitions(
  monthsAhead: number,
  options: PartitionCommandOptions = {},
): Promise<string[]> {
  const config = loadMigrationConfig(options.env);
  const log = options.log ?? console.log;
  const client = createClient(config, "studafy-attendance-partitions");
  let reserved: postgres.ReservedSql | undefined;
  let locked = false;

  try {
    reserved = await client.reserve();
    await acquireLock(reserved);
    locked = true;

    let created: string[];
    try {
      await reserved.unsafe("BEGIN");
      await reserved.unsafe("SET LOCAL ROLE studafy_admin");
      const [row] = await reserved<{ created: string[] }[]>`
        SELECT app.ensure_attendance_partitions(${monthsAhead}) AS created
      `;
      created = row?.created ?? [];
      await reserved.unsafe("COMMIT");
    } catch (error) {
      await reserved.unsafe("ROLLBACK");
      const message = error instanceof Error ? error.message : "unknown PostgreSQL error";
      throw new MigrationExecutionError(`attendance partition maintenance failed: ${message}`);
    }

    const bounds = await reserved<{ partition: string; bounds: string }[]>`
      SELECT child.relname AS partition,
             pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS bounds
      FROM pg_catalog.pg_inherits AS inherits
      JOIN pg_catalog.pg_class AS child ON child.oid = inherits.inhrelid
      JOIN pg_catalog.pg_class AS parent ON parent.oid = inherits.inhparent
      JOIN pg_catalog.pg_namespace AS ns ON ns.oid = parent.relnamespace
      WHERE ns.nspname = 'app'
        AND parent.relname IN ('attendance_sessions', 'attendance_records')
      ORDER BY child.relname
    `;

    if (created.length === 0) {
      log(`no partitions created; ${bounds.length} attendance partition(s) already present`);
    } else {
      for (const name of created) log(`created app.${name}`);
    }
    for (const row of bounds) log(`  app.${row.partition} ${row.bounds}`);

    return created;
  } catch (error) {
    if (error instanceof Error) error.message = redact(error.message, config.redactions);
    throw error;
  } finally {
    if (reserved && locked) {
      try {
        await reserved`SELECT pg_advisory_unlock(${PARTITION_ADVISORY_LOCK_KEY.toString()})`;
      } catch {
        // A lost session has already released its PostgreSQL advisory lock.
      }
    }
    reserved?.release();
    await client.end({ timeout: 5 });
  }
}

export function parseMonthsAhead(args: readonly string[]): number | undefined {
  if (args.length === 0) return DEFAULT_MONTHS_AHEAD;
  if (args.length > 1) return undefined;
  const value = Number(args[0]);
  if (!Number.isInteger(value) || value < 0 || value > MAX_MONTHS_AHEAD) return undefined;
  return value;
}
