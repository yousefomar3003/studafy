import { resolve } from "node:path";

import { expect, test } from "bun:test";
import postgres from "postgres";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const GLOBAL_TABLES = [
  "countries",
  "currencies",
  "schools",
  "plans",
  "plan_prices",
  "platform_settings",
] as const;

type Database = Awaited<ReturnType<typeof testDatabase>>;
type Role = "studafy_admin" | "studafy_app";

async function migratedDatabase(): Promise<Database> {
  const database = await testDatabase();
  await runMigrationCommand("migrate", {
    env: runnerEnv(database.url, repositoryMigrations),
    log: () => undefined,
  });
  return database;
}

async function asRole<T>(
  database: Database,
  role: Role,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    result = await run(tx);
  });
  return result as T;
}

async function expectRoleDenied(
  database: Database,
  role: Role,
  statement: string,
  context?: string,
): Promise<void> {
  await asRole(database, role, async (tx) => {
    if (context !== undefined) await tx`SELECT set_config('app.school_id', ${context}, true)`;
    await tx.unsafe(`
      DO $expected_database_error$
      DECLARE
        statement_failed boolean := false;
      BEGIN
        BEGIN
          EXECUTE $tested_statement$${statement}$tested_statement$;
        EXCEPTION
          WHEN OTHERS THEN statement_failed := true;
        END;
        IF NOT statement_failed THEN
          RAISE EXCEPTION 'expected database statement unexpectedly succeeded';
        END IF;
      END
      $expected_database_error$
    `);
  });
}

async function expectTenantQueryContextError(tx: Pick<TransactionSql, "unsafe">): Promise<void> {
  await tx.unsafe(`
    DO $expected_context_error$
    DECLARE
      query_failed boolean := false;
    BEGIN
      BEGIN
        PERFORM id FROM app.test_tenant_records;
      EXCEPTION
        WHEN OTHERS THEN query_failed := true;
      END;
      IF NOT query_failed THEN
        RAISE EXCEPTION 'tenant query unexpectedly succeeded without transaction-local context';
      END IF;
    END
    $expected_context_error$
  `);
}

async function createSchools(database: Database): Promise<{ schoolA: string; schoolB: string }> {
  const [references] = await database.sql<{ country_id: string; currency_id: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country_id,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency_id
  `;
  if (!references) throw new Error("US and USD reference rows are required");

  return asRole(database, "studafy_admin", async (tx) => {
    const schools = await tx<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, country_id, default_currency_id)
      VALUES
        ('rls-school-a', 'RLS School A', ${references.country_id}, ${references.currency_id}),
        ('rls-school-b', 'RLS School B', ${references.country_id}, ${references.currency_id})
      RETURNING id, slug
    `;
    return {
      schoolA: schools.find((school) => school.slug === "rls-school-a")!.id,
      schoolB: schools.find((school) => school.slug === "rls-school-b")!.id,
    };
  });
}

async function createTenantFixture(
  database: Database,
  schoolA: string,
  schoolB: string,
): Promise<void> {
  await asRole(database, "studafy_admin", async (tx) => {
    await tx.unsafe(`
      CREATE TABLE app.test_tenant_records (
        id uuid DEFAULT gen_random_uuid() CONSTRAINT pk_test_tenant_records PRIMARY KEY,
        school_id uuid NOT NULL,
        record_key text NOT NULL,
        record_value text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_test_tenant_records_school
          FOREIGN KEY (school_id) REFERENCES app.schools (id)
          ON UPDATE RESTRICT ON DELETE RESTRICT,
        CONSTRAINT uq_test_tenant_records_school_record_key UNIQUE (school_id, record_key),
        CONSTRAINT ck_test_tenant_records_key CHECK (btrim(record_key) <> '')
      )
    `);
    await tx.unsafe(`
      CREATE POLICY fixture_restriction ON app.test_tenant_records
        AS RESTRICTIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
    `);
    await tx`
      INSERT INTO app.test_tenant_records (school_id, record_key, record_value)
      VALUES
        (${schoolA}, 'shared', 'School A value'),
        (${schoolB}, 'shared', 'School B value')
    `;
    await tx`
      INSERT INTO app.test_tenant_records (school_id, record_key, record_value)
      SELECT
        CASE WHEN number % 2 = 0 THEN ${schoolA}::uuid ELSE ${schoolB}::uuid END,
        'bulk-' || number,
        'representative value ' || number
      FROM generate_series(1, 400) AS series(number)
    `;
    await tx.unsafe(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON app.test_tenant_records TO studafy_app
    `);
    await tx`SELECT app.apply_tenant_isolation('app', 'test_tenant_records')`;
  });
}

integrationTest(
  "installs a protected, repeatable RLS helper and canonical policy",
  async () => {
    const database = await migratedDatabase();
    try {
      const [helper] = await database.sql<
        {
          owner: string;
          security_definer: boolean;
          configuration: string[];
          public_execute: boolean;
          app_execute: boolean;
          admin_execute: boolean;
        }[]
      >`
      SELECT
        pg_get_userbyid(p.proowner) AS owner,
        p.prosecdef AS security_definer,
        p.proconfig AS configuration,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute,
        has_function_privilege('studafy_app', p.oid, 'EXECUTE') AS app_execute,
        has_function_privilege('studafy_admin', p.oid, 'EXECUTE') AS admin_execute
      FROM pg_proc p
      WHERE p.oid = 'app.apply_tenant_isolation(name,name)'::regprocedure
    `;
      expect(helper).toEqual({
        owner: "studafy_admin",
        security_definer: false,
        configuration: ["search_path=pg_catalog"],
        public_execute: false,
        app_execute: false,
        admin_execute: true,
      });

      const { schoolA, schoolB } = await createSchools(database);
      await createTenantFixture(database, schoolA, schoolB);
      await asRole(
        database,
        "studafy_admin",
        (tx) => tx`SELECT app.apply_tenant_isolation('app', 'test_tenant_records')`,
      );

      const [table] = await database.sql<
        { owner: string; rls_enabled: boolean; rls_forced: boolean }[]
      >`
      SELECT
        pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      WHERE c.oid = 'app.test_tenant_records'::regclass
    `;
      expect(table).toEqual({ owner: "studafy_admin", rls_enabled: true, rls_forced: true });

      const policies = await database.sql<
        {
          name: string;
          permissive: boolean;
          command: string;
          roles: number[];
          using_expression: string;
          check_expression: string;
        }[]
      >`
      SELECT
        polname AS name,
        polpermissive AS permissive,
        polcmd AS command,
        polroles::integer[] AS roles,
        pg_get_expr(polqual, polrelid) AS using_expression,
        pg_get_expr(polwithcheck, polrelid) AS check_expression
      FROM pg_policy
      WHERE polrelid = 'app.test_tenant_records'::regclass
      ORDER BY polname
    `;
      expect(policies.map((policy) => policy.name)).toEqual([
        "fixture_restriction",
        "tenant_isolation",
      ]);
      const canonical = policies[1]!;
      expect(canonical.permissive).toBe(true);
      expect(canonical.command).toBe("*");
      expect(canonical.roles).toEqual([0]);
      expect(canonical.using_expression).toContain("current_setting('app.school_id'::text)");
      expect(canonical.check_expression).toContain("current_setting('app.school_id'::text)");
      expect(canonical.using_expression).toContain("school_id");
      expect(canonical.check_expression).toContain("school_id");

      await asRole(database, "studafy_app", (tx) =>
        tx.unsafe(`
        DO $permission_test$
        BEGIN
          BEGIN
            PERFORM app.apply_tenant_isolation('app', 'test_tenant_records');
            RAISE EXCEPTION 'studafy_app unexpectedly executed the RLS helper';
          EXCEPTION
            WHEN insufficient_privilege THEN NULL;
          END;
        END
        $permission_test$
      `),
      );
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "rejects incompatible tables, identifiers, and permissive policies",
  async () => {
    const database = await migratedDatabase();
    try {
      await asRole(database, "studafy_admin", async (tx) => {
        await tx.unsafe(`
        CREATE TABLE app.rls_no_school (id uuid PRIMARY KEY);
        CREATE TABLE app.rls_wrong_type (
          id uuid PRIMARY KEY,
          school_id text NOT NULL
        );
        CREATE TABLE app.rls_nullable (
          id uuid PRIMARY KEY,
          school_id uuid REFERENCES app.schools (id)
        );
        CREATE TABLE app.rls_no_fk (
          id uuid PRIMARY KEY,
          school_id uuid NOT NULL
        );
        CREATE VIEW app.rls_view AS SELECT id AS school_id FROM app.schools;
      `);
      });
      await database.sql.unsafe(`
      CREATE TABLE app.rls_wrong_owner (
        id uuid PRIMARY KEY,
        school_id uuid NOT NULL REFERENCES app.schools (id)
      )
    `);

      for (const table of ["rls_no_school", "rls_wrong_type", "rls_nullable", "rls_no_fk"]) {
        await expectRoleDenied(
          database,
          "studafy_admin",
          `SELECT app.apply_tenant_isolation('app', '${table}')`,
        );
      }
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', 'rls_wrong_owner')`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', 'rls_view')`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', 'missing_table')`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('public', 'anything')`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', 'x; DROP TABLE app.schools; --')`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', NULL)`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('rls_no_school')`,
      );

      for (const table of GLOBAL_TABLES) {
        await expectRoleDenied(
          database,
          "studafy_admin",
          `SELECT app.apply_tenant_isolation('app', '${table}')`,
        );
      }

      await asRole(database, "studafy_admin", async (tx) => {
        await tx.unsafe(`
        CREATE TABLE app.rls_conflict (
          id uuid PRIMARY KEY,
          school_id uuid NOT NULL REFERENCES app.schools (id)
        );
        CREATE POLICY broad_access ON app.rls_conflict FOR SELECT TO PUBLIC USING (true);
        CREATE TABLE app.rls_bad_canonical (
          id uuid PRIMARY KEY,
          school_id uuid NOT NULL REFERENCES app.schools (id)
        );
        CREATE POLICY tenant_isolation ON app.rls_bad_canonical
          FOR SELECT TO PUBLIC USING (true);
      `);
      });
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', 'rls_conflict')`,
      );
      await expectRoleDenied(
        database,
        "studafy_admin",
        `SELECT app.apply_tenant_isolation('app', 'rls_bad_canonical')`,
      );

      const [preserved] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM pg_policy
      WHERE (polrelid = 'app.rls_conflict'::regclass AND polname = 'broad_access')
         OR (polrelid = 'app.rls_bad_canonical'::regclass AND polname = 'tenant_isolation')
    `;
      expect(preserved?.count).toBe("2");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates every tenant read and write path",
  async () => {
    const database = await migratedDatabase();
    try {
      const { schoolA, schoolB } = await createSchools(database);
      await createTenantFixture(database, schoolA, schoolB);

      for (const statement of [
        "SELECT * FROM app.test_tenant_records",
        `INSERT INTO app.test_tenant_records (school_id, record_key, record_value)
       VALUES (gen_random_uuid(), 'missing', 'missing')`,
        "UPDATE app.test_tenant_records SET record_value = 'missing'",
        "DELETE FROM app.test_tenant_records",
      ]) {
        await expectRoleDenied(database, "studafy_app", statement);
      }

      for (const context of ["", " ", "not-a-uuid", "00000000-0000-0000-0000-invaliduuid"]) {
        await expectRoleDenied(
          database,
          "studafy_app",
          "SELECT * FROM app.test_tenant_records",
          context,
        );
      }

      const rowsA = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ school_id: string; record_value: string }[]>`
        SELECT school_id, record_value
        FROM app.test_tenant_records
        WHERE record_key = 'shared'
      `;
      });
      expect(Array.from(rowsA)).toEqual([{ school_id: schoolA, record_value: "School A value" }]);

      const rowsB = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
        return tx<{ school_id: string; record_value: string }[]>`
        SELECT school_id, record_value
        FROM app.test_tenant_records
        WHERE record_key = 'shared'
      `;
      });
      expect(Array.from(rowsB)).toEqual([{ school_id: schoolB, record_value: "School B value" }]);

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`
        INSERT INTO app.test_tenant_records (school_id, record_key, record_value)
        VALUES (${schoolA}, 'allowed-insert', 'allowed')
      `;
        const update = await tx`
        UPDATE app.test_tenant_records SET record_value = 'updated'
        WHERE school_id = ${schoolA} AND record_key = 'allowed-insert'
      `;
        expect(update.count).toBe(1);
        const hiddenUpdate = await tx`
        UPDATE app.test_tenant_records SET record_value = 'forbidden'
        WHERE school_id = ${schoolB} AND record_key = 'shared'
      `;
        expect(hiddenUpdate.count).toBe(0);
        const hiddenDelete = await tx`
        DELETE FROM app.test_tenant_records
        WHERE school_id = ${schoolB} AND record_key = 'shared'
      `;
        expect(hiddenDelete.count).toBe(0);
        const ownDelete = await tx`
        DELETE FROM app.test_tenant_records
        WHERE school_id = ${schoolA} AND record_key = 'allowed-insert'
      `;
        expect(ownDelete.count).toBe(1);
      });

      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.test_tenant_records (school_id, record_key, record_value)
       VALUES ('${schoolB}', 'cross-insert', 'forbidden')`,
        schoolA,
      );
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.test_tenant_records (record_key, record_value)
       VALUES ('no-school', 'forbidden')`,
        schoolA,
      );
      await expectRoleDenied(
        database,
        "studafy_app",
        `UPDATE app.test_tenant_records SET school_id = '${schoolB}'
       WHERE school_id = '${schoolA}' AND record_key = 'shared'`,
        schoolA,
      );

      const nonexistent = crypto.randomUUID();
      const noRows = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${nonexistent}, true)`;
        return tx`SELECT id FROM app.test_tenant_records`;
      });
      expect(noRows).toHaveLength(0);
      await expectRoleDenied(
        database,
        "studafy_app",
        `INSERT INTO app.test_tenant_records (school_id, record_key, record_value)
       VALUES ('${nonexistent}', 'nonexistent', 'forbidden')`,
        nonexistent,
      );

      const ownerRows = await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        return tx<{ school_id: string }[]>`
        SELECT DISTINCT school_id FROM app.test_tenant_records
      `;
      });
      expect(Array.from(ownerRows)).toEqual([{ school_id: schoolA }]);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "clears local context and protects ownership, globals, and indexes",
  async () => {
    const database = await migratedDatabase();
    let pooled: ReturnType<typeof postgres> | undefined;
    try {
      const { schoolA, schoolB } = await createSchools(database);
      await createTenantFixture(database, schoolA, schoolB);

      pooled = postgres(database.url, { max: 1, ssl: false, prepare: false });
      await pooled.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_app");
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        const rows = await tx`SELECT id FROM app.test_tenant_records WHERE record_key = 'shared'`;
        expect(rows).toHaveLength(1);
      });
      await pooled.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_app");
        await expectTenantQueryContextError(tx);
      });

      await pooled.unsafe("BEGIN");
      try {
        await pooled.unsafe("SET LOCAL ROLE studafy_app");
        await pooled`SELECT set_config('app.school_id', ${schoolB}, true)`;
        const rows = await pooled`
        SELECT id FROM app.test_tenant_records WHERE record_key = 'shared'
      `;
        expect(rows).toHaveLength(1);
      } finally {
        await pooled.unsafe("ROLLBACK");
      }
      await pooled.unsafe("BEGIN");
      try {
        await pooled.unsafe("SET LOCAL ROLE studafy_app");
        await expectTenantQueryContextError(pooled);
      } finally {
        await pooled.unsafe("ROLLBACK");
      }

      const [role] = await database.sql<{ bypass: boolean; owns_fixture: boolean }[]>`
      SELECT
        rolbypassrls AS bypass,
        EXISTS (
          SELECT 1 FROM pg_class
          WHERE oid = 'app.test_tenant_records'::regclass AND relowner = r.oid
        ) AS owns_fixture
      FROM pg_roles r
      WHERE rolname = 'studafy_app'
    `;
      expect(role).toEqual({ bypass: false, owns_fixture: false });

      for (const ddl of [
        "ALTER TABLE app.test_tenant_records DISABLE ROW LEVEL SECURITY",
        "ALTER TABLE app.test_tenant_records NO FORCE ROW LEVEL SECURITY",
        "DROP POLICY tenant_isolation ON app.test_tenant_records",
        "CREATE INDEX forbidden_runtime_index ON app.test_tenant_records (record_value)",
        "DROP INDEX app.uq_test_tenant_records_school_record_key",
      ]) {
        await expectRoleDenied(database, "studafy_app", ddl, schoolA);
      }

      const globals = await database.sql<
        { name: string; rls_enabled: boolean; rls_forced: boolean; school_columns: string }[]
      >`
      SELECT
        c.relname AS name,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        count(a.attname) FILTER (WHERE a.attname = 'school_id')::text AS school_columns
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'app' AND c.relname = ANY(${GLOBAL_TABLES as unknown as string[]})
      GROUP BY c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
      ORDER BY c.relname
    `;
      expect(globals).toHaveLength(6);
      expect(
        globals.every(
          (table) => !table.rls_enabled && !table.rls_forced && table.school_columns === "0",
        ),
      ).toBe(true);

      const [globalSecurity] = await database.sql<{ policies: string; tenant_indexes: string }[]>`
      SELECT
        (SELECT count(*)::text FROM pg_policy
         WHERE polrelid IN (
           SELECT c.oid
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'app'
             AND c.relname = ANY(${GLOBAL_TABLES as unknown as string[]})
         )) AS policies,
        (SELECT count(*)::text
         FROM pg_index i
         JOIN pg_class t ON t.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_class x ON x.oid = i.indexrelid
         WHERE n.nspname = 'app'
           AND t.relname = ANY(${GLOBAL_TABLES as unknown as string[]})
           AND x.relname LIKE '%school_id%') AS tenant_indexes
    `;
      expect(globalSecurity).toEqual({ policies: "0", tenant_indexes: "0" });

      const plan = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        return tx.unsafe(`
        EXPLAIN (FORMAT JSON)
        SELECT record_value
        FROM app.test_tenant_records
        WHERE school_id = '${schoolA}' AND record_key = 'shared'
      `);
      });
      expect(JSON.stringify(plan)).toContain("uq_test_tenant_records_school_record_key");

      const [duplicateIndexes] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM (
        SELECT indrelid, indkey::text, indexprs::text, indpred::text
        FROM pg_index
        WHERE indrelid = 'app.test_tenant_records'::regclass
        GROUP BY indrelid, indkey::text, indexprs::text, indpred::text
        HAVING count(*) > 1
      ) duplicates
    `;
      expect(duplicateIndexes?.count).toBe("0");
    } finally {
      await pooled?.end({ timeout: 1 });
      await database.cleanup();
    }
  },
  30_000,
);
