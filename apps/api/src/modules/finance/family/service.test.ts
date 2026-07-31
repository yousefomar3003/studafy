// Family financial view aggregation (ST-127).
//
// Split in two on purpose:
//
//   * The unit suite needs no database and always runs. It covers pay-online URL composition.
//   * The integration suite covers the aggregation itself — household totals, per-student
//     sections, currency grouping, freshness, and the pay_online_url gate — and needs a real
//     PostgreSQL with migrations applied. Gated on TEST_DATABASE_URL.
//
// The integration suite runs the aggregation as the *parent* user (app.user_id set), which is
// the real production shape: withTenantTx configures the authenticated user, and app.students is
// role-scope-gated (migration 000037), so the admission-number lookup only succeeds for children
// the caller is actually related to.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createSchool,
  createStudent,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";

import { aggregateFamilyFinancialView, buildPayOnlineUrl } from "./service";

import type { Sql, TransactionSql } from "postgres";

const PAY_BASE = "https://pay.studafy.example/checkout";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

/** Runs as studafy_app with tenant + authenticated-user GUCs set — the context withTenantTx establishes. */
async function withTx<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

async function getCurrencyId(sql: Sql | TransactionSql, code: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM app.currencies WHERE code = ${code}
  `;
  return row!.id;
}

// ---------------------------------------------------------------------------
// Unit: pay-online URL composition
// ---------------------------------------------------------------------------

describe("buildPayOnlineUrl", () => {
  test("returns null when no redirect base is configured", () => {
    expect(buildPayOnlineUrl(undefined, "INV-1", "student-1")).toBeNull();
  });

  test("composes the invoice and student identity onto the base URL", () => {
    const url = buildPayOnlineUrl(PAY_BASE, "INV-1", "student-1");
    expect(url).toBe("https://pay.studafy.example/checkout?invoice=INV-1&student=student-1");
  });

  test("preserves query parameters already present on the base URL", () => {
    const url = buildPayOnlineUrl("https://pay.studafy.example/checkout?lang=ar", "INV-1", "s1");
    expect(url).toBe("https://pay.studafy.example/checkout?lang=ar&invoice=INV-1&student=s1");
  });
});

// ---------------------------------------------------------------------------
// Integration: database-backed aggregation
// ---------------------------------------------------------------------------

describeDb("family financial view aggregation", () => {
  test("aggregates a household's finance records into the view", async () => {
    const school = await createSchool(db.sql);
    const parent = await createUser(db.sql, school.id, { displayName: "Household Parent" });
    const studentA = await createStudent(db.sql, school.id, {
      admissionNumber: "ADM-1001",
      firstName: "Ali",
      lastName: "A",
    });
    const studentB = await createStudent(db.sql, school.id, {
      admissionNumber: "ADM-1002",
      firstName: "Noor",
      lastName: "B",
    });

    const { familyId } = await seedFinanceFixture(
      db,
      school.id,
      parent.id,
      studentA.id,
      studentB.id,
    );

    const view = await withTx(school.id, parent.id, (tx) =>
      aggregateFamilyFinancialView(
        tx,
        school.id,
        familyId,
        [studentA.id, studentB.id],
        "en",
        PAY_BASE,
      ),
    );

    expect(view.family_id).toBe(familyId);
    expect(view.presentation).toEqual({
      locale: "en",
      direction: "ltr",
      currency: "JOD",
      currency_precision: 3,
    });
    expect(view.reconciled_at).toBe("2026-07-23T10:00:00.000Z");
    expect(view.data_as_of).toBe("2026-07-22T10:00:00.000Z");

    // Sections follow the caller-supplied student order, and each carries its own ERPNext customer.
    expect(view.students).toHaveLength(2);
    expect(view.students[0]!.student_id).toBe(studentA.id);
    expect(view.students[0]!.customer_ids).toEqual(["ADM-1001"]);
    expect(view.students[1]!.student_id).toBe(studentB.id);
    expect(view.students[1]!.customer_ids).toEqual(["ADM-1002"]);

    const sectionA = view.students[0]!;
    expect(sectionA.invoices).toHaveLength(1);
    expect(sectionA.invoices[0]).toMatchObject({
      erpnext_docname: "INV-1",
      total_amount: "1000.000",
      outstanding_amount: "400.000",
      pay_online_url: `${PAY_BASE}?invoice=INV-1&student=${studentA.id}`,
    });
    expect(sectionA.installments[0]).toMatchObject({
      erpnext_fee_schedule_id: "FS-1",
      status: "paid",
      paid_amount: "600.000",
      outstanding_amount: "0.000",
    });
    expect(sectionA.payments[0]).toMatchObject({
      erpnext_payment_entry_id: "PAY-1",
      amount: "600.000",
      status: "confirmed",
      payment_mode: "bank_transfer",
    });
    expect(sectionA.totals).toEqual([
      {
        currency: "JOD",
        currency_minor_unit: 3,
        total_amount: "1000.000",
        total_amount_minor: 1000000,
        paid_amount: "600.000",
        paid_amount_minor: 600000,
        outstanding_amount: "400.000",
        outstanding_amount_minor: 400000,
      },
    ]);

    const sectionB = view.students[1]!;
    expect(sectionB.invoices[0]!.pay_online_url).toBeNull();
    expect(sectionB.installments[0]).toMatchObject({
      erpnext_fee_schedule_id: "FS-2",
      status: "pending",
      outstanding_amount: "500.000",
    });

    expect(view.household_totals).toEqual([
      {
        currency: "JOD",
        currency_minor_unit: 3,
        total_amount: "1500.000",
        total_amount_minor: 1500000,
        paid_amount: "1100.000",
        paid_amount_minor: 1100000,
        outstanding_amount: "400.000",
        outstanding_amount_minor: 400000,
      },
    ]);
  });

  test("never emits a pay-online URL when the redirect base is unconfigured", async () => {
    const school = await createSchool(db.sql);
    const parent = await createUser(db.sql, school.id);
    const studentA = await createStudent(db.sql, school.id);
    const studentB = await createStudent(db.sql, school.id);

    const { familyId } = await seedFinanceFixture(
      db,
      school.id,
      parent.id,
      studentA.id,
      studentB.id,
    );

    const view = await withTx(school.id, parent.id, (tx) =>
      aggregateFamilyFinancialView(
        tx,
        school.id,
        familyId,
        [studentA.id, studentB.id],
        "ar",
        undefined,
      ),
    );

    expect(view.presentation).toEqual({
      locale: "ar",
      direction: "rtl",
      currency: "JOD",
      currency_precision: 3,
    });
    for (const section of view.students) {
      for (const invoice of section.invoices) {
        expect(invoice.pay_online_url).toBeNull();
      }
    }
  });

  test("returns an empty view for a family with no linked children or finance data", async () => {
    const school = await createSchool(db.sql);
    const parent = await createUser(db.sql, school.id);

    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${school.id}, 'Empty Family', ${parent.id})
      RETURNING id
    `;

    const view = await withTx(school.id, parent.id, (tx) =>
      aggregateFamilyFinancialView(tx, school.id, family!.id, [], "en", PAY_BASE),
    );

    expect(view.students).toEqual([]);
    expect(view.household_totals).toEqual([]);
    expect(view.data_as_of).toBeNull();
    expect(view.reconciled_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

interface FinanceFixture {
  familyId: string;
}

async function seedFinanceFixture(
  database: TestDatabase,
  schoolId: string,
  parentId: string,
  studentAId: string,
  studentBId: string,
): Promise<FinanceFixture> {
  return withTx(schoolId, parentId, async (tx) => {
    const currencyId = await getCurrencyId(tx, "JOD");

    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}, 'Test Family', ${parentId})
      RETURNING id
    `;
    const familyId = family!.id;

    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES
        (${schoolId}, ${parentId}, ${studentAId}, 'father', ${familyId}),
        (${schoolId}, ${parentId}, ${studentBId}, 'father', ${familyId})
    `;

    await tx`
      INSERT INTO app.invoice_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status,
        total_amount_minor, outstanding_amount_minor, issued_date, due_date,
        erpnext_payload, last_synced_at
      ) VALUES
        (
          ${schoolId}, ${studentAId}, ${currencyId}, 'INV-1', 'Submitted',
          1000000, 400000, '2026-01-01'::date, '2026-02-01'::date, '{}'::jsonb,
          '2026-07-20T10:00:00Z'::timestamptz
        ),
        (
          ${schoolId}, ${studentBId}, ${currencyId}, 'INV-2', 'Submitted',
          500000, 0, '2026-01-05'::date, '2026-02-05'::date, '{}'::jsonb,
          '2026-07-20T11:00:00Z'::timestamptz
        )
    `;

    await tx`
      INSERT INTO app.installment_cache (
        school_id, student_id, erpnext_fee_schedule_id, due_date,
        total_amount_minor, paid_amount_minor, outstanding_amount_minor,
        currency_id, status, erpnext_payload, synced_at
      ) VALUES
        (
          ${schoolId}, ${studentAId}, 'FS-1', '2026-01-15'::date,
          600000, 600000, 0, ${currencyId}, 'paid', '{}'::jsonb,
          '2026-07-21T10:00:00Z'::timestamptz
        ),
        (
          ${schoolId}, ${studentBId}, 'FS-2', '2026-06-01'::date,
          500000, 0, 500000, ${currencyId}, 'pending', '{}'::jsonb,
          '2026-07-21T09:00:00Z'::timestamptz
        )
    `;

    await tx`
      INSERT INTO app.payment_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status,
        amount_minor, payment_date, erpnext_payload, last_synced_at,
        status, payment_mode, erpnext_invoice_id, receipt_url, confirmed_at
      ) VALUES (
        ${schoolId}, ${studentAId}, ${currencyId}, 'PAY-1', 'Submitted',
        600000, '2026-01-10'::date, '{}'::jsonb, '2026-07-22T10:00:00Z'::timestamptz,
        'confirmed', 'bank_transfer', 'INV-1', 'https://erp.example/receipt/PAY-1',
        '2026-07-22T10:00:00Z'::timestamptz
      )
    `;

    await tx`
      INSERT INTO app.finance_reconciliation_logs (school_id, job_run_at, status)
      VALUES (${schoolId}, '2026-07-23T10:00:00Z'::timestamptz, 'success')
    `;

    return { familyId };
  });
}
