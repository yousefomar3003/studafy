/**
 * The Student AI line on generated invoices (000238): the invoice items built from planned portions,
 * and -- against a real database with ERPNext stubbed at `fetch` -- the invoice generator putting the
 * portions due by the invoice on it, creating the "Student AI" Fee Category when the site lacks it,
 * and freezing the portions so no later invoice bills them again. The DB part needs
 * TEST_DATABASE_URL pointing at a fully migrated database, like the other billing job tests.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { withSystemTenantTx } from "../../../db/tenant-tx";
import { generateInvoice } from "../invoice.service";
import { STUDENT_AI_FEE_CATEGORY, studentAiInvoiceItems } from "../student-ai-line";

import type { PlannedStudentAiPortion } from "../student-ai-line";
import type { Sql, TransactionSql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const dbTest = test.skipIf(!enabled);

const portion = (overrides: Partial<PlannedStudentAiPortion> = {}): PlannedStudentAiPortion => ({
  id: crypto.randomUUID(),
  amount_minor: 2400n,
  currency_code: "USD",
  minor_unit: 2,
  first_month: "2026-09-01",
  month_count: 4,
  ...overrides,
});

describe("studentAiInvoiceItems", () => {
  test("one Student AI item per portion: qty months, rate the monthly price", () => {
    const first = portion();
    const second = portion({ amount_minor: 600n, first_month: "2027-01-01", month_count: 1 });
    expect(studentAiInvoiceItems([first, second], "usd")).toEqual({
      items: [
        {
          item_code: STUDENT_AI_FEE_CATEGORY,
          qty: 4,
          rate: 6,
          description: "Student AI 2026-09 to 2026-12",
        },
        { item_code: STUDENT_AI_FEE_CATEGORY, qty: 1, rate: 6, description: "Student AI 2027-01" },
      ],
      portionIds: [first.id, second.id],
    });
  });

  test("three-decimal currencies keep their precision", () => {
    const jod = portion({
      amount_minor: 12_750n,
      currency_code: "JOD",
      minor_unit: 3,
      month_count: 3,
    });
    expect(studentAiInvoiceItems([jod], "JOD")!.items[0]!.rate).toBe(4.25);
  });

  test("another currency or a zero amount is left for later, never converted", () => {
    expect(studentAiInvoiceItems([portion({ currency_code: "JOD" })], "USD")).toBeNull();
    expect(studentAiInvoiceItems([portion({ amount_minor: 0n })], "USD")).toBeNull();
    expect(studentAiInvoiceItems([], "USD")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------
// Invoice generation against a real database, ERPNext stubbed
// ---------------------------------------------------------------------------------------------------

let db: Sql | undefined;
const realFetch = globalThis.fetch;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let categoryExists = false;
let invoiceCounter = 0;

function stubErpNext(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path: decodeURIComponent(url.pathname), body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.pathname.startsWith("/api/resource/Fee%20Category/")) {
      return categoryExists ? json(200, { data: { name: "Student AI" } }) : json(404, {});
    }
    if (url.pathname === "/api/resource/Fee%20Category") {
      categoryExists = true;
      return json(200, { data: { name: "Student AI" } });
    }
    if (url.pathname === "/api/resource/Sales%20Invoice") {
      invoiceCounter += 1;
      const items = (body!.items as { qty: number; rate: number }[]) ?? [];
      const total = items.reduce((sum, item) => sum + item.qty * item.rate, 0);
      return json(200, {
        data: {
          ...body,
          name: `ACC-SINV-T-${invoiceCounter}`,
          // Posted on its due date: the test's due dates are in the past.
          posting_date: body!.due_date,
          grand_total: total,
          outstanding_amount: total,
          docstatus: 1,
        },
      });
    }
    return json(404, {});
  }) as typeof fetch;
}

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await db?.end({ timeout: 5 });
});

async function admin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

interface Seed {
  schoolId: string;
  studentId: string;
}

/** A school on ERPNext with a USD and a JOD fee structure, and a student's Student AI line. */
async function seed(): Promise<Seed> {
  const slug = `ai-line-${crypto.randomUUID().slice(0, 8)}`;
  const schoolId = await admin(null, async (tx) => {
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      SELECT ${slug}, 'AI Line School', ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
             (SELECT id FROM app.countries WHERE alpha2_code = 'JO'),
             (SELECT id FROM app.currencies WHERE code = 'USD')
      RETURNING id::text AS id
    `;
    return school!.id;
  });

  const studentId = await admin(schoolId, async (tx) => {
    const email = `${slug}@student.local`;
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${schoolId}::uuid, ${email}, ${email}, 'AI Student', 'active')
      RETURNING id::text AS id
    `;
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${slug}`}, 'AI', 'Student', 'enrolled')
      RETURNING id::text AS id
    `;
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES (${`ai_line_${crypto.randomUUID().slice(0, 8)}`}, 'AI Line', 'student', ${200 + Math.floor(Math.random() * 30_000)})
      RETURNING id::text AS id
    `;
    const [licence] = await tx<{ id: string }[]>`
      INSERT INTO app.school_licenses (
        school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
        created_by, activated_at, ai_programme_version_id, nonpayment_grace_days
      )
      SELECT ${schoolId}::uuid, 'active', '2026-08-01', '2027-07-31', ${plan!.id}::uuid, 30, id,
             ${user!.id}::uuid, '2026-08-01', 'a1000000-0000-4000-8000-000000000001'::uuid, 30
      FROM app.currencies WHERE code = 'USD'
      RETURNING id::text AS id
    `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, ${`AY-${slug}`}, 'AY 2026/27', '2026-09-01', '2027-06-30', 'active')
      RETURNING id::text AS id
    `;
    const [item] = await tx<{ id: string }[]>`
      INSERT INTO app.student_ai_fee_items (
        school_id, student_id, academic_year_id, license_id, currency_id, monthly_price_minor,
        start_month, end_month, months, total_minor
      )
      SELECT ${schoolId}::uuid, ${student!.id}::uuid, ${year!.id}::uuid, ${licence!.id}::uuid, id,
             600, '2026-09-01', '2027-06-01', 10, 6000
      FROM app.currencies WHERE code = 'USD'
      RETURNING id::text AS id
    `;
    for (const [due, first, count] of [
      ["2026-09-01", "2026-09-01", 4],
      ["2027-01-01", "2027-01-01", 3],
      ["2027-04-01", "2027-04-01", 3],
    ] as const) {
      await tx`
        INSERT INTO app.student_ai_fee_portions (
          school_id, item_id, student_id, due_date, first_month, month_count, amount_minor
        ) VALUES (
          ${schoolId}::uuid, ${item!.id}::uuid, ${student!.id}::uuid, ${due}::date,
          ${first}::date, ${count}, ${600 * count}
        )
      `;
    }
    for (const [name, currency] of [
      ["FS-USD", "USD"],
      ["FS-JOD", "JOD"],
    ] as const) {
      await tx`
        INSERT INTO app.fee_structure_cache (
          school_id, currency_id, erpnext_docname, erpnext_status, title, total_amount_minor,
          erpnext_payload, last_synced_at
        )
        SELECT ${schoolId}::uuid, id, ${name}, 'submitted', ${name}, 100000,
               ${tx.json({ components: [{ fee_category: "Tuition", amount: 1000 }] })}::jsonb, now()
        FROM app.currencies WHERE code = ${currency}
      `;
    }
    await tx`
      INSERT INTO app.erpnext_site_configs (school_id, site_name, company_name, company_abbr, status)
      VALUES (${schoolId}::uuid, ${`${slug}.erp.test`}, 'AI Line School', 'ALS', 'completed')
    `;
    return student!.id;
  });

  return { schoolId, studentId };
}

function generate(s: Seed, feeStructure: string, dueDate: string) {
  return withSystemTenantTx(db!, { schoolId: s.schoolId }, (tx) =>
    generateInvoice(
      tx,
      s.schoolId,
      {
        version: 1,
        schoolId: s.schoolId,
        studentId: s.studentId,
        feeStructureErpnextName: feeStructure,
        idempotencyKey: crypto.randomUUID(),
        periodTitle: `Term ${dueDate}`,
        dueDate,
      },
      "http://erpnext.test",
      "test-key",
    ),
  );
}

async function portionStates(s: Seed) {
  const rows = await admin(
    s.schoolId,
    (tx) => tx<{ due_date: string; status: string; erpnext_invoice_docname: string | null }[]>`
      SELECT due_date::text, status, erpnext_invoice_docname
      FROM app.student_ai_fee_portions WHERE school_id = ${s.schoolId}::uuid
      ORDER BY due_date
    `,
  );
  return [...rows];
}

const salesInvoices = () => calls.filter((call) => call.path === "/api/resource/Sales Invoice");

describe("generateInvoice with a Student AI line", () => {
  dbTest("bills the portions due by the invoice once, as Student AI items", async () => {
    const s = await seed();
    calls = [];
    categoryExists = false;
    stubErpNext();

    // A JOD invoice cannot carry the USD line: it stays planned.
    await generate(s, "FS-JOD", "2026-09-15");
    expect(salesInvoices()[0]!.body!.items).toEqual([{ item_code: "Tuition", qty: 1, rate: 1000 }]);
    expect((await portionStates(s)).map((p) => p.status)).toEqual([
      "planned",
      "planned",
      "planned",
    ]);

    // The September invoice carries the September portion (4 months at $6) and only that.
    const first = await generate(s, "FS-USD", "2026-09-15");
    const firstBody = salesInvoices()[1]!.body!;
    expect(firstBody.items).toEqual([
      { item_code: "Tuition", qty: 1, rate: 1000 },
      {
        item_code: "Student AI",
        qty: 4,
        rate: 6,
        description: "Student AI 2026-09 to 2026-12",
      },
    ]);
    // The Fee Category did not exist on the site: it was created first.
    expect(calls.filter((call) => call.path.startsWith("/api/resource/Fee Category"))).toEqual([
      expect.objectContaining({ method: "GET" }),
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({ category_name: "Student AI" }),
      }),
    ]);
    expect(await portionStates(s)).toEqual([
      { due_date: "2026-09-01", status: "invoiced", erpnext_invoice_docname: first.erpnextDocname },
      { due_date: "2027-01-01", status: "planned", erpnext_invoice_docname: null },
      { due_date: "2027-04-01", status: "planned", erpnext_invoice_docname: null },
    ]);

    // A second invoice due in the same period bills nothing more; nor does it touch ERPNext's
    // categories again.
    const categoryCalls = calls.filter((call) =>
      call.path.startsWith("/api/resource/Fee Category"),
    );
    await generate(s, "FS-USD", "2026-10-15");
    expect(salesInvoices()[2]!.body!.items).toEqual([{ item_code: "Tuition", qty: 1, rate: 1000 }]);
    expect(calls.filter((call) => call.path.startsWith("/api/resource/Fee Category"))).toHaveLength(
      categoryCalls.length,
    );

    // The April invoice catches up with every portion due by then (January's and April's).
    await generate(s, "FS-USD", "2027-04-10");
    const april = salesInvoices()[3]!.body!.items as { item_code: string; qty: number }[];
    expect(april.filter((item) => item.item_code === "Student AI").map((item) => item.qty)).toEqual(
      [3, 3],
    );
    expect((await portionStates(s)).map((p) => p.status)).toEqual([
      "invoiced",
      "invoiced",
      "invoiced",
    ]);
  });
});
