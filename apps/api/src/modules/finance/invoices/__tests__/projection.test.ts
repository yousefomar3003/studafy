// Invoice projection amounts: what invoice_cache records as owed for an ERPNext Sales Invoice.
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createSchool,
  createStudent,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../../tests/harness";
import { projectInvoiceEntry } from "../projection";

import type { TransactionSql } from "postgres";

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

async function withTx<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${schoolId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

describeDb("projectInvoiceEntry amounts", () => {
  async function project(doc: Record<string, unknown>) {
    const school = await createSchool(db.sql);
    const student = await createStudent(db.sql, school.id);
    return withTx(school.id, (tx) =>
      projectInvoiceEntry(tx, school.id, {
        name: `ACC-SINV-${crypto.randomUUID().slice(0, 8)}`,
        docstatus: 1,
        currency: "AED",
        custom_student_id: student.id,
        ...doc,
      }),
    );
  }

  test("an invoice ERPNext rounded up is recorded at its rounded total", async () => {
    const row = await project({
      grand_total: 1208.55,
      rounded_total: 1209,
      outstanding_amount: 1209,
    });
    expect(row).toMatchObject({ total_amount_minor: 120900, outstanding_amount_minor: 120900 });
  });

  test("an invoice ERPNext rounded down is recorded at what is owed", async () => {
    const row = await project({
      grand_total: 1208.45,
      rounded_total: 1208,
      outstanding_amount: 1208,
    });
    expect(row).toMatchObject({ total_amount_minor: 120800, outstanding_amount_minor: 120800 });
  });

  test("an invoice with rounding disabled keeps its exact grand total", async () => {
    const row = await project({
      grand_total: 1208.55,
      rounded_total: 0,
      outstanding_amount: 1208.55,
    });
    expect(row).toMatchObject({ total_amount_minor: 120855, outstanding_amount_minor: 120855 });
  });

  test("an outstanding above the invoice's total is still refused", async () => {
    expect(
      await project({ grand_total: 100, rounded_total: 100, outstanding_amount: 150 }),
    ).toBeNull();
  });
});
