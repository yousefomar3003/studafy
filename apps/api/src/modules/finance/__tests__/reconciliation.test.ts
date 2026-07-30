// Finance reconciliation and fee schedule installments (ST-122).
//
// Split in two on purpose:
//
//   * The unit suites need no database and always run. They cover status computation, overdue
//     date comparison, and format helpers.
//   * The integration suite covers the acceptance criteria that cannot be faked — overdue
//     flagging, cache drift self-healing, and unresolved divergence logging — and needs a real
//     PostgreSQL with migrations applied. Gated on TEST_DATABASE_URL.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { createTestDatabase, integrationEnabled, migrateDatabase } from "../../../../tests/harness";
import { formatMinorUnits } from "../currency";
import { reconcileSchool } from "../jobs/reconciliation.job";

import type { TenantErpNext } from "../client/tenant-client";
import type { Sql, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const FEE_SCHEDULE_ID = "FS-2026-00001";

const integrationTest = test.skipIf(!integrationEnabled);

function makeErpNextStub(overrides?: Partial<Record<string, unknown>>): TenantErpNext {
  const doc = {
    name: FEE_SCHEDULE_ID,
    student: STUDENT_ID,
    total_amount: 1000,
    paid_amount: 0,
    outstanding_amount: 1000,
    currency: "JOD",
    due_date: "2026-06-15",
    docstatus: 1,
    ...overrides,
  };

  return {
    get: async <T>() => ({ data: { data: doc as unknown as T } }),
    post: async <T>() => ({ data: { data: doc as unknown as T } }),
    put: async <T>() => ({ data: { data: doc as unknown as T } }),
  } as unknown as TenantErpNext;
}

// ---------------------------------------------------------------------------
// Unit: Installment status computation
// ---------------------------------------------------------------------------

describe("installment status computation", () => {
  test("pending when no payment recorded", () => {
    const status = computeStatus(1000, 0, "2099-12-31");
    expect(status).toBe("pending");
  });

  test("partially_paid when some amount paid", () => {
    const status = computeStatus(1000, 300, "2099-12-31");
    expect(status).toBe("partially_paid");
  });

  test("paid when outstanding is zero", () => {
    const status = computeStatus(1000, 1000, "2099-12-31");
    expect(status).toBe("paid");
  });

  test("overdue when past due date and outstanding remains", () => {
    const status = computeStatus(1000, 0, "2020-01-01");
    expect(status).toBe("overdue");
  });

  test("overdue takes precedence over partially_paid when past due", () => {
    const status = computeStatus(1000, 300, "2020-01-01");
    expect(status).toBe("overdue");
  });

  test("paid stays paid even when past due", () => {
    const status = computeStatus(1000, 1000, "2020-01-01");
    expect(status).toBe("paid");
  });
});

function computeStatus(totalMinor: number, paidMinor: number, dueDateStr: string): string {
  const outstanding = totalMinor - paidMinor;
  const dueDate = new Date(dueDateStr);
  const now = new Date();

  if (outstanding <= 0) return "paid";
  if (dueDate < now) return "overdue";
  if (paidMinor > 0) return "partially_paid";
  return "pending";
}

// ---------------------------------------------------------------------------
// Unit: Amount formatting
// ---------------------------------------------------------------------------

describe("installment amount formatting", () => {
  test("formats JOD amounts with 3 decimal places", () => {
    expect(formatMinorUnits(1250500n, 3)).toBe("1250.500");
  });

  test("formats zero", () => {
    expect(formatMinorUnits(0n, 3)).toBe("0.000");
  });

  test("formats amounts with trailing zeros preserved", () => {
    expect(formatMinorUnits(500000n, 3)).toBe("500.000");
  });
});

// ---------------------------------------------------------------------------
// Integration: Database-backed reconciliation scenarios
// ---------------------------------------------------------------------------

describe("reconciliation integration", () => {
  integrationTest(
    "overdue flagging marks past-due installments and emits events",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const schoolId = await seedSchool(database.sql);
        const studentId = await seedStudent(database.sql, schoolId);
        const currencyId = await getCurrencyId(database.sql, "JOD");

        await seedInstallmentCache(database.sql, schoolId, studentId, currencyId, {
          erpnext_fee_schedule_id: "FS-OVERDUE-1",
          due_date: "2020-01-01",
          total_amount_minor: 100000,
          paid_amount_minor: 0,
          outstanding_amount_minor: 100000,
          status: "pending",
        });

        await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
          await tx.unsafe("SET LOCAL ROLE studafy_app");

          const erpnext = makeErpNextStub({
            name: "FS-OVERDUE-1",
            total_amount: 1000,
            paid_amount: 0,
            outstanding_amount: 1000,
          });

          const result = await reconcileSchool(tx, schoolId, erpnext);

          expect(result.status).toBe("drift_corrected");

          const [row] = await tx<{ status: string }[]>`
            SELECT status FROM app.installment_cache
            WHERE school_id = ${schoolId}::uuid AND erpnext_fee_schedule_id = 'FS-OVERDUE-1'
          `;
          expect(row!.status).toBe("overdue");
        });
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );

  integrationTest(
    "drift detection corrects stale amounts from ERPNext",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const schoolId = await seedSchool(database.sql);
        const studentId = await seedStudent(database.sql, schoolId);
        const currencyId = await getCurrencyId(database.sql, "JOD");

        // Seed with stale outstanding (500 local vs 300 ERPNext)
        await seedInstallmentCache(database.sql, schoolId, studentId, currencyId, {
          erpnext_fee_schedule_id: "FS-DRIFT-1",
          due_date: "2099-12-31",
          total_amount_minor: 100000,
          paid_amount_minor: 50000,
          outstanding_amount_minor: 50000,
          status: "partially_paid",
        });

        await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
          await tx.unsafe("SET LOCAL ROLE studafy_app");

          const erpnext = makeErpNextStub({
            name: "FS-DRIFT-1",
            total_amount: 1000,
            paid_amount: 700,
            outstanding_amount: 300,
          });

          const result = await reconcileSchool(tx, schoolId, erpnext);

          expect(result.driftDetectedCount).toBe(1);
          expect(result.autoHealedCount).toBe(1);
          expect(result.status).toBe("drift_corrected");

          const [row] = await tx<{ outstanding_amount_minor: number; status: string }[]>`
            SELECT outstanding_amount_minor, status FROM app.installment_cache
            WHERE school_id = ${schoolId}::uuid AND erpnext_fee_schedule_id = 'FS-DRIFT-1'
          `;
          expect(row!.outstanding_amount_minor).toBe(30000);
          expect(row!.status).toBe("paid");
        });
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );

  integrationTest(
    "unresolved divergence logs entity IDs and sets alerted_divergence status",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const schoolId = await seedSchool(database.sql);
        const studentId = await seedStudent(database.sql, schoolId);
        const currencyId = await getCurrencyId(database.sql, "JOD");

        await seedInstallmentCache(database.sql, schoolId, studentId, currencyId, {
          erpnext_fee_schedule_id: "FS-DIVERGE-1",
          due_date: "2099-12-31",
          total_amount_minor: 100000,
          paid_amount_minor: 0,
          outstanding_amount_minor: 100000,
          status: "pending",
        });

        await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
          await tx.unsafe("SET LOCAL ROLE studafy_app");

          // Return a doc with a currency that won't resolve, causing divergence
          const erpnext = makeErpNextStub({
            name: "FS-DIVERGE-1",
            total_amount: 1000,
            paid_amount: 200,
            outstanding_amount: 800,
            currency: "XYZ",
          });

          const result = await reconcileSchool(tx, schoolId, erpnext);

          expect(result.driftDetectedCount).toBe(1);
          expect(result.autoHealedCount).toBe(0);
          expect(result.unresolvedDivergences.length).toBe(1);
          expect(result.status).toBe("alerted_divergence");

          const divergence = result.unresolvedDivergences[0]!;
          expect(divergence.schoolId).toBe(schoolId);
          expect(divergence.studentId).toBe(studentId);
          expect(divergence.erpnextFeeScheduleId).toBe("FS-DIVERGE-1");
        });

        const [log] = await database.sql<{ status: string; unresolved_divergences: unknown }[]>`
          SELECT status, unresolved_divergences
          FROM app.finance_reconciliation_logs
          WHERE school_id = ${schoolId}::uuid
          ORDER BY created_at DESC
          LIMIT 1
        `;
        expect(log!.status).toBe("alerted_divergence");
        const divergences = JSON.parse(log!.unresolved_divergences as string);
        expect(divergences).toHaveLength(1);
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );

  integrationTest(
    "RLS prevents cross-tenant access to installment_cache",
    async () => {
      const database = await createTestDatabase();
      try {
        await migrateDatabase(database.url);

        const schoolA = await seedSchool(database.sql, "school-a");
        const schoolB = await seedSchool(database.sql, "school-b");
        const studentA = await seedStudent(database.sql, schoolA);
        const studentB = await seedStudent(database.sql, schoolB);
        const currencyId = await getCurrencyId(database.sql, "JOD");

        await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolA}, true)`.execute();
          await tx.unsafe("SET LOCAL ROLE studafy_app");

          await seedInstallmentCache(tx, schoolA, studentA, currencyId, {
            erpnext_fee_schedule_id: "FS-RLS-A",
            due_date: "2099-12-31",
            total_amount_minor: 100000,
            paid_amount_minor: 0,
            outstanding_amount_minor: 100000,
            status: "pending",
          });
        });

        // School B should NOT see School A's installment
        await database.sql.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${schoolB}, true)`.execute();
          await tx.unsafe("SET LOCAL ROLE studafy_app");

          await seedInstallmentCache(tx, schoolB, studentB, currencyId, {
            erpnext_fee_schedule_id: "FS-RLS-B",
            due_date: "2099-12-31",
            total_amount_minor: 200000,
            paid_amount_minor: 0,
            outstanding_amount_minor: 200000,
            status: "pending",
          });

          const rows = await tx<{ erpnext_fee_schedule_id: string }[]>`
            SELECT erpnext_fee_schedule_id FROM app.installment_cache
            WHERE school_id = ${schoolB}::uuid
          `;
          expect(rows).toHaveLength(1);
          expect(rows[0]!.erpnext_fee_schedule_id).toBe("FS-RLS-B");
        });
      } finally {
        await database.cleanup();
      }
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedSchool(sql: Sql | TransactionSql, slug?: string) {
  const [refs] = await sql<{ country: string; currency: string }[]>`
    SELECT
      (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
      (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
  `;
  const slugVal = slug ?? `recon-${crypto.randomUUID().slice(0, 8)}`;
  const [school] = await sql<{ id: string }[]>`
    INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
    VALUES (${slugVal}, ${slugVal}, ${slugVal}@admin.local', ${slugVal}@admin.local',
            ${refs!.country}, ${refs!.currency})
    RETURNING id
  `;
  return school!.id;
}

async function seedStudent(sql: Sql, schoolId: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`.execute();
    const email = `stu-${crypto.randomUUID().slice(0, 8)}@test.local`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email)
      VALUES (${schoolId}, ${email}, ${email}) RETURNING id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name)
      VALUES (${schoolId}, ${user!.id}, 'ADM-${crypto.randomUUID().slice(0, 8)}', 'Test', 'Student')
      RETURNING id
    `;
    return student!.id;
  });
}

async function getCurrencyId(sql: Sql | TransactionSql, code: string) {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM app.currencies WHERE code = ${code}
  `;
  return row!.id;
}

async function seedInstallmentCache(
  sql: Sql | TransactionSql,
  schoolId: string,
  studentId: string,
  currencyId: string,
  data: {
    erpnext_fee_schedule_id: string;
    due_date: string;
    total_amount_minor: number;
    paid_amount_minor: number;
    outstanding_amount_minor: number;
    status: string;
  },
) {
  await sql`
    INSERT INTO app.installment_cache (
      school_id, student_id, erpnext_fee_schedule_id, due_date,
      total_amount_minor, paid_amount_minor, outstanding_amount_minor,
      currency_id, status, erpnext_payload, synced_at
    ) VALUES (
      ${schoolId}::uuid,
      ${studentId}::uuid,
      ${data.erpnext_fee_schedule_id},
      ${data.due_date}::date,
      ${data.total_amount_minor}::bigint,
      ${data.paid_amount_minor}::bigint,
      ${data.outstanding_amount_minor}::bigint,
      ${currencyId}::uuid,
      ${data.status},
      '{}'::jsonb,
      CURRENT_TIMESTAMP
    )
  `;
}
