/**
 * QA-049: a migration waiting on a lock gives up quickly, instead of taking the API down.
 *
 * The runner set no lock_timeout. An ALTER TABLE queued behind a long transaction holds its place
 * in the lock queue, and every later query on that hot table (outbox_events, users, audit_logs)
 * queues behind it: the API stalls for as long as the blocker runs. Each migration now runs with
 * lock_timeout (default 5 s) and statement_timeout (default 15 min), overridable per file in its
 * header directive, and a timeout rolls the migration back completely.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/runner-lock-timeout.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { discoverMigrations } from "../src/discovery";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, migrationFixture, runnerEnv, testDatabase } from "./helpers";

const describeDb = integrationEnabled ? describe : describe.skip;

describe("migration header timeouts (QA-049)", () => {
  test("defaults, and per-file overrides alongside transaction=off", async () => {
    const fixture = await migrationFixture({
      "000001_plain.sql": "SELECT 1;\n",
      "000002_slow_backfill.sql":
        "-- studafy:migration lock_timeout=30s statement_timeout=2h\nSELECT 1;\n",
      "000003_concurrent.sql": "-- studafy:migration transaction=off lock_timeout=10s\nSELECT 1;\n",
    });
    try {
      const [plain, slow, concurrent] = await discoverMigrations(fixture.directory);
      expect([plain!.lockTimeout, plain!.statementTimeout]).toEqual(["5s", "15min"]);
      expect([slow!.lockTimeout, slow!.statementTimeout, slow!.transactional]).toEqual([
        "30s",
        "2h",
        true,
      ]);
      expect([concurrent!.lockTimeout, concurrent!.transactional]).toEqual(["10s", false]);
    } finally {
      await fixture.cleanup();
    }
  });

  test("a malformed timeout is refused at discovery", async () => {
    const fixture = await migrationFixture({
      "000001_bad.sql": "-- studafy:migration lock_timeout=5 seconds; DROP TABLE x\nSELECT 1;\n",
    });
    try {
      await expect(discoverMigrations(fixture.directory)).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});

let database: Awaited<ReturnType<typeof testDatabase>> | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await testDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
});

describeDb("a blocked migration (QA-049)", () => {
  test("fails within seconds when a lock it needs is held, and leaves nothing behind", async () => {
    const first = await migrationFixture({
      "000001_create_hot.sql": "CREATE TABLE public.hot (id int);\n",
    });
    const second = await migrationFixture({
      "000001_create_hot.sql": "CREATE TABLE public.hot (id int);\n",
      "000002_alter_hot.sql": "ALTER TABLE public.hot ADD COLUMN extra int;\n",
    });
    const blocker = postgres(database!.url, { max: 1, ssl: false });
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database!.url, first.directory),
        log: () => undefined,
      });

      // A long transaction holding the table, as a busy request or report would.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const holding = blocker.begin(async (tx) => {
        await tx`LOCK TABLE public.hot IN ACCESS SHARE MODE`;
        await held;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const started = Date.now();
      const outcome = await runMigrationCommand("migrate", {
        env: runnerEnv(database!.url, second.directory),
        log: () => undefined,
      }).catch((error: unknown) => error);
      const elapsed = Date.now() - started;
      release();
      await holding;

      expect(outcome).toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).toMatch(/lock timeout/i);
      expect(elapsed).toBeLessThan(15_000);
      const columns = await database!.sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'hot'
      `;
      expect(columns.map((c) => c.column_name)).toEqual(["id"]);
      const applied = await database!.sql<{ version: string }[]>`
        SELECT version::text FROM public.schema_migrations ORDER BY version
      `;
      expect(applied.map((row) => row.version)).toEqual(["1"]);
    } finally {
      await blocker.end({ timeout: 5 });
      await first.cleanup();
      await second.cleanup();
    }
  }, 60_000);
});
