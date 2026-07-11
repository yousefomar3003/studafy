import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type postgres from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");

type Database = Awaited<ReturnType<typeof testDatabase>>;

// Applies the committed migrations (including 000002) to a fresh disposable database.
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
  role: "studafy_app" | "studafy_admin",
  run: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await run(tx);
  });
}

// Asserts a single statement is rejected for the given role (each in its own aborted transaction).
async function expectDenied(
  database: Database,
  role: "studafy_app" | "studafy_admin",
  statement: string,
): Promise<void> {
  await expect(
    asRole(database, role, (tx) => tx.unsafe(statement).then(() => undefined)),
  ).rejects.toThrow();
}

integrationTest("both roles have the least-privilege attribute baseline", async () => {
  const database = await migratedDatabase();
  try {
    const rows = await database.sql<
      {
        rolname: string;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
      }[]
    >`
      SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
      FROM pg_roles
      WHERE rolname IN ('studafy_app', 'studafy_admin')
      ORDER BY rolname
    `;
    expect(rows.map((row) => row.rolname)).toEqual(["studafy_admin", "studafy_app"]);
    for (const row of rows) {
      expect(row.rolsuper).toBe(false);
      expect(row.rolcreatedb).toBe(false);
      expect(row.rolcreaterole).toBe(false);
      expect(row.rolreplication).toBe(false);
      expect(row.rolbypassrls).toBe(false);
      expect(row.rolcanlogin).toBe(false);
    }
  } finally {
    await database.cleanup();
  }
});

integrationTest("studafy_admin owns the app schema and studafy_app owns nothing", async () => {
  const database = await migratedDatabase();
  try {
    const [schema] = await database.sql<{ owner: string }[]>`
      SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'app'
    `;
    expect(schema?.owner).toBe("studafy_admin");

    const [owned] = await database.sql<{ total: number }[]>`
      SELECT (
        (SELECT count(*) FROM pg_class WHERE relowner = 'studafy_app'::regrole)
        + (SELECT count(*) FROM pg_namespace WHERE nspowner = 'studafy_app'::regrole)
        + (SELECT count(*) FROM pg_proc WHERE proowner = 'studafy_app'::regrole)
      )::int AS total
    `;
    expect(owned?.total).toBe(0);

    const [metadata] = await database.sql<{ owner: string }[]>`
      SELECT pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE oid = 'public.schema_migrations'::regclass
    `;
    expect(metadata?.owner).not.toBe("studafy_app");
  } finally {
    await database.cleanup();
  }
});

integrationTest(
  "studafy_app performs CRUD on admin-owned tables via default privileges",
  async () => {
    const database = await migratedDatabase();
    try {
      // The normalized fixture is created by studafy_admin so the default privileges apply to it.
      await asRole(database, "studafy_admin", async (tx) => {
        await tx.unsafe(`
          CREATE TABLE app.role_test_parent (
            id integer GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_role_test_parent PRIMARY KEY,
            code text NOT NULL CONSTRAINT uq_role_test_parent_code UNIQUE
          )
        `);
        await tx.unsafe(`
          CREATE TABLE app.role_test_child (
            id integer GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_role_test_child PRIMARY KEY,
            parent_id integer NOT NULL
              CONSTRAINT fk_role_test_child_parent REFERENCES app.role_test_parent (id) ON DELETE CASCADE,
            label text NOT NULL
          )
        `);
      });

      const [grants] = await database.sql<
        { can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }[]
      >`
        SELECT
          has_table_privilege('studafy_app', 'app.role_test_parent', 'SELECT') AS can_select,
          has_table_privilege('studafy_app', 'app.role_test_parent', 'INSERT') AS can_insert,
          has_table_privilege('studafy_app', 'app.role_test_parent', 'UPDATE') AS can_update,
          has_table_privilege('studafy_app', 'app.role_test_parent', 'DELETE') AS can_delete
      `;
      expect(grants).toEqual({
        can_select: true,
        can_insert: true,
        can_update: true,
        can_delete: true,
      });

      // The runtime role exercises every CRUD verb, proving the table and sequence grants applied.
      await asRole(database, "studafy_app", async (tx) => {
        await tx.unsafe(`INSERT INTO app.role_test_parent (code) VALUES ('alpha')`);
        const inserted = await tx.unsafe<{ id: number; code: string }[]>(
          `SELECT id, code FROM app.role_test_parent WHERE code = 'alpha'`,
        );
        expect(inserted).toHaveLength(1);
        const parentId = inserted[0]!.id;
        await tx.unsafe(
          `INSERT INTO app.role_test_child (parent_id, label) VALUES (${parentId}, 'child')`,
        );
        await tx.unsafe(`UPDATE app.role_test_parent SET code = 'beta' WHERE id = ${parentId}`);
        await tx.unsafe(`DELETE FROM app.role_test_child WHERE parent_id = ${parentId}`);
        await tx.unsafe(`DELETE FROM app.role_test_parent WHERE id = ${parentId}`);
      });
    } finally {
      await database.cleanup();
    }
  },
);

integrationTest("studafy_app is denied every DDL and privilege-management operation", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_admin", (tx) =>
      tx
        .unsafe(`CREATE TABLE app.ddl_probe (id integer CONSTRAINT pk_ddl_probe PRIMARY KEY)`)
        .then(() => undefined),
    );

    await expectDenied(database, "studafy_app", `CREATE TABLE app.forbidden (id integer)`);
    await expectDenied(
      database,
      "studafy_app",
      `ALTER TABLE app.ddl_probe ADD COLUMN extra integer`,
    );
    await expectDenied(database, "studafy_app", `DROP TABLE app.ddl_probe`);
    await expectDenied(database, "studafy_app", `TRUNCATE app.ddl_probe`);
    await expectDenied(
      database,
      "studafy_app",
      `CREATE INDEX idx_ddl_probe_id ON app.ddl_probe (id)`,
    );
    await expectDenied(database, "studafy_app", `ALTER TABLE app.ddl_probe OWNER TO studafy_app`);
    await expectDenied(database, "studafy_app", `GRANT SELECT ON app.ddl_probe TO studafy_admin`);
    // Migration history is off-limits to the runtime role.
    await expectDenied(
      database,
      "studafy_app",
      `INSERT INTO public.schema_migrations (version, name, checksum, execution_duration_ms, tool_version)
       VALUES (999999, 'x', 'sha256:0000000000000000000000000000000000000000000000000000000000000000', 0, 'x')`,
    );
  } finally {
    await database.cleanup();
  }
});

integrationTest("studafy_app cannot bypass or weaken Row-Level Security", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_admin", async (tx) => {
      await tx.unsafe(`
        CREATE TABLE app.rls_probe (
          id integer GENERATED ALWAYS AS IDENTITY CONSTRAINT pk_rls_probe PRIMARY KEY,
          owner_role text NOT NULL
        )
      `);
      await tx.unsafe(`ALTER TABLE app.rls_probe ENABLE ROW LEVEL SECURITY`);
      await tx.unsafe(`ALTER TABLE app.rls_probe FORCE ROW LEVEL SECURITY`);
      await tx.unsafe(
        `CREATE POLICY rls_probe_self ON app.rls_probe FOR ALL USING (owner_role = current_user)`,
      );
    });
    // Seeded by the superuser connection, which bypasses RLS, so both rows exist regardless of policy.
    await database.sql.unsafe(
      `INSERT INTO app.rls_probe (owner_role) VALUES ('studafy_app'), ('someone_else')`,
    );

    await asRole(database, "studafy_app", async (tx) => {
      const visible = await tx.unsafe<{ owner_role: string }[]>(
        `SELECT owner_role FROM app.rls_probe`,
      );
      expect(visible.map((row) => row.owner_role)).toEqual(["studafy_app"]);
    });

    await expectDenied(
      database,
      "studafy_app",
      `ALTER TABLE app.rls_probe DISABLE ROW LEVEL SECURITY`,
    );
    await expectDenied(
      database,
      "studafy_app",
      `CREATE POLICY rls_probe_open ON app.rls_probe FOR ALL USING (true)`,
    );
    await expectDenied(
      database,
      "studafy_app",
      `ALTER POLICY rls_probe_self ON app.rls_probe USING (true)`,
    );
  } finally {
    await database.cleanup();
  }
});

integrationTest("studafy_admin can perform the operations migrations require", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_admin", async (tx) => {
      await tx.unsafe(
        `CREATE TABLE app.admin_probe (id integer CONSTRAINT pk_admin_probe PRIMARY KEY)`,
      );
      await tx.unsafe(`ALTER TABLE app.admin_probe ADD COLUMN label text`);
      await tx.unsafe(`CREATE INDEX idx_admin_probe_label ON app.admin_probe (label)`);
      await tx.unsafe(`GRANT SELECT ON app.admin_probe TO studafy_app`);
      await tx.unsafe(`DROP TABLE app.admin_probe`);
    });
  } finally {
    await database.cleanup();
  }
});

integrationTest("PUBLIC retains no privileges on the application or public schema", async () => {
  const database = await migratedDatabase();
  try {
    await asRole(database, "studafy_admin", (tx) =>
      tx
        .unsafe(
          `CREATE FUNCTION app.public_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1'`,
        )
        .then(() => undefined),
    );

    const [privileges] = await database.sql<
      {
        app_create: boolean;
        app_usage: boolean;
        public_create: boolean;
        fn_public_execute: boolean;
        fn_app_execute: boolean;
      }[]
    >`
      SELECT
        has_schema_privilege('public', 'app', 'CREATE') AS app_create,
        has_schema_privilege('public', 'app', 'USAGE') AS app_usage,
        has_schema_privilege('public', 'public', 'CREATE') AS public_create,
        has_function_privilege('public', 'app.public_probe()', 'EXECUTE') AS fn_public_execute,
        has_function_privilege('studafy_app', 'app.public_probe()', 'EXECUTE') AS fn_app_execute
    `;
    expect(privileges).toEqual({
      app_create: false,
      app_usage: false,
      public_create: false,
      fn_public_execute: false,
      fn_app_execute: false,
    });
  } finally {
    await database.cleanup();
  }
});
