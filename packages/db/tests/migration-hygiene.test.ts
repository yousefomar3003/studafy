/**
 * QA-074: migration hygiene.
 *
 * - app.register_school is SECURITY DEFINER with `search_path = app`. An unqualified name added to
 *   it later would resolve through a schema a caller might reach (and 000202 grants TEMPORARY to
 *   PUBLIC on Supabase, which puts pg_temp in play). It now pins `pg_catalog, pg_temp`.
 * - Production applied 000003 without its pg_stat_statements grants (Supabase installs the view in
 *   `extensions`), so PUBLIC can still read every statement's text there. A forward migration
 *   re-applies the revoke wherever the view lives.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/migration-hygiene.test.ts
 */

import { resolve } from "node:path";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

let database: Awaited<ReturnType<typeof testDatabase>> | undefined;

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

integrationTest("register_school pins a search path no caller can reach", async () => {
  const [row] = await database!.sql<{ config: string[] }[]>`
    SELECT proconfig AS config FROM pg_proc WHERE oid = 'app.register_school'::regproc
  `;
  expect(row!.config).toEqual(["search_path=pg_catalog, pg_temp"]);
});

integrationTest("register_school still registers a school", async () => {
  const slug = `hygiene-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await database!.sql<{ id: string }[]>`
    SELECT app.register_school(
      ${slug}, 'Hygiene School', ${`${slug}@test.local`}, ${`${slug}@test.local`},
      (SELECT id FROM app.countries LIMIT 1), (SELECT id FROM app.currencies LIMIT 1)
    ) AS id
  `;
  expect(row!.id).toMatch(/^[0-9a-f-]{36}$/u);
});

integrationTest("PUBLIC cannot read pg_stat_statements wherever it is installed", async () => {
  const rows = await database!.sql<{ view: string; public_select: boolean }[]>`
    SELECT format('%I.pg_stat_statements', n.nspname) AS view,
           has_table_privilege('public', format('%I.pg_stat_statements', n.nspname), 'SELECT')
             AS public_select
    FROM pg_extension AS e JOIN pg_namespace AS n ON n.oid = e.extnamespace
    WHERE e.extname = 'pg_stat_statements'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]!.public_select).toBe(false);
});
