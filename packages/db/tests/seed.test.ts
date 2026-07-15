import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { DEMO_SCHOOL_SLUG } from "../../../db/seeds/data/school";
import { assertSeedAllowed, resolveHost, SeedSafetyError } from "../../../db/seeds/guard";
import { checkIndexHealth } from "../../../db/seeds/index-health";
import { seedDemoTenant } from "../../../db/seeds/seed";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { MigrationConfig } from "../src/config";

// The seed integration test creates a disposable database, runs all 25 migrations, seeds 40+
// tables, and verifies index health — it needs a generous timeout budget (60 s) that conflicts
// with the main CI suite's 10-second --timeout flag. Gating on SEED_INTEGRATION keeps it
// skipped in the main `bun test` step so it only runs in the dedicated CI step.
const seedIntegration = Boolean(process.env.SEED_INTEGRATION);
const integrationTest = test.skipIf(!integrationEnabled || !seedIntegration);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

// The acceptance target from the ticket.
const SEED_BUDGET_MS = 2000;

function localConfig(overrides: Partial<MigrationConfig> = {}): MigrationConfig {
  return {
    url: "postgresql://studafy_test:pw@localhost:5432/postgres",
    ssl: false,
    migrationsDir: "db/migrations",
    redactions: [],
    ...overrides,
  };
}

// --- Guard unit tests (no database required) ---

test("guard blocks NODE_ENV=production before any host check", () => {
  expect(() => assertSeedAllowed({ NODE_ENV: "production" }, localConfig())).toThrow(
    SeedSafetyError,
  );
});

test("guard blocks APP_ENV=production", () => {
  expect(() => assertSeedAllowed({ APP_ENV: "production" }, localConfig())).toThrow(
    SeedSafetyError,
  );
});

test("guard blocks a managed-database host even with the non-local override", () => {
  const config = localConfig({
    url: "postgresql://studafy:pw@studafy-prod.abc123.eu-west-1.rds.amazonaws.com:5432/studafy",
  });
  expect(() => assertSeedAllowed({ SEED_ALLOW_NONLOCAL: "true" }, config)).toThrow(SeedSafetyError);
});

test("guard blocks a staging-shaped host", () => {
  const config = localConfig({ url: "postgresql://studafy:pw@db.staging.internal:5432/studafy" });
  expect(() => assertSeedAllowed({}, config)).toThrow(SeedSafetyError);
});

test("guard allows a loopback host", () => {
  expect(() => assertSeedAllowed({}, localConfig())).not.toThrow();
});

test("resolveHost strips IPv6 brackets", () => {
  expect(resolveHost(localConfig({ url: "postgresql://u:p@[::1]:5432/db" }))).toBe("::1");
});

// --- Full seed integration test (disposable Postgres) ---

integrationTest(
  "seeds a coherent demo tenant under budget and passes the index health check",
  async () => {
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, repositoryMigrations),
        log: () => undefined,
      });

      const env = { DATABASE_URL: database.url, DATABASE_SSL_MODE: "disable" };

      const result = await seedDemoTenant({ env });
      expect(result.seeded).toBe(true);
      expect(result.elapsedMs ?? Number.POSITIVE_INFINITY).toBeLessThan(SEED_BUDGET_MS);

      // The seed touched well over ten interconnected domain tables.
      const populated = (result.counts ?? []).filter((row) => row.row_count > 0);
      expect(populated.length).toBeGreaterThanOrEqual(20);

      // The connection role in tests is a superuser and bypasses RLS, so these counts see every seeded
      // row directly.
      const [{ count: users }] = await database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.users
      `;
      expect(users).toBeGreaterThan(0);

      const [{ count: chunks }] = await database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.material_chunks
      `;
      expect(chunks).toBeGreaterThan(0);

      const [{ count: citations }] = await database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.ai_message_citations
      `;
      expect(citations).toBeGreaterThan(0);

      // notification_preferences are trigger-seeded per active user (8 types x 3 channels).
      const [{ count: prefs }] = await database.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.notification_preferences
      `;
      expect(prefs).toBe(users * 8 * 3);

      // Every tenant row belongs to exactly one school: the demo school.
      const [{ schools }] = await database.sql<{ schools: number }[]>`
        SELECT count(DISTINCT school_id)::int AS schools FROM app.users
      `;
      expect(schools).toBe(1);

      // Attendance record -> session key foreign key resolved (no orphans would have been possible, but
      // this confirms the millisecond-precision session_created_at wiring).
      const [{ records }] = await database.sql<{ records: number }[]>`
        SELECT count(*)::int AS records FROM app.attendance_records
      `;
      expect(records).toBeGreaterThan(0);

      const report = await checkIndexHealth({ env });
      expect(report.schoolFound).toBe(true);
      expect(report.invalidIndexes).toHaveLength(0);
      expect(report.probes.length).toBeGreaterThan(0);
      expect(report.healthy).toBe(true);

      // Re-running against the same (already seeded) database is a clean no-op.
      const rerun = await seedDemoTenant({ env });
      expect(rerun.seeded).toBe(false);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

test("demo slug is a valid school slug", () => {
  expect(DEMO_SCHOOL_SLUG).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
});
