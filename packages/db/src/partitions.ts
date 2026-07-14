// Shared administrative machinery for the monthly-partitioned table families (attendance, ST-040; audit
// logs, ST-046). Each family owns its own SQL helpers in its own migration -- their grants differ, and
// audit partitions must never receive UPDATE or DELETE -- but the operational envelope around them is the
// same, and is written once here: reserve a connection, take the shared advisory lock, call the family's
// ensure_* function as studafy_admin in one transaction, report what was created and what now exists.
//
// This is not runtime code. It connects with the administrative/migration identity and runs as
// studafy_admin; studafy_app has no EXECUTE on the underlying helpers and cannot run it.
import { createClient } from "./client";
import { loadMigrationConfig, redact } from "./config";
import { MigrationExecutionError, MigrationLockError } from "./errors";
import { ADVISORY_LOCK_KEY } from "./runner";

import type postgres from "postgres";

// Partition DDL and schema migrations share one lock. A scheduled maintenance invocation must never race
// a migration that changes these parents or their helper functions, two maintenance runs must not race
// each other, and -- because the lock is shared across families -- an attendance run and an audit run
// cannot collide either.
export const PARTITION_ADVISORY_LOCK_KEY = ADVISORY_LOCK_KEY;

const DEFAULT_MONTHS_AHEAD = 3;
const MAX_MONTHS_AHEAD = 24;

export interface PartitionCommandOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

// One monthly-partitioned table family. Every field is a compile-time constant defined in this package;
// none is ever derived from user input, which is what makes the interpolation of `ensureFunction` below
// safe. PostgreSQL cannot parameterize a function name.
export interface PartitionFamily {
  // Used in the connection's application_name and in error messages.
  readonly label: string;
  // Fully qualified ensure_* function, e.g. "app.ensure_audit_log_partitions".
  readonly ensureFunction: string;
  // The partitioned parents whose partitions are reported back after the run.
  readonly parents: readonly string[];
}

export const ATTENDANCE_PARTITIONS: PartitionFamily = {
  label: "attendance",
  ensureFunction: "app.ensure_attendance_partitions",
  parents: ["attendance_sessions", "attendance_records"],
};

export const AUDIT_LOG_PARTITIONS: PartitionFamily = {
  label: "audit log",
  ensureFunction: "app.ensure_audit_log_partitions",
  parents: ["audit_logs"],
};

async function acquireLock(sql: postgres.ReservedSql): Promise<void> {
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${PARTITION_ADVISORY_LOCK_KEY.toString()}) AS locked
  `;
  if (!row?.locked) {
    throw new MigrationLockError(
      "Another migration or partition maintenance process holds the lock",
    );
  }
}

export async function ensureMonthlyPartitions(
  family: PartitionFamily,
  monthsAhead: number,
  options: PartitionCommandOptions = {},
): Promise<string[]> {
  const config = loadMigrationConfig(options.env);
  const log = options.log ?? console.log;
  const client = createClient(config, `studafy-${family.label.replaceAll(" ", "-")}-partitions`);
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
      // family.ensureFunction is a constant from this module, never caller input; months_ahead is bound
      // as a parameter and is additionally range-checked by the SQL function itself.
      const [row] = (await reserved.unsafe(`SELECT ${family.ensureFunction}($1) AS created`, [
        monthsAhead,
      ])) as unknown as { created: string[] }[];
      created = row?.created ?? [];
      await reserved.unsafe("COMMIT");
    } catch (error) {
      await reserved.unsafe("ROLLBACK");
      const message = error instanceof Error ? error.message : "unknown PostgreSQL error";
      throw new MigrationExecutionError(`${family.label} partition maintenance failed: ${message}`);
    }

    const bounds = await reserved<{ partition: string; bounds: string }[]>`
      SELECT child.relname AS partition,
             pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS bounds
      FROM pg_catalog.pg_inherits AS inherits
      JOIN pg_catalog.pg_class AS child ON child.oid = inherits.inhrelid
      JOIN pg_catalog.pg_class AS parent ON parent.oid = inherits.inhparent
      JOIN pg_catalog.pg_namespace AS ns ON ns.oid = parent.relnamespace
      WHERE ns.nspname = 'app'
        AND parent.relname = ANY (${family.parents as string[]})
      ORDER BY child.relname
    `;

    if (created.length === 0) {
      log(`no partitions created; ${bounds.length} ${family.label} partition(s) already present`);
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
