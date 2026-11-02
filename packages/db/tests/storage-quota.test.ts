import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const TENANT_TABLES = ["storage_usage_meters"] as const;

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

async function expectDenied(
  database: Database,
  statement: string,
  context?: string,
  role: Role = "studafy_app",
): Promise<void> {
  await asRole(database, role, async (tx) => {
    if (context !== undefined) await tx`SELECT set_config('app.school_id', ${context}, true)`;
    await tx.unsafe(`
      DO $expected_error$
      DECLARE failed boolean := false;
      BEGIN
        BEGIN EXECUTE $statement$${statement}$statement$;
        EXCEPTION WHEN OTHERS THEN failed := true;
        END;
        IF NOT failed THEN RAISE EXCEPTION 'expected statement to fail'; END IF;
      END
      $expected_error$
    `);
  });
}

async function createSchool(database: Database, slug: string): Promise<string> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  return asRole(database, "studafy_admin", async (tx) => {
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${slug}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`}, ${refs!.country}, ${refs!.currency})
      RETURNING id
    `;
    return school!.id;
  });
}

// ---------------------------------------------------------------------------------------------------
// Schema, grants, and RLS
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "installs the exact storage-quota schema, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const tenantTables = await database.sql<
        { name: string; owner: string; rls: boolean; forced: boolean; app_crud: boolean }[]
      >`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS app_crud
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TENANT_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tenantTables.map((row) => row.name)).toEqual([...TENANT_TABLES].sort());
      expect(
        tenantTables.every(
          (row) => row.owner === "studafy_admin" && row.rls && row.forced && row.app_crud,
        ),
      ).toBe(true);

      const tenantPolicies = await database.sql<{ table_name: string; name: string }[]>`
        SELECT c.relname AS table_name, p.polname AS name
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${TENANT_TABLES as unknown as string[]})
      `;
      expect(tenantPolicies).toHaveLength(TENANT_TABLES.length);
      expect(tenantPolicies.every((policy) => policy.name === "tenant_isolation")).toBe(true);

      const functions = await database.sql<{ name: string }[]>`
        SELECT p.proname AS name
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app'
          AND p.proname IN ('add_storage_usage', 'set_storage_usage')
        ORDER BY p.proname
      `;
      expect(functions.map((f) => f.name)).toEqual(["add_storage_usage", "set_storage_usage"]);

      const [capDefault] = await database.sql<{ default: string }[]>`
        SELECT column_default AS "default" FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'subscriptions'
          AND column_name = 'storage_cap_bytes'
      `;
      expect(capDefault!.default).toBe("'10737418240'::bigint");
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// RLS enforcement
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "enforces tenant isolation on the storage usage meter",
  async () => {
    const database = await migratedDatabase();
    try {
      const schoolA = await createSchool(database, "storage-school-a");
      const schoolB = await createSchool(database, "storage-school-b");

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolA}, true)`;
        await tx`SELECT app.add_storage_usage(100)`;
      });

      // schoolB cannot see schoolA's meter.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${schoolB}, true)`;
        const rows = await tx<{ count: string }[]>`
          SELECT count(*)::text AS count FROM app.storage_usage_meters
        `;
        expect(rows[0]!.count).toBe("0");
      });

      // Missing school_id context is rejected (RLS policy requires app.school_id).
      await expectDenied(database, `SELECT * FROM app.storage_usage_meters`);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// Atomic meter functions
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "add_storage_usage is atomic and floors at zero; set_storage_usage replaces outright",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "storage-meter-school");

      const readMeter = () =>
        asRole(database, "studafy_app", async (tx) => {
          await tx`SELECT set_config('app.school_id', ${school}, true)`;
          const [row] = await tx<{ bytes_used: string }[]>`
            SELECT bytes_used::text AS bytes_used FROM app.storage_usage_meters
          `;
          return Number(row!.bytes_used);
        });

      // First add inserts a new row.
      const first = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ add_storage_usage: string }[]>`
          SELECT app.add_storage_usage(2048)
        `;
        return Number(row!.add_storage_usage);
      });
      expect(first).toBe(2048);

      // Second add accumulates under the same row.
      const second = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ add_storage_usage: string }[]>`
          SELECT app.add_storage_usage(512)
        `;
        return Number(row!.add_storage_usage);
      });
      expect(second).toBe(2560);

      // A release past zero floors at zero rather than going negative.
      const floored = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ add_storage_usage: string }[]>`
          SELECT app.add_storage_usage(-999999)
        `;
        return Number(row!.add_storage_usage);
      });
      expect(floored).toBe(0);

      // set_storage_usage replaces the running total outright.
      const replaced = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        const [row] = await tx<{ set_storage_usage: string }[]>`
          SELECT app.set_storage_usage(1234)
        `;
        return Number(row!.set_storage_usage);
      });
      expect(replaced).toBe(1234);
      expect(await readMeter()).toBe(1234);
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);

// ---------------------------------------------------------------------------------------------------
// CHECK constraints
// ---------------------------------------------------------------------------------------------------

integrationTest(
  "enforces CHECK constraints on the storage usage meter and subscription cap",
  async () => {
    const database = await migratedDatabase();
    try {
      const school = await createSchool(database, "storage-checks-school");

      // A directly-written negative meter is rejected (functions floor, raw SQL must not).
      await expectDenied(
        database,
        `INSERT INTO app.storage_usage_meters (school_id, bytes_used)
         VALUES ('${school}', -1)`,
        school,
      );

      // A subscription cap of zero is rejected, even when every other column is valid.
      const plans = await asRole(database, "studafy_admin", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${school}, true)`;
        return tx<{ id: string }[]>`
          INSERT INTO app.plans (code, display_name, is_active)
          VALUES ('storage_checks_plan', 'Storage Checks Plan', true)
          RETURNING id
        `;
      });
      await expectDenied(
        database,
        `INSERT INTO app.subscriptions
           (school_id, plan_id, status, current_period_start, current_period_end, storage_cap_bytes)
         VALUES ('${school}', '${plans![0]!.id}', 'active', now(), now() + INTERVAL '30 days', 0)`,
        school,
        "studafy_admin",
      );
    } finally {
      await database.cleanup();
    }
  },
  60_000,
);
