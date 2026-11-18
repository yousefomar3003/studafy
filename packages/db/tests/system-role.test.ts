/**
 * QA-015: system transactions run as a role that owns nothing.
 *
 * `withSystemTx` and the workers' `withSystemTenantTx` used `SET LOCAL ROLE studafy_admin`, the
 * owner of every table. FORCE RLS does not stop an owner turning RLS off, dropping a policy, or
 * running `TRUNCATE app.audit_logs` (TRUNCATE ignores RLS and the row-level append-only trigger), so
 * any SQL reached inside a system transaction could disable isolation and wipe the evidence.
 * System transactions now use `studafy_system`: DML grants and the same policies the owner had,
 * and no ownership. `studafy_admin` is kept for migrations and partition maintenance, and even it
 * can no longer TRUNCATE the audit log.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/system-role.test.ts
 */

import { resolve } from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type postgres from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

type Database = Awaited<ReturnType<typeof testDatabase>>;

let database: Database | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
}, 120_000);

afterAll(async () => {
  await database?.cleanup();
});

/** The error a statement raises in its own transaction as `role`, or null when it succeeds. */
async function failureAs(role: string, statement: string): Promise<string | null> {
  // try/catch rather than `rejects`: see the note in roles.test.ts (oven-sh/bun#31462).
  try {
    await database!.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx.unsafe(statement);
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function asSystem<T>(run: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_system");
    return run(tx);
  })) as T;
}

integrationTest("studafy_system has the least-privilege baseline and owns nothing", async () => {
  const [role] = await database!.sql<
    { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; rolcreaterole: boolean }[]
  >`SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole FROM pg_roles
    WHERE rolname = 'studafy_system'`;
  expect(role).toEqual({
    rolsuper: false,
    rolbypassrls: false,
    rolcanlogin: false,
    rolcreaterole: false,
  });

  const owned = await database!.sql<{ owner: string; n: number }[]>`
    SELECT r.rolname AS owner, count(*)::int AS n
    FROM pg_class AS c
    JOIN pg_roles AS r ON r.oid = c.relowner
    WHERE r.rolname IN ('studafy_app', 'studafy_system')
    GROUP BY r.rolname
    UNION ALL
    SELECT r.rolname, count(*)::int
    FROM pg_namespace AS n JOIN pg_roles AS r ON r.oid = n.nspowner
    WHERE r.rolname IN ('studafy_app', 'studafy_system')
    GROUP BY r.rolname
  `;
  expect([...owned]).toEqual([]);
});

integrationTest(
  "a system transaction cannot switch RLS off, drop a policy or truncate",
  async () => {
    for (const statement of [
      "TRUNCATE app.audit_logs",
      "ALTER TABLE app.students DISABLE ROW LEVEL SECURITY",
      "ALTER TABLE app.students NO FORCE ROW LEVEL SECURITY",
      "DROP POLICY tenant_isolation ON app.students",
      "ALTER TABLE app.audit_logs DETACH PARTITION app.audit_logs_y2026m07",
      "CREATE TABLE app.planted (id int)",
    ]) {
      expect({ statement, error: await failureAs("studafy_system", statement) }).toEqual({
        statement,
        error: expect.stringMatching(/must be owner|permission denied/),
      });
    }
  },
);

integrationTest(
  "even the owner cannot truncate the audit log or one of its partitions",
  async () => {
    expect(await failureAs("studafy_admin", "TRUNCATE app.audit_logs")).toMatch(/append-only/);
    expect(await failureAs("studafy_admin", "TRUNCATE app.audit_logs_y2026m07")).toMatch(
      /append-only/,
    );
    // A partition created later by the maintenance function carries the same guard.
    await database!.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT app.create_audit_log_partitions(DATE '2031-05-01')`;
    });
    expect(await failureAs("studafy_admin", "TRUNCATE app.audit_logs_y2031m05")).toMatch(
      /append-only/,
    );
    const [grants] = await database!.sql<{ write: boolean; append: boolean }[]>`
    SELECT has_table_privilege('studafy_system', 'app.audit_logs_y2031m05', 'UPDATE, DELETE, TRUNCATE')
             AS write,
           has_table_privilege('studafy_system', 'app.audit_logs_y2031m05', 'SELECT')
             AND has_table_privilege('studafy_system', 'app.audit_logs_y2031m05', 'INSERT') AS append
  `;
    expect(grants).toEqual({ write: false, append: true });
  },
);

integrationTest("a system transaction still reaches what the owner reached", async () => {
  const [refs] = await database!.sql<{ country: string; currency: string }[]>`
    SELECT (SELECT id FROM app.countries LIMIT 1) AS country,
           (SELECT id FROM app.currencies LIMIT 1) AS currency
  `;
  await database!.sql`
    INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
    VALUES ('qa015', 'QA 015', 'qa015@admin.local', 'qa015@admin.local',
            ${refs!.country}, ${refs!.currency})
  `;
  // app.schools is readable without a school armed only through the policy that names the owner.
  const [schools] = await asSystem(
    (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM app.schools WHERE slug = 'qa015'`,
  );
  expect(schools!.n).toBe(1);

  // Every policy that names studafy_admin names studafy_system too, so a later migration adding an
  // owner-only policy cannot leave system transactions blind.
  const missing = await database!.sql<{ policy: string }[]>`
    SELECT tablename || '.' || policyname AS policy FROM pg_policies
    WHERE schemaname = 'app' AND 'studafy_admin' = ANY(roles) AND NOT 'studafy_system' = ANY(roles)
  `;
  expect([...missing]).toEqual([]);

  // And every table the owner can write, the system role can write (audit and the ledgers aside).
  const unwritable = await database!.sql<{ relname: string }[]>`
    SELECT c.relname FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND c.relname <> 'audit_logs'
      AND NOT has_table_privilege('studafy_system', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
  `;
  expect([...unwritable]).toEqual([]);
});

integrationTest(
  "the Student AI programme (000234-000239, older than this role in production) is reachable",
  async () => {
    // Production applied the Student AI migrations before 000246 created studafy_system, so the
    // role's grants on them come from 000246's catch-up grants, not from default privileges.
    const tables = [
      "ai_programme_versions",
      "ai_programme_version_prices",
      "ai_programme_version_tiers",
      "ai_programme_school_overrides",
      "ai_programme_school_override_tiers",
      "ai_optin_windows",
      "ai_optin_window_scopes",
      "ai_optins",
      "ai_optin_window_notices",
      "ai_programme_conversion_snapshots",
      "ai_programme_revenue_share_entries",
      "ai_programme_revenue_share_payouts",
      "student_ai_billing_settings",
      "student_ai_fee_items",
      "student_ai_fee_portions",
    ];
    const [privileges] = await database!.sql<{ missing: string[] }[]>`
      SELECT coalesce(array_agg(t ORDER BY t), '{}') AS missing
      FROM unnest(${tables}::text[]) AS t
      WHERE NOT has_table_privilege('studafy_system', ('app.' || t)::regclass,
                                    'SELECT, INSERT, UPDATE, DELETE')
    `;
    expect(privileges!.missing).toEqual([]);

    const [settle] = await database!.sql<{ allowed: boolean }[]>`
      SELECT has_function_privilege('studafy_system', 'app.settle_ai_revenue_share(date)', 'EXECUTE')
        AS allowed
    `;
    expect(settle!.allowed).toBe(true);
  },
);
