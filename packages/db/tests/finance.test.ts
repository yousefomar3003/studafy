import { resolve } from "node:path";

import { expect, test } from "bun:test";

import { runMigrationCommand } from "../src/runner";

import { integrationEnabled, runnerEnv, testDatabase } from "./helpers";

import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const repositoryMigrations = resolve(import.meta.dir, "../../../db/migrations");
const FINANCE_TABLES = [
  "invoice_cache",
  "payment_cache",
  "fee_schedule_cache",
  "erpnext_id_mappings",
  "finance_sync_outbox",
  "fee_structure_cache",
  "expense_cache",
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

async function createSchools(
  database: Database,
): Promise<{ a: string; b: string; currency: string }> {
  const [refs] = await database.sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
  `;
  const rows = await asRole(database, "studafy_admin", async (tx) => {
    return tx<{ id: string; slug: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES
        ('finance-a', 'Finance A', 'finance-a@admin.local', 'finance-a@admin.local', ${refs!.country}, ${refs!.currency}),
        ('finance-b', 'Finance B', 'finance-b@admin.local', 'finance-b@admin.local', ${refs!.country}, ${refs!.currency})
      RETURNING id, slug
    `;
  });
  return {
    a: rows.find((row) => row.slug === "finance-a")!.id,
    b: rows.find((row) => row.slug === "finance-b")!.id,
    currency: refs!.currency,
  };
}

async function createStudent(database: Database, school: string, suffix: string): Promise<string> {
  // ST-085: app.students now carries a restrictive role_scope_visibility SELECT policy, which
  // PostgreSQL also applies to INSERT ... RETURNING. Seed as studafy_admin (still bound by
  // tenant_isolation, exempt from the TO studafy_app scope policy) so the fixture write is not
  // filtered by a per-user read scope it has no authenticated user for.
  return asRole(database, "studafy_admin", async (tx) => {
    await tx`SELECT set_config('app.school_id', ${school}, true)`;
    const email = `student-${suffix}@example.test`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${school}, ${email}, ${email}) RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${school}, ${user!.id}, ${`ADM-${suffix}`}, 'Ada', 'Lovelace') RETURNING id
    `;
    return student!.id;
  });
}

integrationTest(
  "installs the exact finance cache/mapping/outbox schema, ownership, grants, and forced policies",
  async () => {
    const database = await migratedDatabase();
    try {
      const enums = await database.sql<{ type: string; values: string[] }[]>`
        SELECT t.typname AS type, array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS values
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = 'app'
          AND t.typname IN ('finance_entity_type', 'finance_sync_outbox_status')
        GROUP BY t.typname ORDER BY t.typname
      `;
      expect(enums.map(({ type, values }) => ({ type, values }))).toEqual([
        {
          type: "finance_entity_type",
          values: [
            "invoice",
            "payment",
            "fee_schedule",
            "fee_structure",
            "fee_category",
            "expense",
          ],
        },
        {
          type: "finance_sync_outbox_status",
          values: ["pending", "processing", "completed", "failed"],
        },
      ]);

      const tables = await database.sql<
        {
          name: string;
          owner: string;
          rls: boolean;
          forced: boolean;
          app_dml: boolean;
          app_delete: boolean;
          public_access: boolean;
        }[]
      >`
        SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner,
          c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
          has_table_privilege('studafy_app', c.oid, 'SELECT,INSERT,UPDATE') AS app_dml,
          has_table_privilege('studafy_app', c.oid, 'DELETE') AS app_delete,
          has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS public_access
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${FINANCE_TABLES as unknown as string[]})
        ORDER BY c.relname
      `;
      expect(tables.map((row) => row.name)).toEqual([...FINANCE_TABLES].sort());
      expect(
        tables.every(
          (row) =>
            row.owner === "studafy_admin" &&
            row.rls &&
            row.forced &&
            row.app_dml &&
            !row.public_access,
        ),
      ).toBe(true);
      expect(
        tables
          .filter((row) => !["fee_structure_cache", "expense_cache"].includes(row.name))
          .every((row) => row.app_delete),
      ).toBe(true);

      const policies = await database.sql<{ table_name: string; name: string }[]>`
        SELECT c.relname AS table_name, p.polname AS name
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relname = ANY(${FINANCE_TABLES as unknown as string[]})
      `;
      expect(policies).toHaveLength(6);
      expect(policies.every((policy) => policy.name === "tenant_isolation")).toBe(true);

      // No local ledger: no table in this migration's schema names an account, journal, or ledger.
      const ledgerLike = await database.sql<{ name: string }[]>`
        SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app' AND c.relkind = 'r'
          AND c.relname ~ '(ledger|journal|account|debit|credit)'
      `;
      expect(ledgerLike).toHaveLength(0);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "enforces cache amount/date invariants, docname uniqueness, and outbox delivery-state checks",
  async () => {
    const database = await migratedDatabase();
    try {
      const { a, b, currency } = await createSchools(database);
      const studentA = await createStudent(database, a, "a");

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        await tx`
          INSERT INTO app.invoice_cache
            (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
             total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
          VALUES (${a}, ${studentA}, ${currency}, 'ACC-SINV-001', 'Submitted', 10000, 10000,
            '2026-01-01', now())
        `;
      });

      // Same docname, same school -> rejected by uq_invoice_cache_school_erpnext_docname.
      await expectDenied(
        database,
        `INSERT INTO app.invoice_cache
           (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
            total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
         VALUES ('${a}', '${studentA}', '${currency}', 'ACC-SINV-001', 'Submitted', 5000, 5000,
           '2026-01-02', now())`,
        a,
      );

      // Outstanding cannot exceed total.
      await expectDenied(
        database,
        `INSERT INTO app.invoice_cache
           (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
            total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
         VALUES ('${a}', '${studentA}', '${currency}', 'ACC-SINV-002', 'Submitted', 100, 200,
           '2026-01-02', now())`,
        a,
      );

      // Due date cannot precede issued date.
      await expectDenied(
        database,
        `INSERT INTO app.invoice_cache
           (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
            total_amount_minor, outstanding_amount_minor, issued_date, due_date, last_synced_at)
         VALUES ('${a}', '${studentA}', '${currency}', 'ACC-SINV-003', 'Submitted', 100, 100,
           '2026-01-10', '2026-01-01', now())`,
        a,
      );

      // Different school may reuse the same docname (each ERPNext site is independent).
      const studentB = await createStudent(database, b, "b");
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${b}, true)`;
        await tx`
          INSERT INTO app.invoice_cache
            (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
             total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
          VALUES (${b}, ${studentB}, ${currency}, 'ACC-SINV-001', 'Submitted', 100, 100,
            '2026-01-01', now())
        `;
      });

      // erpnext_id_mappings: unique per (school_id, entity, studafy_id); docname may start NULL.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        await tx`
          INSERT INTO app.erpnext_id_mappings (school_id, entity, studafy_id)
          VALUES (${a}, 'invoice', ${studentA})
        `;
      });
      await expectDenied(
        database,
        `INSERT INTO app.erpnext_id_mappings (school_id, entity, studafy_id)
         VALUES ('${a}', 'invoice', '${studentA}')`,
        a,
      );

      // finance_sync_outbox: a 'completed' row must carry processed_at; 'failed' must carry an error.
      await expectDenied(
        database,
        `INSERT INTO app.finance_sync_outbox (school_id, entity, studafy_id, payload, status)
         VALUES ('${a}', 'invoice', '${studentA}', '{}'::jsonb, 'completed')`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.finance_sync_outbox
           (school_id, entity, studafy_id, payload, status, processed_at)
         VALUES ('${a}', 'invoice', '${studentA}', '{}'::jsonb, 'failed', now())`,
        a,
      );
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO app.finance_sync_outbox
            (school_id, entity, studafy_id, payload, status, processed_at, last_error)
          VALUES (${a}, 'invoice', ${studentA}, '{"amount_minor": 100}'::jsonb, 'failed', now(),
            'erpnext unreachable')
          RETURNING id
        `;
        expect(row!.id).toBeTruthy();
      });
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);

integrationTest(
  "fails closed and isolates finance cache/mapping/outbox reads and writes per tenant",
  async () => {
    const database = await migratedDatabase();
    try {
      const { a, b, currency } = await createSchools(database);
      const studentA = await createStudent(database, a, "rls-a");

      for (const table of FINANCE_TABLES) {
        await expectDenied(database, `SELECT * FROM app.${table}`);
        for (const bad of ["", " ", "not-a-uuid"])
          await expectDenied(database, `SELECT * FROM app.${table}`, bad);
      }

      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        await tx`
          INSERT INTO app.payment_cache
            (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
             amount_minor, payment_date, last_synced_at)
          VALUES (${a}, ${studentA}, ${currency}, 'ACC-PAY-001', 'Submitted', 500,
            '2026-01-01', now())
        `;
      });

      const crossTenantCount = await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${b}, true)`;
        return tx<{ count: string }[]>`SELECT count(*)::text AS count FROM app.payment_cache`;
      });
      expect(crossTenantCount[0]!.count).toBe("0");

      await expectDenied(database, `UPDATE app.payment_cache SET school_id = '${b}'`, a);

      // FORCE applies to the table owner too; missing owner context cannot read rows.
      await expectDenied(database, "SELECT * FROM app.payment_cache", undefined, "studafy_admin");
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
