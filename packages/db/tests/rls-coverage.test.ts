import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { auditRlsCoverage, formatRlsCoverageReport } from "../../../db/policies/rls-coverage";
import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { CatalogClient, RlsCoverageReport } from "../../../db/policies/rls-coverage";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryRoot = resolve(import.meta.dir, "../../..");
const repositoryMigrations = resolve(repositoryRoot, "db/migrations");

type Database = Awaited<ReturnType<typeof testDatabase>>;

async function migratedDatabase(): Promise<Database> {
  const database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
  return database;
}

function catalogClient(value: unknown): CatalogClient {
  return value as CatalogClient;
}

function hasViolation(report: RlsCoverageReport, ruleCode: string, tableName: string): boolean {
  return report.violations.some(
    (violation) => violation.ruleCode === ruleCode && violation.tableName === tableName,
  );
}

const SEEDED_VIOLATIONS = String.raw`
SET LOCAL ROLE studafy_admin;

CREATE TABLE app.st050_bad_rls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id)
);
CREATE INDEX idx_st050_bad_rls_school_id ON app.st050_bad_rls (school_id, id);
CREATE POLICY tenant_isolation ON app.st050_bad_rls FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);

CREATE TABLE app.st050_bad_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id)
);
CREATE INDEX idx_st050_bad_policy_school_id ON app.st050_bad_policy (school_id, id);
ALTER TABLE app.st050_bad_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_bad_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_bad_policy FOR ALL TO PUBLIC
  USING (true) WITH CHECK (true);

CREATE TABLE app.st050_bad_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id)
);
ALTER TABLE app.st050_bad_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_bad_index FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_bad_index FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);

CREATE TABLE app.st050_bad_school_fk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid
);
CREATE INDEX idx_st050_bad_school_fk_school_id ON app.st050_bad_school_fk (school_id, id);
ALTER TABLE app.st050_bad_school_fk ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_bad_school_fk FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_bad_school_fk FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);

CREATE TABLE app.st050_parent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id),
  UNIQUE (id, school_id)
);
CREATE INDEX idx_st050_parent_school_id ON app.st050_parent (school_id, id);
ALTER TABLE app.st050_parent ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_parent FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_parent FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);

CREATE TABLE app.st050_bad_child (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id),
  parent_id uuid NOT NULL REFERENCES app.st050_parent(id)
);
CREATE INDEX idx_st050_bad_child_school_parent ON app.st050_bad_child (school_id, parent_id);
ALTER TABLE app.st050_bad_child ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_bad_child FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_bad_child FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);

CREATE TABLE app.st050_redundant_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id)
);
CREATE INDEX idx_st050_redundant_index_school_only ON app.st050_redundant_index (school_id);
CREATE INDEX idx_st050_redundant_index_school_id ON app.st050_redundant_index (school_id, id);
ALTER TABLE app.st050_redundant_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_redundant_index FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_redundant_index FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);

CREATE TABLE app.st050_unclassified_global (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE app.st050_bad_flexible (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES app.schools(id),
  related_ids uuid[] NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_st050_bad_flexible_school_id ON app.st050_bad_flexible (school_id, id);
ALTER TABLE app.st050_bad_flexible ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.st050_bad_flexible FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.st050_bad_flexible FOR ALL TO PUBLIC
  USING (school_id = current_setting('app.school_id')::uuid)
  WITH CHECK (school_id = current_setting('app.school_id')::uuid);
`;

integrationTest(
  "fully migrated catalog passes every coverage rule under the performance budget",
  async () => {
    const database = await migratedDatabase();
    try {
      const samples: number[] = [];
      let report = await auditRlsCoverage(catalogClient(database.sql));
      expect(report.violations, formatRlsCoverageReport(report)).toEqual([]);

      for (let iteration = 0; iteration < 20; iteration += 1) {
        report = await auditRlsCoverage(catalogClient(database.sql));
        expect(report.compliant, formatRlsCoverageReport(report)).toBe(true);
        samples.push(report.elapsedMs);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
      expect(p95).toBeLessThan(100);
      expect(report.tenantRelations).toBeGreaterThan(70);
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "seeded dirty relations produce precise RLS, policy, index, key, scope, and atomicity failures",
  async () => {
    const database = await migratedDatabase();
    try {
      await database.sql.begin(async (transaction) => {
        await transaction.unsafe(SEEDED_VIOLATIONS);
        const report = await auditRlsCoverage(catalogClient(transaction), 5_000);

        expect(hasViolation(report, "RLS_ENABLED", "st050_bad_rls")).toBe(true);
        expect(hasViolation(report, "RLS_FORCED", "st050_bad_rls")).toBe(true);
        expect(hasViolation(report, "TENANT_POLICY", "st050_bad_policy")).toBe(true);
        expect(hasViolation(report, "SCHOOL_LEADING_INDEX", "st050_bad_index")).toBe(true);
        expect(hasViolation(report, "SCHOOL_ID_SHAPE", "st050_bad_school_fk")).toBe(true);
        expect(hasViolation(report, "SCHOOL_FOREIGN_KEY", "st050_bad_school_fk")).toBe(true);
        expect(hasViolation(report, "TENANT_COMPOSITE_FOREIGN_KEY", "st050_bad_child")).toBe(true);
        expect(hasViolation(report, "REDUNDANT_SCHOOL_INDEX", "st050_redundant_index")).toBe(true);
        expect(hasViolation(report, "UNCLASSIFIED_TABLE", "st050_unclassified_global")).toBe(true);
        expect(hasViolation(report, "UNAPPROVED_FLEXIBLE_COLUMN", "st050_bad_flexible")).toBe(true);

        const missingIndex = report.violations.find(
          (violation) =>
            violation.ruleCode === "SCHOOL_LEADING_INDEX" &&
            violation.tableName === "st050_bad_index",
        );
        expect(missingIndex?.diagnosticSql).toContain("EXPLAIN");
        expect(missingIndex?.explainPlan).toContain("Seq Scan");
      });
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "partition leaves are audited independently from their protected parent",
  async () => {
    const database = await migratedDatabase();
    try {
      await database.sql.begin(async (transaction) => {
        await transaction.unsafe("ALTER TABLE app.audit_logs_y2026m07 NO FORCE ROW LEVEL SECURITY");
        const report = await auditRlsCoverage(catalogClient(transaction), 5_000);
        expect(hasViolation(report, "RLS_FORCED", "audit_logs_y2026m07")).toBe(true);
        expect(hasViolation(report, "RLS_FORCED", "audit_logs")).toBe(false);
      });
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);

integrationTest(
  "standalone CLI returns 0 for compliance, 1 for violations, and 2 for invalid usage",
  async () => {
    const database = await migratedDatabase();
    const runCli = async (args: string[]) => {
      const processHandle = Bun.spawn([process.execPath, "packages/db/src/cli.ts", ...args], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          DATABASE_URL: database.url,
          DATABASE_SSL_MODE: "disable",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };

    try {
      const passing = await runCli(["rls-coverage"]);
      expect(passing.exitCode).toBe(0);
      expect(passing.stdout).toContain("RLS policy coverage PASS");

      await database.sql`CREATE TABLE app.st050_cli_violation (id uuid PRIMARY KEY)`;
      const failing = await runCli(["rls-coverage"]);
      expect(failing.exitCode).toBe(1);
      expect(failing.stderr).toContain("UNCLASSIFIED_TABLE");

      const invalid = await runCli(["rls-coverage", "extra"]);
      expect(invalid.exitCode).toBe(2);
      expect(invalid.stderr).toContain("Usage: db-migrate rls-coverage");
    } finally {
      await database.cleanup();
    }
  },
  90_000,
);
