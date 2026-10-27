/**
 * Family finance over HTTP: the sibling discount rule, the families list and profile, reminders,
 * statements, receipts, and the checks a family payment makes before it reaches ERPNext.
 *
 * Runs with ERPNext unconfigured. Everything here reads the local finance read models, which the
 * test seeds directly; the one path that would post to ERPNext (a family payment that passes its
 * checks) is covered only up to the checks.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */

import { ERROR_CODES, NOTIFICATION_TYPES, ROLES } from "@studafy/constants";
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
} from "../../../../tests/harness";
import { allocateOldestFirst, validateAllocations } from "../family-accounts/service";

import type { TenantFixture, TestApp, TestDatabase } from "../../../../tests/harness";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let fixture: TenantFixture | undefined;
let familyId: string | undefined;
let financeUserId: string | undefined;
let elderId: string | undefined;
let youngerId: string | undefined;
let paymentId: string | undefined;

const savedErpNextEnv = { url: process.env.ERPNEXT_API_URL, key: process.env.ERPNEXT_API_KEY };

beforeAll(async () => {
  if (!integrationEnabled) return;
  delete process.env.ERPNEXT_API_URL;
  delete process.env.ERPNEXT_API_KEY;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  fixture = await createFullTenant(database.sql);

  const finance = await createUser(database.sql, fixture.schoolId, { displayName: "Finance" });
  await assignRole(database.sql, fixture.schoolId, finance.id, ROLES.FINANCE);
  financeUserId = finance.id;

  elderId = fixture.students[0]!.id;
  youngerId = (
    await createStudent(database.sql, fixture.schoolId, { firstName: "Younger", lastName: "Sib" })
  ).id;

  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture!.schoolId}, true)`;
    await tx`UPDATE app.students SET date_of_birth = '2010-01-01' WHERE id = ${elderId!}::uuid`;
    await tx`UPDATE app.students SET date_of_birth = '2013-01-01' WHERE id = ${youngerId!}::uuid`;

    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${fixture!.schoolId}::uuid, 'Sibling family', ${fixture!.users.PARENT.id}::uuid)
      RETURNING id
    `;
    familyId = family!.id;
    for (const studentId of [elderId!, youngerId!]) {
      await tx`
        INSERT INTO app.parent_child_links
          (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (${fixture!.schoolId}::uuid, ${familyId}::uuid, ${fixture!.users.PARENT.id}::uuid,
                ${studentId}::uuid, 'mother')
      `;
    }

    // Elder: 600 of 1200 still owed, past due. Younger: 450 owed, not yet due.
    const [jod] = await tx<{ id: string }[]>`SELECT id FROM app.currencies WHERE code = 'JOD'`;
    const invoices: [string, string, number, number, string][] = [
      ["SINV-ELDER", elderId!, 1_200_000, 600_000, "2026-01-31"],
      ["SINV-YOUNGER", youngerId!, 450_000, 450_000, "2099-01-31"],
    ];
    for (const [docname, studentId, total, outstanding, due] of invoices) {
      await tx`
        INSERT INTO app.invoice_cache (
          school_id, student_id, currency_id, erpnext_docname, erpnext_status,
          total_amount_minor, outstanding_amount_minor, issued_date, due_date, erpnext_payload,
          last_synced_at
        ) VALUES (
          ${fixture!.schoolId}::uuid, ${studentId}::uuid, ${jod!.id}::uuid, ${docname}, 'submitted',
          ${total}, ${outstanding}, '2026-01-01', ${due}::date, ${tx.json({})}, CURRENT_TIMESTAMP
        )
      `;
    }
    const [payment] = await tx<{ id: string }[]>`
      INSERT INTO app.payment_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status, amount_minor,
        payment_date, erpnext_invoice_id, status, confirmed_at, erpnext_payload, last_synced_at
      ) VALUES (
        ${fixture!.schoolId}::uuid, ${elderId!}::uuid, ${jod!.id}::uuid, 'PAY-ELDER', 'submitted',
        600000, '2026-02-01', 'SINV-ELDER', 'confirmed', CURRENT_TIMESTAMP, ${tx.json({})},
        CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    paymentId = payment!.id;
  });

  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
  if (savedErpNextEnv.url !== undefined) process.env.ERPNEXT_API_URL = savedErpNextEnv.url;
  if (savedErpNextEnv.key !== undefined) process.env.ERPNEXT_API_KEY = savedErpNextEnv.key;
});

const as = (userId: string, role: (typeof ROLES)[keyof typeof ROLES]) => ({
  schoolId: fixture!.schoolId,
  userId,
  roles: [role],
});
const asFinance = () => as(financeUserId!, ROLES.FINANCE);
const asAdmin = () => as(fixture!.users.ORG_ADMIN.id, ROLES.ORG_ADMIN);
const asParent = () => as(fixture!.users.PARENT.id, ROLES.PARENT);

function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  };
}

describe("family payment split", () => {
  const open = [
    { invoice_id: "OLD", student_id: "a", outstanding_minor: 600n },
    { invoice_id: "NEW", student_id: "b", outstanding_minor: 450n },
  ];

  test("pays the oldest invoice first and stops when the money runs out", () => {
    expect(allocateOldestFirst(800n, open)).toEqual([
      { invoice_id: "OLD", student_id: "a", amount_minor: 600n },
      { invoice_id: "NEW", student_id: "b", amount_minor: 200n },
    ]);
  });

  test("refuses more than the family owes", () => {
    expect(() => allocateOldestFirst(1_051n, open)).toThrow(/more than the family owes/);
  });

  test("checks a hand-made split", () => {
    const split = (rows: { invoice_id: string; amount_minor: bigint }[], amount: bigint) =>
      validateAllocations(amount, rows, open);
    expect(split([{ invoice_id: "NEW", amount_minor: 450n }], 450n)).toHaveLength(1);
    expect(() => split([{ invoice_id: "NOT-OURS", amount_minor: 1n }], 1n)).toThrow(/not an open/);
    expect(() => split([{ invoice_id: "NEW", amount_minor: 451n }], 451n)).toThrow(/owes less/);
    expect(() => split([{ invoice_id: "OLD", amount_minor: 100n }], 200n)).toThrow(/add up/);
  });
});

describeDb("family finance over HTTP", () => {
  test("the sibling rule is the school admin's to change", async () => {
    const body = { is_enabled: true, tiers: [{ child_position: 2, percentage: 10 }] };
    const denied = await authenticatedRequest(
      harness!,
      "PUT",
      "/api/finance/sibling-discount",
      asFinance(),
      json(body),
    );
    expect(denied.status).toBe(403);

    const saved = await authenticatedRequest(
      harness!,
      "PUT",
      "/api/finance/sibling-discount",
      asAdmin(),
      json(body),
    );
    expect(saved.status).toBe(200);
    const rule = (await saved.json()) as { is_enabled: boolean; discounted_children: number };
    expect(rule.is_enabled).toBe(true);
    // The younger child is second; the elder pays full fees.
    expect(rule.discounted_children).toBe(1);

    const read = await authenticatedRequest(
      harness!,
      "GET",
      "/api/finance/sibling-discount",
      asFinance(),
    );
    expect(read.status).toBe(200);
  });

  test("lists sibling families with ranking, discount and balances", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      "/api/finance/families?min_children=2&balance=overdue",
      asFinance(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: number;
      families: {
        id: string;
        children: {
          student_id: string;
          child_position: number;
          sibling_discount_percentage: number | null;
        }[];
        balances: { currency: string; outstanding: string; overdue: string }[];
        overdue_invoice_count: number;
        guardians: { user_id: string; is_primary: boolean }[];
      }[];
    };
    expect(body.total).toBe(1);
    const family = body.families[0]!;
    expect(family.id).toBe(familyId!);
    expect(family.children.map((child) => [child.student_id, child.child_position])).toEqual([
      [elderId!, 1],
      [youngerId!, 2],
    ]);
    expect(family.children.map((child) => child.sibling_discount_percentage)).toEqual([null, 10]);
    expect(family.balances).toEqual([
      expect.objectContaining({ currency: "JOD", outstanding: "1050.000", overdue: "600.000" }),
    ]);
    expect(family.overdue_invoice_count).toBe(1);
    expect(family.guardians).toEqual([
      expect.objectContaining({ user_id: fixture!.users.PARENT.id, is_primary: true }),
    ]);
  });

  test("finance staff can open any family's household view", async () => {
    // Staff hold no student:read, so this read must not depend on seeing app.students as FINANCE.
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/finance/families/${familyId}`,
      asFinance(),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      students: { student_id: string; invoices: { id: string }[] }[];
    };
    expect(body.students.map((student) => student.student_id).sort()).toEqual(
      [elderId!, youngerId!].sort(),
    );
    expect(body.students.every((student) => student.invoices.length === 1)).toBe(true);
  });

  test("a parent cannot list families", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      "/api/finance/families",
      asParent(),
    );
    expect(response.status).toBe(403);
  });

  test("a reminder reaches the guardian once a day", async () => {
    const path = `/api/finance/families/${familyId}/reminders`;
    const first = await authenticatedRequest(harness!, "POST", path, asFinance());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(
      expect.objectContaining({ status: "sent", delivered: 1, suppressed: 0 }),
    );

    const again = await authenticatedRequest(harness!, "POST", path, asFinance());
    expect(((await again.json()) as { status: string }).status).toBe("recently_reminded");

    const [notification] = await database!.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${fixture!.schoolId}, true)`;
      return tx<{ title: string }[]>`
        SELECT title FROM app.notifications
        WHERE user_id = ${fixture!.users.PARENT.id}::uuid
          AND notification_type = ${NOTIFICATION_TYPES.FEE_PAYMENT_REMINDER}::app.notification_type
      `;
    });
    expect(notification?.title).toContain("600.000 JOD");
  });

  test("a statement is sent and the profile shows the message history", async () => {
    const sent = await authenticatedRequest(
      harness!,
      "POST",
      `/api/finance/families/${familyId}/statements`,
      asFinance(),
    );
    expect(((await sent.json()) as { status: string }).status).toBe("sent");

    const profile = await authenticatedRequest(
      harness!,
      "GET",
      `/api/finance/families/${familyId}/profile`,
      asFinance(),
    );
    const body = (await profile.json()) as {
      communications: { kind: string; delivered: boolean; sent_by: string | null }[];
      last_reminder_at: string | null;
    };
    expect(body.communications.map((row) => row.kind).sort()).toEqual([
      "payment_reminder",
      "statement",
    ]);
    expect(body.communications.every((row) => row.sent_by === financeUserId)).toBe(true);
    expect(body.last_reminder_at).not.toBeNull();
  });

  test("a family payment larger than the balance is refused before ERPNext", async () => {
    const response = await authenticatedRequest(
      harness!,
      "POST",
      `/api/finance/families/${familyId}/payments`,
      asFinance(),
      json(
        { amount: 2000, currency: "JOD", payment_mode: "cash" },
        { "Idempotency-Key": crypto.randomUUID() },
      ),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      ERROR_CODES.FAMILY_PAYMENT_EXCEEDS_BALANCE,
    );
  });

  test("a split naming another family's invoice is refused", async () => {
    const response = await authenticatedRequest(
      harness!,
      "POST",
      `/api/finance/families/${familyId}/payments`,
      asFinance(),
      json(
        {
          amount: 10,
          currency: "JOD",
          payment_mode: "cash",
          allocations: [{ invoice_id: "SOMEONE-ELSES", amount: 10 }],
        },
        { "Idempotency-Key": crypto.randomUUID() },
      ),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(
      ERROR_CODES.FAMILY_PAYMENT_ALLOCATION_INVALID,
    );
  });

  test("a receipt is a PDF for finance and the child's guardian, and hidden from others", async () => {
    const path = `/api/finance/payments/${paymentId}/receipt`;
    for (const reader of [asFinance(), asParent()]) {
      const response = await authenticatedRequest(harness!, "GET", path, reader);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    }

    const stranger = await createUser(database!.sql, fixture!.schoolId, { displayName: "Other" });
    await assignRole(database!.sql, fixture!.schoolId, stranger.id, ROLES.PARENT);
    const hidden = await authenticatedRequest(harness!, "GET", path, as(stranger.id, ROLES.PARENT));
    expect(hidden.status).toBe(404);
  });

  test("payment responses point at the Studafy receipt", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/finance/families/${familyId}`,
      asParent(),
    );
    const body = (await response.json()) as {
      students: { payments: { id: string; receipt_url: string | null }[] }[];
    };
    const payment = body.students.flatMap((student) => student.payments)[0]!;
    expect(payment.receipt_url).toBe(`/api/finance/payments/${paymentId}/receipt`);
  });
});
