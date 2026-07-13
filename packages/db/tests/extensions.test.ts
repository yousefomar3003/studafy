import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type postgres from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

const REQUIRED_EXTENSIONS = ["pgcrypto", "pg_trgm", "vector", "pg_stat_statements"] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_app" | "studafy_admin" | "studafy_monitor";

// Applies the committed migrations (including 000003) to a fresh disposable database.
async function migratedDatabase(): Promise<Database> {
  const database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
  return database;
}

// Runs statements inside one transaction with the session role switched for its duration only.
async function asRole(
  database: Database,
  role: Role,
  run: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await run(tx);
  });
}

// Asserts a single statement is rejected for the given role (each in its own aborted transaction).
async function expectDenied(database: Database, role: Role, statement: string): Promise<void> {
  await expect(
    asRole(database, role, (tx) => tx.unsafe(statement).then(() => undefined)),
  ).rejects.toThrow();
}

// True when pg_stat_statements is actually loaded, so its views collect and return rows.
async function statStatementsPreloaded(database: Database): Promise<boolean> {
  const [row] = await database.sql<{ loaded: boolean }[]>`
    SELECT coalesce(strpos(current_setting('shared_preload_libraries', true), 'pg_stat_statements'), 0) > 0
      AS loaded
  `;
  return row?.loaded ?? false;
}

// Total statements recorded for this disposable database. Comparing snapshots avoids relying on
// pg_stat_statements' representative query text, which may come from an equivalent earlier query.
async function statStatementCalls(database: Database): Promise<number> {
  const [row] = await database.sql<{ calls: string }[]>`
    SELECT coalesce(sum(calls), 0)::text AS calls
    FROM public.pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  `;
  return Number(row?.calls ?? "0");
}

integrationTest("installs the four required extensions with resolvable versions", async () => {
  const database = await migratedDatabase();
  try {
    const rows = await database.sql<{ extname: string; extversion: string }[]>`
      SELECT extname, extversion
      FROM pg_extension
      WHERE extname = ANY(${REQUIRED_EXTENSIONS as unknown as string[]})
      ORDER BY extname
    `;
    expect(rows.map((row) => row.extname)).toEqual([...REQUIRED_EXTENSIONS].sort());
    for (const row of rows) {
      expect(row.extversion.length).toBeGreaterThan(0);
    }
  } finally {
    await database.cleanup();
  }
});

integrationTest("is idempotent and keeps migration history valid on a second run", async () => {
  const database = await migratedDatabase();
  try {
    const env = runnerEnv(database.url, repositoryMigrations);
    const second = await runMigrationCommand("migrate", { env, log: () => undefined });
    expect(second.pending).toHaveLength(0);

    const [migrations] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.schema_migrations
    `;
    expect(migrations?.count).toBe("11");

    const [extensions] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_extension WHERE extname = ANY(${
        REQUIRED_EXTENSIONS as unknown as string[]
      })
    `;
    expect(extensions?.count).toBe("4");

    const validation: string[] = [];
    await runMigrationCommand("validate", { env, log: (line) => validation.push(line) });
    expect(validation).toContain("validated 11 applied migration(s)");
  } finally {
    await database.cleanup();
  }
});

integrationTest("extensions are owned administratively, never by studafy_app", async () => {
  const database = await migratedDatabase();
  try {
    const [owned] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM pg_extension
      WHERE extname = ANY(${REQUIRED_EXTENSIONS as unknown as string[]})
        AND extowner = 'studafy_app'::regrole
    `;
    expect(owned?.count).toBe("0");

    // The runtime role cannot manage extensions at all.
    await expectDenied(database, "studafy_app", `CREATE EXTENSION IF NOT EXISTS citext`);
    await expectDenied(database, "studafy_app", `ALTER EXTENSION pg_trgm UPDATE`);
    await expectDenied(database, "studafy_app", `DROP EXTENSION pg_trgm`);
  } finally {
    await database.cleanup();
  }
});

integrationTest("pgcrypto exposes safe functions to the runtime role", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_app", async (tx) => {
      const [uuid] = await tx.unsafe<{ value: string }[]>(
        `SELECT gen_random_uuid()::text AS value`,
      );
      expect(uuid?.value).toMatch(/^[0-9a-f-]{36}$/);
      const [digest] = await tx.unsafe<{ length: number }[]>(
        `SELECT length(digest('studafy', 'sha256')) AS length`,
      );
      expect(digest?.length).toBe(32);
    });
  } finally {
    await database.cleanup();
  }
});

integrationTest("pgvector types and distance operators are available", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_app", async (tx) => {
      const [cast] = await tx.unsafe<{ value: string }[]>(
        `SELECT '[1,2,3]'::vector::text AS value`,
      );
      expect(cast?.value).toBe("[1,2,3]");
      const [distance] = await tx.unsafe<{ l2: number }[]>(
        `SELECT ('[1,2,3]'::vector <-> '[1,2,4]'::vector)::float8 AS l2`,
      );
      expect(distance?.l2).toBeCloseTo(1, 5);
    });
  } finally {
    await database.cleanup();
  }
});

integrationTest("pg_trgm similarity is available", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_app", async (tx) => {
      const [row] = await tx.unsafe<{ score: number }[]>(
        `SELECT similarity('studify', 'studafy')::float8 AS score`,
      );
      expect(row?.score).toBeGreaterThan(0);
      expect(row?.score).toBeLessThan(1);
    });
  } finally {
    await database.cleanup();
  }
});

integrationTest("pg_stat_statements is readable only by the monitoring role", async () => {
  const database = await migratedDatabase();
  try {
    const [privileges] = await database.sql<
      { app_select: boolean; monitor_select: boolean; monitor_reads_stats: boolean }[]
    >`
      SELECT
        has_table_privilege('studafy_app', 'public.pg_stat_statements', 'SELECT') AS app_select,
        has_table_privilege('studafy_monitor', 'public.pg_stat_statements', 'SELECT') AS monitor_select,
        pg_has_role('studafy_monitor', 'pg_read_all_stats', 'USAGE') AS monitor_reads_stats
    `;
    expect(privileges).toEqual({
      app_select: false,
      monitor_select: true,
      monitor_reads_stats: true,
    });

    // The runtime role is refused by privilege before the view is ever evaluated, so this holds
    // whether or not the module is preloaded.
    await expectDenied(database, "studafy_app", `SELECT queryid FROM public.pg_stat_statements`);

    // The monitoring role can read the view where the module is actually loaded. When it is not,
    // the view raises for everyone; the grant itself is already proven by the catalog check above.
    if (await statStatementsPreloaded(database)) {
      await asRole(database, "studafy_monitor", (tx) =>
        tx.unsafe(`SELECT count(*) FROM public.pg_stat_statements`).then(() => undefined),
      );
    }
  } finally {
    await database.cleanup();
  }
});

integrationTest("pg_stat_statements collects statistics when preloaded", async () => {
  const database = await migratedDatabase();
  try {
    if (!(await statStatementsPreloaded(database))) {
      // Honest fail-open: without shared_preload_libraries the view raises on read. Prove that,
      // rather than claiming the extension is operational. Preload it (see db/compose.yml) to run
      // the operational assertions below.
      await expect(database.sql`SELECT count(*) FROM public.pg_stat_statements`).rejects.toThrow();
      return;
    }

    // Query text is normalized and may be retained from an equivalent earlier statement. Compare
    // database-scoped call totals instead so the assertion proves statistics are actively collected.
    const callsBefore = await statStatementCalls(database);
    await database.sql`SELECT 1`;
    const callsAfter = await statStatementCalls(database);
    expect(callsAfter).toBeGreaterThan(callsBefore);
  } finally {
    await database.cleanup();
  }
});

integrationTest("monitoring and runtime roles cannot escalate", async () => {
  const database = await migratedDatabase();
  try {
    // studafy_monitor is telemetry-only: it cannot manage extensions.
    await expectDenied(database, "studafy_monitor", `CREATE EXTENSION IF NOT EXISTS citext`);
    await expectDenied(database, "studafy_monitor", `ALTER EXTENSION vector UPDATE`);
    await expectDenied(database, "studafy_monitor", `DROP EXTENSION vector`);

    // No role can assume another. Membership is the correct probe: SET ROLE is checked against the
    // session login (the superuser test connection), so it is not a valid escalation test here.
    const [membership] = await database.sql<
      { app_in_monitor: boolean; app_in_admin: boolean; monitor_in_admin: boolean }[]
    >`
      SELECT
        pg_has_role('studafy_app', 'studafy_monitor', 'MEMBER') AS app_in_monitor,
        pg_has_role('studafy_app', 'studafy_admin', 'MEMBER') AS app_in_admin,
        pg_has_role('studafy_monitor', 'studafy_admin', 'MEMBER') AS monitor_in_admin
    `;
    expect(membership).toEqual({
      app_in_monitor: false,
      app_in_admin: false,
      monitor_in_admin: false,
    });
  } finally {
    await database.cleanup();
  }
});
