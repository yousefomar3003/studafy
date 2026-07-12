import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "bun:test";
import postgres from "postgres";

import { MigrationExecutionError, MigrationValidationError } from "../src/errors";
import { ADVISORY_LOCK_KEY, runMigrationCommand } from "../src/runner";

import { integrationEnabled, migrationFixture, runnerEnv, testDatabase } from "./helpers";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const cli = resolve(import.meta.dir, "../src/cli.ts");

integrationTest("initializes an empty database and is idempotent", async () => {
  const database = await testDatabase();
  try {
    const env = runnerEnv(database.url, repositoryMigrations);
    const first = await runMigrationCommand("migrate", { env, log: () => undefined });
    const second = await runMigrationCommand("migrate", { env, log: () => undefined });
    expect(first.applied).toHaveLength(9);
    expect(second.applied).toHaveLength(9);
    const [count] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.schema_migrations
    `;
    expect(count?.count).toBe("9");
    const statusLog: string[] = [];
    await runMigrationCommand("status", { env, log: (line) => statusLog.push(line) });
    expect(statusLog).toContain("applied  000001_initial_noop.sql");
    expect(statusLog).toContain("applied  000002_create_database_roles_and_grants.sql");
    expect(statusLog).toContain("applied  000003_enable_required_postgresql_extensions.sql");
    expect(statusLog).toContain("applied  000004_create_global_tables.sql");
    expect(statusLog).toContain("applied  000005_seed_countries_and_currencies.sql");
    expect(statusLog).toContain("applied  000006_create_rls_helper.sql");
    expect(statusLog).toContain("applied  000007_create_users_and_identity_tables.sql");
    expect(statusLog).toContain("applied  000008_create_student_and_teacher_profile_tables.sql");
    expect(statusLog).toContain("applied  000009_create_academic_structure_tables.sql");
    const validationLog: string[] = [];
    await runMigrationCommand("validate", { env, log: (line) => validationLog.push(line) });
    expect(validationLog).toContain("validated 9 applied migration(s)");
  } finally {
    await database.cleanup();
  }
});

integrationTest("detects renamed and missing applied migration files", async () => {
  const database = await testDatabase();
  const fixture = await migrationFixture({ "000001_original.sql": "SELECT 1;\n" });
  const original = resolve(fixture.directory, "000001_original.sql");
  const renamed = resolve(fixture.directory, "000001_renamed.sql");
  try {
    const env = runnerEnv(database.url, fixture.directory);
    await runMigrationCommand("migrate", { env, log: () => undefined });
    // Both paths belong to the fresh fixture directory created by this test.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await rename(original, renamed);
    await expect(runMigrationCommand("validate", { env, log: () => undefined })).rejects.toThrow(
      "was renamed",
    );
    await rm(renamed);
    await expect(runMigrationCommand("validate", { env, log: () => undefined })).rejects.toThrow(
      "is missing",
    );
  } finally {
    await fixture.cleanup();
    await database.cleanup();
  }
});

integrationTest("applies ordered fixtures and detects checksum tampering", async () => {
  const database = await testDatabase();
  const fixture = await migrationFixture({
    "000001_create_probe.sql": "CREATE TABLE probe (id integer PRIMARY KEY);\n",
    "000002_insert_probe.sql": "INSERT INTO probe (id) VALUES (2);\n",
  });
  try {
    const env = runnerEnv(database.url, fixture.directory);
    await runMigrationCommand("migrate", { env, log: () => undefined });
    const rows = await database.sql<{ id: number }[]>`SELECT id FROM probe ORDER BY id`;
    expect(rows.map(({ id }) => id)).toEqual([2]);
    // The controlled tamper occurs only in the disposable fixture, never the committed migration.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(
      resolve(fixture.directory, "000001_create_probe.sql"),
      "CREATE TABLE probe (id bigint PRIMARY KEY);\n",
    );
    await expect(
      runMigrationCommand("validate", { env, log: () => undefined }),
    ).rejects.toBeInstanceOf(MigrationValidationError);
  } finally {
    await fixture.cleanup();
    await database.cleanup();
  }
});

integrationTest("rolls back a failed transactional migration without recording it", async () => {
  const database = await testDatabase();
  const fixture = await migrationFixture({
    "000001_failure.sql":
      "CREATE TABLE rollback_probe (id integer);\nSELECT definitely_missing_column FROM rollback_probe;\n",
  });
  try {
    const env = runnerEnv(database.url, fixture.directory);
    await expect(
      runMigrationCommand("migrate", { env, log: () => undefined }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);
    const [table] = await database.sql<{ table_name: string | null }[]>`
      SELECT to_regclass('public.rollback_probe')::text AS table_name
    `;
    const [count] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.schema_migrations
    `;
    expect(table?.table_name).toBeNull();
    expect(count?.count).toBe("0");
  } finally {
    await fixture.cleanup();
    await database.cleanup();
  }
});

integrationTest("non-transactional migrations record only successful files", async () => {
  const database = await testDatabase();
  const fixture = await migrationFixture({
    "000001_table.sql": "CREATE TABLE indexed_probe (id integer PRIMARY KEY);\n",
    "000002_index.sql":
      "-- studafy:migration transaction=off\nCREATE INDEX CONCURRENTLY idx_indexed_probe_id ON indexed_probe (id);\n",
    "000003_failure.sql":
      "-- studafy:migration transaction=off\nSELECT missing_column FROM indexed_probe;\n",
  });
  try {
    await expect(
      runMigrationCommand("migrate", {
        env: runnerEnv(database.url, fixture.directory),
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(MigrationExecutionError);
    const [count] = await database.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM public.schema_migrations
      `;
    const [index] = await database.sql<{ index_name: string | null }[]>`
        SELECT to_regclass('public.idx_indexed_probe_id')::text AS index_name
      `;
    expect(count?.count).toBe("2");
    expect(index?.index_name).toBe("idx_indexed_probe_id");
  } finally {
    await fixture.cleanup();
    await database.cleanup();
  }
});

integrationTest(
  "a competing CLI process fails immediately without duplicate application",
  async () => {
    const database = await testDatabase();
    const fixture = await migrationFixture({
      "000001_slow.sql": "SELECT pg_sleep(2);\n",
    });
    const env = { ...process.env, ...runnerEnv(database.url, fixture.directory) };
    try {
      const first = Bun.spawn([process.execPath, cli, "migrate"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const [row] = await database.sql<{ locked: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND granted
        ) AS locked
      `;
        if (row?.locked) break;
        await Bun.sleep(50);
      }

      const second = Bun.spawn([process.execPath, cli, "migrate"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const secondExit = await second.exited;
      const secondError = await new Response(second.stderr).text();
      const firstExit = await first.exited;
      expect(firstExit).toBe(0);
      expect(secondExit).toBe(1);
      expect(secondError).toContain("MigrationLockError");

      const verification = postgres(database.url, { ssl: false, max: 1 });
      const [count] = await verification<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.schema_migrations
    `;
      expect(count?.count).toBe("1");
      await verification.end();
    } finally {
      await fixture.cleanup();
      await database.cleanup();
    }
  },
);

test("uses the documented stable advisory lock key", () => {
  expect(ADVISORY_LOCK_KEY).toBe(6004517954832980272n);
});
