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

async function payment(
  schoolId: string,
  studentId: string,
  docname: string,
  fields: { date: string; mode: "cash" | "bank_transfer"; minor: number; confirmed?: boolean },
) {
  const confirmed = fields.confirmed ?? true;
  await database!.sql`
    INSERT INTO app.payment_cache
      (school_id, student_id, currency_id, erpnext_docname, erpnext_status, amount_minor,
       payment_date, last_synced_at, erpnext_invoice_id, payment_mode, status, confirmed_at)
    VALUES (${schoolId}::uuid, ${studentId}::uuid, ${await currencyId()}::uuid, ${docname},
            ${confirmed ? "submitted" : "draft"}, ${fields.minor}, ${fields.date}::date, now(),
            'ACC-SINV-0001', ${fields.mode}, ${confirmed ? "confirmed" : "pending"},
            CASE WHEN ${confirmed} THEN now() END)
  `;
}

interface PaymentList {
  payments: { erpnext_payment_entry_id: string; student_name: string }[];
  total: number;
  totals: { currency: string; amount: string; amount_minor: number; count: number }[];
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

describeDb("invoice list filters and paging", () => {
  test("pages past the first page and filters by issue and due date", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const studentId = fixture.students[0]!.id;
    await invoice(fixture.schoolId, studentId, "INV-SEP", {
      issued: "2026-09-01",
      due: "2026-09-30",
    });
    await invoice(fixture.schoolId, studentId, "INV-OCT", {
      issued: "2026-10-01",
      due: "2026-10-31",
    });
    await invoice(fixture.schoolId, studentId, "INV-NOV", { issued: "2026-11-01" });

    const first = (await (
      await get(finance, "/api/finance/invoices?limit=2")
    ).json()) as InvoiceList;
    expect(first.invoices.length).toBe(2);
    expect(first.next_cursor).not.toBeNull();
    const second = (await (
      await get(finance, `/api/finance/invoices?limit=2&cursor=${first.next_cursor}`)
    ).json()) as InvoiceList;
    expect(second.invoices.length).toBe(1);
    expect(second.next_cursor).toBeNull();
    expect([...first.invoices, ...second.invoices].map((i) => i.erpnext_docname).sort()).toEqual([
      "INV-NOV",
      "INV-OCT",
      "INV-SEP",
    ]);

    const issued = (await (
      await get(finance, "/api/finance/invoices?issued_from=2026-09-15&issued_to=2026-10-15")
    ).json()) as InvoiceList;
    expect(issued.invoices.map((i) => i.erpnext_docname)).toEqual(["INV-OCT"]);

    // An invoice with no due date never matches a due-date bound.
    const due = (await (
      await get(finance, "/api/finance/invoices?due_to=2026-10-31")
    ).json()) as InvoiceList;
    expect(due.invoices.map((i) => i.erpnext_docname).sort()).toEqual(["INV-OCT", "INV-SEP"]);

    const backwards = await get(
      finance,
      "/api/finance/invoices?issued_from=2026-10-02&issued_to=2026-10-01",
    );
    expect(backwards.status).toBe(400);
  });

  test("a finance caller opens an invoice's detail", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const id = await invoice(fixture.schoolId, fixture.students[0]!.id, "INV-ONE", {
      issued: "2026-09-01",
    });
    const response = await get(finance, `/api/finance/invoices/${id}`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { erpnext_docname: string }).erpnext_docname).toBe(
      "INV-ONE",
    );
  });
});

describeDb("payment list filters", () => {
  test("filters by date, method and search, and totals confirmed money across pages", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const omar = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Omar",
      lastName: "Saleh",
    });
    const lina = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Lina",
      lastName: "Haddad",
    });
    await payment(fixture.schoolId, omar.id, "PE-0001", {
      date: "2026-10-01",
      mode: "cash",
      minor: 10_000,
    });
    await payment(fixture.schoolId, omar.id, "PE-0002", {
      date: "2026-10-01",
      mode: "bank_transfer",
      minor: 25_500,
    });
    await payment(fixture.schoolId, lina.id, "PE-0003", {
      date: "2026-10-02",
      mode: "cash",
      minor: 5_000,
    });
    await payment(fixture.schoolId, lina.id, "PE-0004", {
      date: "2026-10-01",
      mode: "cash",
      minor: 99_000,
      confirmed: false,
    });

    const day = (await (
      await get(finance, "/api/finance/payments?date_from=2026-10-01&date_to=2026-10-01&limit=1")
    ).json()) as PaymentList;
    expect(day.total).toBe(3);
    expect(day.payments.length).toBe(1);
    // Every page's confirmed money, not just this page's, and never the pending one.
    expect(day.totals).toEqual([
      { currency: "JOD", amount: "35.500", amount_minor: 35_500, count: 2 },
    ]);

    const cash = (await (
      await get(finance, "/api/finance/payments?payment_mode=cash&status=confirmed")
    ).json()) as PaymentList;
    expect(cash.payments.map((p) => p.erpnext_payment_entry_id).sort()).toEqual([
      "PE-0001",
      "PE-0003",
    ]);

    const byName = (await (
      await get(finance, "/api/finance/payments?search=haddad")
    ).json()) as PaymentList;
    expect(byName.payments.map((p) => p.erpnext_payment_entry_id).sort()).toEqual([
      "PE-0003",
      "PE-0004",
    ]);
    expect(byName.payments[0]!.student_name).toBe("Lina Haddad");

    const byNumber = (await (
      await get(finance, "/api/finance/payments?search=PE-0002")
    ).json()) as PaymentList;
    expect(byNumber.payments.map((p) => p.erpnext_payment_entry_id)).toEqual(["PE-0002"]);
  });

  test("another school's payments never appear in the list or the totals", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    await payment(other.schoolId, other.students[0]!.id, "PE-ELSEWHERE", {
      date: "2026-10-01",
      mode: "cash",
      minor: 1_000,
    });
    const list = (await (await get(finance, "/api/finance/payments")).json()) as PaymentList;
    expect(list.total).toBe(0);
    expect(list.totals).toEqual([]);
  });
});

interface CollectionsReport {
  rows: {
    date: string;
    currency: string;
    payment_mode: string | null;
    amount: string;
    amount_minor: number;
    count: number;
  }[];
  totals: {
    currency: string;
    payment_mode: string | null;
    amount: string;
    amount_minor: number;
    count: number;
  }[];
}

describeDb("collections by method report", () => {
  test("groups confirmed money by day and method, and leaves out pending and reversed", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const studentId = fixture.students[0]!.id;
    await payment(fixture.schoolId, studentId, "PE-C1", {
      date: "2026-10-01",
      mode: "cash",
      minor: 10_000,
    });
    await payment(fixture.schoolId, studentId, "PE-C2", {
      date: "2026-10-01",
      mode: "cash",
      minor: 5_000,
    });
    await payment(fixture.schoolId, studentId, "PE-B1", {
      date: "2026-10-02",
      mode: "bank_transfer",
      minor: 20_000,
    });
    await payment(fixture.schoolId, studentId, "PE-P1", {
      date: "2026-10-02",
      mode: "cash",
      minor: 99_000,
      confirmed: false,
    });
    await payment(fixture.schoolId, studentId, "PE-R1", {
      date: "2026-10-02",
      mode: "cash",
      minor: 7_000,
    });
    await database!.sql`
      UPDATE app.payment_cache SET status = 'reversed' WHERE erpnext_docname = 'PE-R1'
    `;
    await payment(fixture.schoolId, studentId, "PE-OUT", {
      date: "2026-10-05",
      mode: "cash",
      minor: 1_000,
    });

    const response = await get(
      finance,
      "/api/finance/reports/collections-by-method?from_date=2026-10-01&to_date=2026-10-02",
    );
    expect(response.status).toBe(200);
    const report = (await response.json()) as CollectionsReport;
    expect(report.rows).toEqual([
      {
        date: "2026-10-01",
        currency: "JOD",
        payment_mode: "cash",
        amount: "15.000",
        amount_minor: 15_000,
        count: 2,
      },
      {
        date: "2026-10-02",
        currency: "JOD",
        payment_mode: "bank_transfer",
        amount: "20.000",
        amount_minor: 20_000,
        count: 1,
      },
    ]);
    expect(report.totals).toEqual([
      { currency: "JOD", payment_mode: "cash", amount: "15.000", amount_minor: 15_000, count: 2 },
      {
        currency: "JOD",
        payment_mode: "bank_transfer",
        amount: "20.000",
        amount_minor: 20_000,
        count: 1,
      },
    ]);
  });

  test("refuses a backwards or over-long range and a role without financial reports", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const path = "/api/finance/reports/collections-by-method";
    expect((await get(finance, `${path}?from_date=2026-10-02&to_date=2026-10-01`)).status).toBe(
      400,
    );
    expect((await get(finance, `${path}?from_date=2024-01-01&to_date=2026-01-01`)).status).toBe(
      400,
    );
    const teacher = {
      schoolId: fixture.schoolId,
      userId: fixture.users.INSTRUCTOR.id,
      roles: [ROLES.INSTRUCTOR],
    };
    expect((await get(teacher, `${path}?from_date=2026-10-01&to_date=2026-10-02`)).status).toBe(
      403,
    );
  });
});

describeDb("one student's finance identity", () => {
  test("finance opens a student, withdrawn or not, and another school's is not found", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const student = await createStudent(database!.sql, fixture.schoolId, {
      firstName: "Omar",
      lastName: "Saleh",
    });
    await database!
      .sql`UPDATE app.students SET status = 'withdrawn' WHERE id = ${student.id}::uuid`;

    const response = await get(finance, `/api/finance/students/${student.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: student.id,
      name: "Omar Saleh",
      admission_number: student.admissionNumber,
      status: "withdrawn",
      family_id: null,
      family_name: null,
    });

    expect((await get(finance, `/api/finance/students/${other.students[0]!.id}`)).status).toBe(404);
    const teacher = {
      schoolId: fixture.schoolId,
      userId: fixture.users.INSTRUCTOR.id,
      roles: [ROLES.INSTRUCTOR],
    };
    expect((await get(teacher, `/api/finance/students/${student.id}`)).status).toBe(403);
  });
});
