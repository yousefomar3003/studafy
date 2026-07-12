import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type postgres from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const referenceSeed = resolve(repositoryMigrations, "000005_seed_countries_and_currencies.sql");
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

async function asRole(
  database: Database,
  role: Role,
  run: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  await database.sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await run(tx);
  });
}

async function expectDenied(database: Database, role: Role, statement: string): Promise<void> {
  await expect(
    asRole(database, role, (tx) => tx.unsafe(statement).then(() => undefined)),
  ).rejects.toThrow();
}

async function referenceIds(
  database: Database,
): Promise<{ countryId: string; currencyId: string }> {
  const [country] = await database.sql<{ id: string }[]>`
    SELECT id FROM app.countries WHERE alpha2_code = 'US'
  `;
  const [currency] = await database.sql<{ id: string }[]>`
    SELECT id FROM app.currencies WHERE code = 'USD'
  `;
  if (!country || !currency) throw new Error("required US/USD reference rows are missing");
  return { countryId: country.id, currencyId: currency.id };
}

integrationTest("applies all migrations and seeds deterministic reference data", async () => {
  const database = await migratedDatabase();
  try {
    const [history] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM public.schema_migrations
    `;
    const [countries] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.countries
    `;
    const [currencies] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.currencies
    `;
    expect(history?.count).toBe("7");
    expect(countries?.count).toBe("248");
    expect(currencies?.count).toBe("157");

    const env = runnerEnv(database.url, repositoryMigrations);
    const second = await runMigrationCommand("migrate", { env, log: () => undefined });
    expect(second.pending).toHaveLength(0);
    const validation: string[] = [];
    await runMigrationCommand("validate", { env, log: (line) => validation.push(line) });
    expect(validation).toContain("validated 8 applied migration(s)");
  } finally {
    await database.cleanup();
  }
});

integrationTest("reference seed is directly replayable without duplicates", async () => {
  const database = await migratedDatabase();
  try {
    // The path is the fixed committed ST-033 migration, never caller-controlled input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const sql = await readFile(referenceSeed, "utf8");
    await database.sql.unsafe(sql);
    const [counts] = await database.sql<{ countries: string; currencies: string }[]>`
      SELECT
        (SELECT count(*)::text FROM app.countries) AS countries,
        (SELECT count(*)::text FROM app.currencies) AS currencies
    `;
    expect(counts).toEqual({ countries: "248", currencies: "157" });
  } finally {
    await database.cleanup();
  }
});

integrationTest("all six tables are global, admin-owned, and runtime-read-only", async () => {
  const database = await migratedDatabase();
  try {
    const tables = await database.sql<{ table_name: string; owner: string }[]>`
      SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'app'
        AND c.relkind = 'r'
        AND c.relname = ANY(${GLOBAL_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
    expect(tables.map((row) => row.table_name)).toEqual([...GLOBAL_TABLES].sort());
    expect(tables.every((row) => row.owner === "studafy_admin")).toBe(true);

    const forbiddenColumns = await database.sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = ANY(${GLOBAL_TABLES as unknown as string[]})
        AND column_name IN ('school_id', 'tenant_id', 'organization_id')
    `;
    expect(forbiddenColumns).toHaveLength(0);

    for (const table of GLOBAL_TABLES) {
      const [privileges] = await database.sql.unsafe<
        {
          app_select: boolean;
          app_insert: boolean;
          app_update: boolean;
          app_delete: boolean;
          public_select: boolean;
        }[]
      >(`
        SELECT
          has_table_privilege('studafy_app', 'app.${table}', 'SELECT') AS app_select,
          has_table_privilege('studafy_app', 'app.${table}', 'INSERT') AS app_insert,
          has_table_privilege('studafy_app', 'app.${table}', 'UPDATE') AS app_update,
          has_table_privilege('studafy_app', 'app.${table}', 'DELETE') AS app_delete,
          has_table_privilege('public', 'app.${table}', 'SELECT') AS public_select
      `);
      expect(privileges).toEqual({
        app_select: true,
        app_insert: false,
        app_update: false,
        app_delete: false,
        public_select: false,
      });
    }

    await expectDenied(
      database,
      "studafy_app",
      `ALTER TABLE app.schools ADD COLUMN forbidden text`,
    );
  } finally {
    await database.cleanup();
  }
});

integrationTest("school identity, references, and lifecycle constraints are enforced", async () => {
  const database = await migratedDatabase();
  try {
    const { countryId, currencyId } = await referenceIds(database);
    await asRole(database, "studafy_admin", async (tx) => {
      const [school] = await tx.unsafe<{ status: string }[]>(`
        INSERT INTO app.schools (slug, name, country_id, default_currency_id)
        VALUES ('north-star-school', 'North Star School', '${countryId}', '${currencyId}')
        RETURNING status::text
      `);
      expect(school?.status).toBe("pending");
    });

    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.schools (slug, name, country_id, default_currency_id)
       VALUES ('north-star-school', 'Duplicate', '${countryId}', '${currencyId}')`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.schools (slug, name, country_id, default_currency_id)
       VALUES ('Invalid Slug', 'Invalid', '${countryId}', '${currencyId}')`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.schools (slug, name, status, country_id, default_currency_id)
       VALUES ('bad-status', 'Invalid', 'deleted', '${countryId}', '${currencyId}')`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.schools (slug, name, country_id, default_currency_id)
       VALUES ('bad-country', 'Invalid', gen_random_uuid(), '${currencyId}')`,
    );
    await expectDenied(
      database,
      "studafy_app",
      `INSERT INTO app.schools (slug, name, country_id, default_currency_id)
       VALUES ('runtime-write', 'Forbidden', '${countryId}', '${currencyId}')`,
    );

    const enumValues = await database.sql<{ enumlabel: string }[]>`
      SELECT e.enumlabel
      FROM pg_enum e
      WHERE e.enumtypid = 'app.school_status'::regtype
      ORDER BY e.enumsortorder
    `;
    expect(enumValues.map((row) => row.enumlabel)).toEqual([
      "pending",
      "active",
      "suspended",
      "archived",
    ]);
  } finally {
    await database.cleanup();
  }
});

integrationTest("plans and exact minor-unit prices remain normalized", async () => {
  const database = await migratedDatabase();
  try {
    const { currencyId } = await referenceIds(database);
    let planId = "";
    await asRole(database, "studafy_admin", async (tx) => {
      const [plan] = await tx.unsafe<{ id: string }[]>(`
        INSERT INTO app.plans (code, display_name, description)
        VALUES ('standard', 'Standard', 'Standard platform subscription')
        RETURNING id
      `);
      planId = plan!.id;
      await tx.unsafe(`
        INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
        VALUES ('${planId}', '${currencyId}', 'monthly', 1299)
      `);
    });

    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.plans (code, display_name) VALUES ('standard', 'Duplicate')`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
       VALUES ('${planId}', '${currencyId}', 'monthly', 1599)`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
       VALUES ('${planId}', '${currencyId}', 'yearly', -1)`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
       VALUES (gen_random_uuid(), '${currencyId}', 'yearly', 10000)`,
    );

    const [amount] = await database.sql<{ data_type: string }[]>`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'plan_prices' AND column_name = 'amount_minor'
    `;
    expect(amount?.data_type).toBe("bigint");
  } finally {
    await database.cleanup();
  }
});

integrationTest(
  "country and currency seed codes and domain constraints are canonical",
  async () => {
    const database = await migratedDatabase();
    try {
      const [invalid] = await database.sql<{ countries: string; currencies: string }[]>`
      SELECT
        (SELECT count(*)::text FROM app.countries
          WHERE alpha2_code !~ '^[A-Z]{2}$'
             OR alpha3_code !~ '^[A-Z]{3}$'
             OR numeric_code !~ '^[0-9]{3}$') AS countries,
        (SELECT count(*)::text FROM app.currencies
          WHERE code !~ '^[A-Z]{3}$'
             OR numeric_code !~ '^[0-9]{3}$'
             OR minor_unit NOT BETWEEN 0 AND 4) AS currencies
    `;
      expect(invalid).toEqual({ countries: "0", currencies: "0" });

      await expectDenied(
        database,
        "studafy_admin",
        `INSERT INTO app.countries (alpha2_code, alpha3_code, numeric_code, name)
       VALUES ('xx', 'XXX', '999', 'Invalid Country')`,
      );
      await expectDenied(
        database,
        "studafy_admin",
        `INSERT INTO app.currencies (code, numeric_code, name, minor_unit)
       VALUES ('BAD', '999', 'Invalid Currency', 5)`,
      );
    } finally {
      await database.cleanup();
    }
  },
);

integrationTest("platform settings require one typed non-secret value", async () => {
  const database = await migratedDatabase();
  try {
    const [seeded] = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.platform_settings
    `;
    expect(seeded?.count).toBe("0");

    await asRole(database, "studafy_admin", (tx) =>
      tx
        .unsafe(
          `
          INSERT INTO app.platform_settings
            (key, description, value_type, boolean_value, sensitivity)
          VALUES ('features.public_catalog', 'Expose the public plan catalog', 'boolean', true, 'public')
        `,
        )
        .then(() => undefined),
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.platform_settings
        (key, description, value_type, boolean_value, integer_value)
       VALUES ('invalid.multiple_values', 'Invalid', 'boolean', true, 1)`,
    );
    await expectDenied(
      database,
      "studafy_admin",
      `INSERT INTO app.platform_settings (key, description, value_type)
       VALUES ('invalid.missing_value', 'Invalid', 'text')`,
    );
    await expectDenied(
      database,
      "studafy_app",
      `UPDATE app.platform_settings SET boolean_value = false
       WHERE key = 'features.public_catalog'`,
    );
  } finally {
    await database.cleanup();
  }
});

integrationTest("foreign keys and indexes are deliberate and non-redundant", async () => {
  const database = await migratedDatabase();
  try {
    const foreignKeys = await database.sql<{ conname: string }[]>`
      SELECT conname
      FROM pg_constraint
      WHERE connamespace = 'app'::regnamespace
        AND contype = 'f'
        AND conrelid IN (
          SELECT c.oid
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app'
            AND c.relname = ANY(${GLOBAL_TABLES as unknown as string[]})
        )
      ORDER BY conname
    `;
    expect(foreignKeys.map((row) => row.conname)).toEqual([
      "fk_plan_prices_currency",
      "fk_plan_prices_plan",
      "fk_schools_country",
      "fk_schools_default_currency",
    ]);

    const optionalIndexes = await database.sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'app'
        AND tablename = ANY(${GLOBAL_TABLES as unknown as string[]})
        AND indexname LIKE 'idx_%'
      ORDER BY indexname
    `;
    expect(optionalIndexes.map((row) => row.indexname)).toEqual([
      "idx_plan_prices_currency_id",
      "idx_schools_country_id",
      "idx_schools_default_currency_id",
    ]);

    const duplicateIndexes = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM (
        SELECT
          indrelid,
          indkey::text AS indexed_columns,
          indclass::text AS operator_classes,
          indcollation::text AS collations,
          indexprs::text AS expressions,
          indpred::text AS predicate
        FROM pg_index
        WHERE indrelid IN (
          SELECT c.oid FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'app' AND c.relname = ANY(${GLOBAL_TABLES as unknown as string[]})
        )
        GROUP BY
          indrelid,
          indkey::text,
          indclass::text,
          indcollation::text,
          indexprs::text,
          indpred::text
        HAVING count(*) > 1
      ) duplicates
    `;
    expect(duplicateIndexes[0]?.count).toBe("0");

    const relationshipContainers = await database.sql<{ count: string }[]>`
      SELECT count(*)::text AS count
      FROM information_schema.columns
      WHERE table_schema = 'app'
        AND table_name = ANY(${GLOBAL_TABLES as unknown as string[]})
        AND (data_type = 'ARRAY' OR udt_name = 'jsonb' OR column_name ~ '^price_[0-9]+$')
    `;
    expect(relationshipContainers[0]?.count).toBe("0");
  } finally {
    await database.cleanup();
  }
});
