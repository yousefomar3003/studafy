import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

const integrationTest = test.skipIf(!integrationEnabled);
const migrations = resolve(import.meta.dir, "../../../db/migrations");

integrationTest(
  "installs the normalized published-grade read model with forced RLS and partial indexes",
  async () => {
    const database = await testDatabase();
    try {
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, migrations),
        log: () => undefined,
      });
      await runMigrationCommand("migrate", {
        env: runnerEnv(database.url, migrations),
        log: () => undefined,
      });
      await runMigrationCommand("validate", {
        env: runnerEnv(database.url, migrations),
        log: () => undefined,
      });

      const columns = await database.sql<
        { tableName: string; columnName: string; nullable: boolean; defaultValue: string | null }[]
      >`
        SELECT
          table_name AS "tableName",
          column_name AS "columnName",
          (is_nullable = 'YES') AS nullable,
          column_default AS "defaultValue"
        FROM information_schema.columns
        WHERE table_schema = 'app'
          AND (
            (table_name = 'courses' AND column_name = 'credit_hours')
            OR (table_name = 'grade_submissions' AND column_name = 'published_at')
            OR table_name = 'student_term_summaries'
          )
        ORDER BY table_name, ordinal_position
      `;
      expect(
        columns.some(
          (column) =>
            column.tableName === "courses" &&
            column.columnName === "credit_hours" &&
            !column.nullable &&
            column.defaultValue?.includes("1"),
        ),
      ).toBe(true);
      expect(
        columns.some(
          (column) =>
            column.tableName === "grade_submissions" &&
            column.columnName === "published_at" &&
            column.nullable,
        ),
      ).toBe(true);

      const [table] = await database.sql<
        {
          owner: string;
          rls: boolean;
          forced: boolean;
          appSelect: boolean;
          appWrite: boolean;
          publicAccess: boolean;
        }[]
      >`
        SELECT
          pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls,
          c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT') AS "appSelect",
          has_table_privilege('studafy_app', c.oid, 'INSERT,UPDATE,DELETE') AS "appWrite",
          has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS "publicAccess"
        FROM pg_class AS c
        WHERE c.oid = 'app.student_term_summaries'::regclass
      `;
      expect(table).toEqual({
        owner: "studafy_admin",
        rls: true,
        forced: true,
        appSelect: true,
        appWrite: false,
        publicAccess: false,
      });

      const indexes = await database.sql<{ name: string; definition: string }[]>`
        SELECT indexname AS name, indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = 'app'
          AND indexname = ANY (${[
            "idx_grade_submissions_published_lookup",
            "idx_grade_submissions_gradebook_published",
            "idx_student_term_summaries",
          ]})
        ORDER BY indexname
      `;
      expect(indexes).toHaveLength(3);
      expect(
        indexes
          .filter((index) => index.name.includes("grade_submissions"))
          .every(
            (index) =>
              index.definition.includes("WHERE") && index.definition.includes("'published'"),
          ),
      ).toBe(true);

      const policies = await database.sql<{ name: string; command: string; expression: string }[]>`
        SELECT
          polname AS name,
          polcmd AS command,
          COALESCE(pg_get_expr(polqual, polrelid), '') AS expression
        FROM pg_policy
        WHERE polrelid = 'app.student_term_summaries'::regclass
        ORDER BY polname
      `;
      expect(policies.map(({ name, command }) => ({ name, command }))).toEqual([
        { name: "role_scope_visibility", command: "r" },
        { name: "tenant_isolation", command: "*" },
      ]);
      const roleScope = policies.find((policy) => policy.name === "role_scope_visibility");
      expect(roleScope?.expression).toContain("is_related_to_student(student_id)");
      expect(roleScope?.expression).not.toContain("current_user_is_school_admin");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
