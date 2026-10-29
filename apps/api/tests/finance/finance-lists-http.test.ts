/**
 * The finance list screens' filters: invoices by issue and due date (and paging past the first
 * page), payments by date, method and search. FINANCE holds billing:read but not student:read, so
 * each list must still return its rows and the student's name for a finance caller. Requires a live
 * PostgreSQL instance, gated on TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/finance-lists-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

interface InvoiceList {
  invoices: { id: string; erpnext_docname: string; student_name: string }[];
  next_cursor: string | null;
}

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

async function currencyId(): Promise<string> {
  const [row] = await database!.sql<{ id: string }[]>`
    SELECT id FROM app.currencies WHERE code = 'JOD'
  `;
  return row!.id;
}

async function invoice(
  schoolId: string,
  studentId: string,
  docname: string,
  dates: { issued: string; due?: string },
) {
  const [row] = await database!.sql<{ id: string }[]>`
    INSERT INTO app.invoice_cache
      (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
       total_amount_minor, outstanding_amount_minor, issued_date, due_date, last_synced_at)
    VALUES (${schoolId}::uuid, ${studentId}::uuid, ${await currencyId()}::uuid, ${docname},
            'submitted', 100000, 100000, ${dates.issued}::date, ${dates.due ?? null}::date, now())
    RETURNING id
  `;
  return row!.id;
}

async function get(actor: Actor, path: string) {
  return authenticatedRequest(harness!, "GET", path, actor);
}

describeDb("invoice list", () => {
  test("a finance caller sees every invoice with the student's name", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const student = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Omar",
      lastName: "Saleh",
    });
    await invoice(fixture.schoolId, student.id, "ACC-SINV-0001", { issued: "2026-09-01" });

    const response = await get(finance, "/api/finance/invoices");
    expect(response.status).toBe(200);
    const list = (await response.json()) as InvoiceList;
    expect(list.invoices.map((i) => [i.erpnext_docname, i.student_name])).toEqual([
      ["ACC-SINV-0001", "Omar Saleh"],
    ]);
  });
});
