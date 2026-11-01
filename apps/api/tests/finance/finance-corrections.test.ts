/**
 * Corrections through the refund maker-checker queue (000172): asking to cancel an invoice,
 * reverse a payment, or write off a balance, and what approval does to the local read models.
 * The maker steps run over HTTP as FINANCE; approval runs the service against a recording ERPNext
 * double, since the harness has no ERPNext site. Requires a live PostgreSQL instance, gated on
 * TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/finance-corrections.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { approveRefund, rejectRefund } from "../../src/modules/finance/refunds/service";
import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TenantErpNext } from "../../src/modules/finance/client/tenant-client";
import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

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

interface Refund {
  id: string;
  kind: string;
  status: string;
  amount: string;
  erpnext_invoice_id: string;
  payment_entry_id: string | null;
  reason_code: string;
}

async function financeOf(fixture: TenantFixture): Promise<Actor> {
  const user = await createUser(database!.sql, fixture.schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, fixture.schoolId, user.id, ROLES.FINANCE);
  return { schoolId: fixture.schoolId, userId: user.id, roles: [ROLES.FINANCE] };
}

async function currencyId(): Promise<string> {
  const [row] = await database!.sql<
    { id: string }[]
  >`SELECT id FROM app.currencies WHERE code = 'JOD'`;
  return row!.id;
}

async function invoice(
  fixture: TenantFixture,
  docname: string,
  amounts: { total: number; outstanding?: number; status?: string },
): Promise<string> {
  const [row] = await database!.sql<{ id: string }[]>`
    INSERT INTO app.invoice_cache
      (school_id, student_id, currency_id, erpnext_docname, erpnext_status,
       total_amount_minor, outstanding_amount_minor, issued_date, last_synced_at)
    VALUES (${fixture.schoolId}::uuid, ${fixture.students[0]!.id}::uuid, ${await currencyId()}::uuid,
            ${docname}, ${amounts.status ?? "submitted"}, ${amounts.total},
            ${amounts.outstanding ?? amounts.total}, '2026-09-01', now())
    RETURNING id
  `;
  return row!.id;
}

async function payment(fixture: TenantFixture, docname: string, invoiceDoc: string, minor: number) {
  const [row] = await database!.sql<{ id: string }[]>`
    INSERT INTO app.payment_cache
      (school_id, student_id, currency_id, erpnext_docname, erpnext_status, amount_minor,
       payment_date, last_synced_at, erpnext_invoice_id, payment_mode, status, confirmed_at)
    VALUES (${fixture.schoolId}::uuid, ${fixture.students[0]!.id}::uuid, ${await currencyId()}::uuid,
            ${docname}, 'submitted', ${minor}, '2026-09-05', now(), ${invoiceDoc}, 'cash',
            'confirmed', now())
    RETURNING id
  `;
  return row!.id;
}

function post(actor: Actor, path: string, body: unknown, headers: Record<string, string> = {}) {
  return authenticatedRequest(harness!, "POST", path, actor, {
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** An ERPNext double that records every POST and answers like frappe.client.cancel. */
function recordingErpNext(): { client: TenantErpNext; calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  const client = {
    get: () => Promise.reject(new Error("not used")),
    post: (path: string, body: unknown) => {
      calls.push({ path, body });
      return Promise.resolve({
        data: { message: { docstatus: 2 } },
        status: 200,
        headers: new Headers(),
      });
    },
    put: () => Promise.reject(new Error("not used")),
  } as unknown as TenantErpNext;
  return { client, calls };
}

/** The approver's own tenant transaction, as withTenantTx opens it. */
async function asApprover<T>(fixture: TenantFixture, fn: (tx: TransactionSql) => Promise<T>) {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx`
      SELECT set_config('role', 'studafy_app', true),
             set_config('app.school_id', ${fixture.schoolId}, true),
             set_config('app.user_id', ${fixture.users.ORG_ADMIN.id}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

async function invoiceRow(schoolId: string, docname: string) {
  const [row] = await database!.sql<{ erpnext_status: string; outstanding: number }[]>`
    SELECT erpnext_status, outstanding_amount_minor::int AS outstanding
    FROM app.invoice_cache WHERE school_id = ${schoolId}::uuid AND erpnext_docname = ${docname}
  `;
  return row!;
}

describeDb("cancelling an invoice", () => {
  test("finance asks, an admin approves, ERPNext cancels and the invoice is no longer owed", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const id = await invoice(fixture, "INV-CANCEL", { total: 150_000 });

    const asked = await post(finance, `/api/finance/invoices/${id}/cancellation`, {
      reason_notes: "Billed the wrong fee structure",
    });
    expect(asked.status).toBe(201);
    const request = (await asked.json()) as Refund;
    expect(request).toMatchObject({
      kind: "invoice_cancellation",
      status: "pending_approval",
      amount: "150.000",
      erpnext_invoice_id: "INV-CANCEL",
      reason_code: "error_correction",
    });
    // Asking changes nothing yet.
    expect(await invoiceRow(fixture.schoolId, "INV-CANCEL")).toEqual({
      erpnext_status: "submitted",
      outstanding: 150_000,
    });

    const erpnext = recordingErpNext();
    const approved = await asApprover(fixture, (tx) =>
      approveRefund(tx, erpnext.client, fixture.schoolId, fixture.users.ORG_ADMIN.id, request.id),
    );
    expect(approved.status).toBe("completed");
    expect(erpnext.calls).toEqual([
      {
        path: "/api/method/frappe.client.cancel",
        body: { doctype: "Sales Invoice", name: "INV-CANCEL" },
      },
    ]);
    expect(await invoiceRow(fixture.schoolId, "INV-CANCEL")).toEqual({
      erpnext_status: "cancelled",
      outstanding: 0,
    });

    // Done once: a second ask is refused.
    const again = await post(finance, `/api/finance/invoices/${id}/cancellation`, {
      reason_notes: "Again",
    });
    expect(again.status).toBe(409);
  });

  test("an invoice with money against it is refused; a credit note is the way to correct it", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const partPaid = await invoice(fixture, "INV-PART", { total: 100_000, outstanding: 40_000 });
    const withPayment = await invoice(fixture, "INV-PAY", { total: 100_000 });
    await payment(fixture, "PE-PAY", "INV-PAY", 100_000);
    const draft = await invoice(fixture, "INV-DRAFT", { total: 100_000, status: "draft" });

    for (const id of [partPaid, withPayment, draft]) {
      const response = await post(finance, `/api/finance/invoices/${id}/cancellation`, {
        reason_notes: "Mistake",
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("INVOICE_NOT_CANCELLABLE");
    }
  });

  test("two people cannot ask twice, the maker cannot approve, and a rejection frees the invoice", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const id = await invoice(fixture, "INV-TWICE", { total: 50_000 });

    const first = (await (
      await post(finance, `/api/finance/invoices/${id}/cancellation`, { reason_notes: "One" })
    ).json()) as Refund;
    const second = await post(finance, `/api/finance/invoices/${id}/cancellation`, {
      reason_notes: "Two",
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("ADJUSTMENT_ALREADY_REQUESTED");

    // FINANCE holds no billing:refund, so it cannot approve its own ask.
    const selfApprove = await post(finance, `/api/finance/refunds/${first.id}/approve`, {});
    expect(selfApprove.status).toBe(403);

    await asApprover(fixture, (tx) =>
      rejectRefund(tx, fixture.schoolId, fixture.users.ORG_ADMIN.id, first.id, "Not a mistake"),
    );
    const afterReject = await post(finance, `/api/finance/invoices/${id}/cancellation`, {
      reason_notes: "Three",
    });
    expect(afterReject.status).toBe(201);
  });

  test("a role without billing:update cannot ask, and another school's invoice is not found", async () => {
    const fixture = await createFullTenant(database!.sql);
    const other = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const id = await invoice(fixture, "INV-GUARD", { total: 50_000 });
    const foreign = await invoice(other, "INV-FOREIGN", { total: 50_000 });

    const teacher = await post(
      {
        schoolId: fixture.schoolId,
        userId: fixture.users.INSTRUCTOR.id,
        roles: [ROLES.INSTRUCTOR],
      },
      `/api/finance/invoices/${id}/cancellation`,
      { reason_notes: "No" },
    );
    expect(teacher.status).toBe(403);

    const elsewhere = await post(finance, `/api/finance/invoices/${foreign}/cancellation`, {
      reason_notes: "No",
    });
    expect(elsewhere.status).toBe(404);
  });
});

describeDb("reversing a payment", () => {
  test("approval cancels the Payment Entry, marks it reversed and makes the invoice owed again", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    await invoice(fixture, "INV-REV", { total: 100_000, outstanding: 30_000 });
    const paymentId = await payment(fixture, "PE-REV", "INV-REV", 70_000);

    const asked = await post(finance, `/api/finance/payments/${paymentId}/reversal`, {
      reason_code: "error_correction",
      reason_notes: "Recorded against the wrong family",
    });
    expect(asked.status).toBe(201);
    const request = (await asked.json()) as Refund;
    expect(request).toMatchObject({
      kind: "payment_reversal",
      payment_entry_id: paymentId,
      amount: "70.000",
    });

    const erpnext = recordingErpNext();
    await asApprover(fixture, (tx) =>
      approveRefund(tx, erpnext.client, fixture.schoolId, fixture.users.ORG_ADMIN.id, request.id),
    );
    expect(erpnext.calls).toEqual([
      {
        path: "/api/method/frappe.client.cancel",
        body: { doctype: "Payment Entry", name: "PE-REV" },
      },
    ]);

    const [row] = await database!.sql<{ status: string; confirmed: boolean }[]>`
      SELECT status, confirmed_at IS NOT NULL AS confirmed FROM app.payment_cache WHERE id = ${paymentId}::uuid
    `;
    expect(row).toEqual({ status: "reversed", confirmed: true });
    expect(await invoiceRow(fixture.schoolId, "INV-REV")).toEqual({
      erpnext_status: "submitted",
      outstanding: 100_000,
    });

    const again = await post(finance, `/api/finance/payments/${paymentId}/reversal`, {
      reason_notes: "Again",
    });
    expect(again.status).toBe(409);
  });

  test("a payment that is not confirmed cannot be reversed", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    const [pending] = await database!.sql<{ id: string }[]>`
      INSERT INTO app.payment_cache
        (school_id, student_id, currency_id, erpnext_docname, erpnext_status, amount_minor,
         payment_date, last_synced_at, erpnext_invoice_id, payment_mode, status)
      VALUES (${fixture.schoolId}::uuid, ${fixture.students[0]!.id}::uuid, ${await currencyId()}::uuid,
              'PE-PENDING', 'draft', 1000, '2026-09-05', now(), 'INV-X', 'cash', 'pending')
      RETURNING id
    `;
    const response = await post(finance, `/api/finance/payments/${pending!.id}/reversal`, {
      reason_notes: "No",
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("PAYMENT_NOT_REVERSIBLE");
  });
});

describeDb("writing off a balance", () => {
  test("a write-off may clear at most what is still owed", async () => {
    const fixture = await createFullTenant(database!.sql);
    const finance = await financeOf(fixture);
    await invoice(fixture, "INV-WO", { total: 100_000, outstanding: 20_000 });
    const body = (amount: number) => ({
      student_id: fixture.students[0]!.id,
      erpnext_invoice_id: "INV-WO",
      amount,
      currency: "JOD",
      reason_code: "write_off",
      reason_notes: "Family left the country",
    });

    const tooMuch = await post(finance, "/api/finance/refunds/initiate", body(25), {
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(tooMuch.status).toBe(400);
    expect(((await tooMuch.json()) as { code: string }).code).toBe("WRITE_OFF_EXCEEDS_OUTSTANDING");

    const exact = await post(finance, "/api/finance/refunds/initiate", body(20), {
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(exact.status).toBe(201);
    expect((await exact.json()) as Refund).toMatchObject({
      kind: "credit_note",
      reason_code: "write_off",
      status: "pending_approval",
    });
  });
});
