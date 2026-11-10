/**
 * Partition maintenance against a real database: after a run, app.audit_logs and both attendance
 * tables have a partition for every month from now through MONTHS_AHEAD months ahead, and a second
 * run creates nothing. Skipped (as a `skipIf` test) unless TEST_DATABASE_URL points at a migrated
 * database.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { MONTHS_AHEAD, ensureFuturePartitions } from "./partition-maintenance";

import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const maintenanceTest = test.skipIf(!databaseUrl);

let db: Sql | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 2, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

/** `audit_logs_y2027m02`-style suffixes for the current month through MONTHS_AHEAD ahead. */
function expectedSuffixes(now: Date): string[] {
  const suffixes: string[] = [];
  for (let offset = 0; offset <= MONTHS_AHEAD; offset += 1) {
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const mm = String(month.getUTCMonth() + 1).padStart(2, "0");
    suffixes.push(`y${month.getUTCFullYear()}m${mm}`);
  }
  return suffixes;
}

async function partitionsOf(parent: string): Promise<string[]> {
  const rows = await db!<{ name: string }[]>`
    SELECT child.relname AS name
    FROM pg_catalog.pg_inherits AS inherits
    JOIN pg_catalog.pg_class AS child ON child.oid = inherits.inhrelid
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inherits.inhparent
    JOIN pg_catalog.pg_namespace AS ns ON ns.oid = parent.relnamespace
    WHERE ns.nspname = 'app' AND parent.relname = ${parent}
  `;
  return rows.map((row) => row.name);
}

describe("partition maintenance", () => {
  maintenanceTest("keeps the coming months partitioned, and is idempotent", async () => {
    const first = await ensureFuturePartitions(db!);
    expect(first.ran).toBe(true);

    for (const parent of ["audit_logs", "attendance_sessions", "attendance_records"]) {
      const names = await partitionsOf(parent);
      for (const suffix of expectedSuffixes(new Date())) {
        expect(names).toContain(`${parent}_${suffix}`);
      }
    }

    const second = await ensureFuturePartitions(db!);
    expect(second).toEqual({ ran: true, created: [] });
  });
});
