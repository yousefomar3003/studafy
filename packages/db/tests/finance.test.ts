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
  // ST-121. Adding the name here is enough: the policy-count assertion below derives from
  // FINANCE_TABLES.length, and the tenant-isolation and cross-tenant-leakage loops iterate it.
  "payment_idempotency_logs",
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
            "scholarship_discount",
            "award",
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
      expect(policies).toHaveLength(FINANCE_TABLES.length);
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

integrationTest(
  "installs ST-121's payment lifecycle columns, idempotency guard, and reconciliation indexes",
  async () => {
    const database = await migratedDatabase();
    try {
      const { a, b, currency } = await createSchools(database);
      const studentA = await createStudent(database, a, "st121-a");

      // --- payment_cache gains a lifecycle without disturbing the 000015 columns ---------------
      const columns = await database.sql<
        { name: string; nullable: string; default: string | null }[]
      >`
        SELECT column_name AS name, is_nullable AS nullable, column_default AS default
        FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'payment_cache'
          AND column_name IN ('erpnext_invoice_id', 'payment_mode', 'status',
                              'receipt_url', 'idempotency_key', 'confirmed_at')
        ORDER BY column_name
      `;
      expect(columns.map((c) => c.name)).toEqual([
        "confirmed_at",
        "erpnext_invoice_id",
        "idempotency_key",
        "payment_mode",
        "receipt_url",
        "status",
      ]);
      // payment_mode and erpnext_invoice_id must stay nullable: a payment projected from ERPNext that
      // this gateway did not forward knows neither.
      expect(columns.find((c) => c.name === "payment_mode")!.nullable).toBe("YES");
      expect(columns.find((c) => c.name === "erpnext_invoice_id")!.nullable).toBe("YES");
      // status is NOT NULL with a default, which is what keeps every pre-ST-121 insert site working.
      const status = columns.find((c) => c.name === "status")!;
      expect(status.nullable).toBe("NO");
      expect(status.default).toContain("pending");

      // --- The lifecycle constraints actually bite -----------------------------------------------
      await expectDenied(
        database,
        `INSERT INTO app.payment_cache
           (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
            amount_minor, payment_date, status, last_synced_at)
         VALUES ('${a}', '${studentA}', '${currency}', 'ST121-BAD-1', 'submitted',
                 500, '2026-01-01', 'confirmed', now())`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.payment_cache
           (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
            amount_minor, payment_date, payment_mode, last_synced_at)
         VALUES ('${a}', '${studentA}', '${currency}', 'ST121-BAD-2', 'submitted',
                 500, '2026-01-01', 'crypto', now())`,
        a,
      );
      await expectDenied(
        database,
        `INSERT INTO app.payment_cache
           (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
            amount_minor, payment_date, status, last_synced_at)
         VALUES ('${a}', '${studentA}', '${currency}', 'ST121-BAD-3', 'submitted',
                 500, '2026-01-01', 'refunded', now())`,
        a,
      );

      // A coherent confirmed row is accepted, and every supported mode round-trips.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        for (const mode of ["cash", "bank_transfer", "card_external"]) {
          await tx`
            INSERT INTO app.payment_cache
              (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
               amount_minor, payment_date, payment_mode, status, confirmed_at,
               erpnext_invoice_id, receipt_url, idempotency_key, last_synced_at)
            VALUES (${a}, ${studentA}, ${currency}, ${`ST121-OK-${mode}`}, 'submitted',
                    12345, '2026-01-01', ${mode}, 'confirmed', now(),
                    'ACC-SINV-1', '/printview?doctype=Payment%20Entry&name=x',
                    ${`key-${mode}`}, now())
          `;
        }
      });

      // --- The idempotency guard is tenant-scoped -----------------------------------------------
      const hash = "c".repeat(64);
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${a}, true)`;
        await tx`
          INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
          VALUES (${a}, 'shared-key', ${hash})
        `;
      });
      // Same key, same school: refused by idx_payment_idempotency_unique. This index is the
      // mechanism behind "exactly one Payment Entry per Idempotency-Key".
      await expectDenied(
        database,
        `INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
         VALUES ('${a}', 'shared-key', '${hash}')`,
        a,
      );
      // Same key, different school: permitted. A client's key namespace is its own.
      await asRole(database, "studafy_app", async (tx) => {
        await tx`SELECT set_config('app.school_id', ${b}, true)`;
        await tx`
          INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
          VALUES (${b}, 'shared-key', ${hash})
        `;
      });
      // A malformed hash cannot be stored, so it can never fail to match a legitimate retry.
      await expectDenied(
        database,
        `INSERT INTO app.payment_idempotency_logs (school_id, idempotency_key, request_hash)
         VALUES ('${a}', 'bad-hash', 'NOTAHASH')`,
        a,
      );

      // --- Indexes exist under the names the plan and the query planner expect -------------------
      const indexes = await database.sql<{ name: string }[]>`
        SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = 'app' AND indexname IN (
          'idx_payment_idempotency_unique',
          'idx_payment_cache_invoice_student',
          'idx_payment_cache_status'
        )
        ORDER BY indexname
      `;
      expect(indexes.map((i) => i.name)).toEqual([
        "idx_payment_cache_invoice_student",
        "idx_payment_cache_status",
        "idx_payment_idempotency_unique",
      ]);

      // ST-121 also asked for a "fast webhook match index on Payment Entry ID". It is deliberately
      // absent: uq_payment_cache_school_erpnext_docname from 000015 already indexes exactly
      // (school_id, erpnext_docname). Asserted so the omission cannot be re-added by accident.
      const duplicateEntryIndexes = await database.sql<{ name: string }[]>`
        SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = 'app' AND tablename = 'payment_cache'
          AND indexdef LIKE '%erpnext_docname%'
      `;
      expect(duplicateEntryIndexes.map((i) => i.name)).toEqual([
        "uq_payment_cache_school_erpnext_docname",
      ]);
    } finally {
      await database.cleanup();
    }
  },
  30_000,
);
