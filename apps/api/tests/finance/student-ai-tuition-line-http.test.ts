/**
 * The Student AI line on tuition (migration 000238) against a real database: the amount, months and
 * spread for 10- and 8-month academic years, a late opt-in, a released seat stopping from the next
 * month, a transferred seat, the auto-billing switch, idempotent reconciliation, invoiced portions
 * being frozen, the parent's line in the family financial view, and that parents see only their own
 * children's lines (in their school only).
 *
 * Opt-ins are phase 2's app.ai_optins rows (tests/licensing/programme-optins.ts writes them as the
 * service does), read through src/modules/finance/student-ai/opt-ins.ts.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/finance/student-ai-tuition-line-http.test.ts
 */

import { ROLES } from "@studafy/constants";
import { aiOptInPeriod, firstOfNextMonth } from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { syncStudentAiFeeItems } from "../../src/modules/finance/student-ai/service";
import {
  assignRole,
  authenticatedRequest,
  createAcademicYear,
  createFullTenant,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";
import {
  insertOptIn,
  insertOptInWindow,
  releaseTestOptIn,
  transferTestOptIn,
} from "../licensing/programme-optins";

import type { StudentRecord, TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let studentTier = "";

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
  await admin(null, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES (${`student_ai_${crypto.randomUUID().slice(0, 8)}`}, 'Student AI', 'student', 4242)
      RETURNING id::text AS id
    `;
    studentTier = plan!.id;
  });
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

async function admin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId ?? ""}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** As the runtime role, armed for a school and a user: what RLS lets that user read. */
async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`
      SELECT set_config('app.school_id', ${schoolId}, true),
             set_config('app.user_id', ${userId}, true)
    `;
    result = await fn(tx);
  });
  return result as T;
}

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

interface Scenario {
  fixture: TenantFixture;
  yearId: string;
  year: { startsOn: string; endsOn: string };
  windowId: string;
  licenceId: string;
  familyId: string;
  student: StudentRecord;
  finance: Actor;
  parent: Actor;
}

/** A school with one academic year, an active licence, a family and a finance user. */
async function scenario(year: { startsOn: string; endsOn: string }): Promise<Scenario> {
  const fixture = await createFullTenant(database!.sql);
  const schoolId = fixture.schoolId;
  // One active year per school: the fixture's (this calendar year) steps aside for the year under
  // test, which the opt-ins below are for.
  await admin(
    schoolId,
    (tx) => tx`
      UPDATE app.academic_years SET status = 'planned' WHERE id = ${fixture.academicYear.id}::uuid
    `,
  );
  const dated = await createAcademicYear(database!.sql, schoolId, {
    code: `AY-AI-${crypto.randomUUID().slice(0, 6)}`,
    ...year,
  });
  const financeUser = await createUser(database!.sql, schoolId, {
    email: `finance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(database!.sql, schoolId, financeUser.id, ROLES.FINANCE);
  const student = fixture.students[0]!;

  const { licenceId, familyId, windowId } = await admin(schoolId, async (tx) => {
    const [licence] = await tx<{ id: string }[]>`
      INSERT INTO app.school_licenses (
        school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
        created_by, activated_at, ai_programme_version_id, nonpayment_grace_days
      )
      SELECT ${schoolId}::uuid, 'active', '2026-08-01', '2027-07-31', ${studentTier}::uuid, 50,
             id, ${fixture.users.ORG_ADMIN.id}::uuid, '2026-08-01',
             'a1000000-0000-4000-8000-000000000001'::uuid, 30
      FROM app.currencies WHERE code = 'USD'
      RETURNING id::text AS id
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'Student AI family', ${fixture.users.PARENT.id}::uuid)
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${fixture.users.PARENT.id}::uuid,
              ${student.id}::uuid, 'mother')
    `;
    // The licence is in the Student AI programme: the school opened an opt-in window (phase 2).
    const windowId = await insertOptInWindow(tx, {
      schoolId,
      licenseId: licence!.id,
      academicYearId: dated.id,
      openedBy: fixture.users.ORG_ADMIN.id,
    });
    return { licenceId: licence!.id, familyId: family!.id, windowId };
  });

  return {
    fixture,
    yearId: dated.id,
    year,
    windowId,
    licenceId,
    familyId,
    student,
    finance: { schoolId, userId: financeUser.id, roles: [ROLES.FINANCE] },
    parent: { schoolId, userId: fixture.users.PARENT.id, roles: [ROLES.PARENT] },
  };
}

/**
 * The student opts in on `at` (phase 2's app.ai_optins, recorded on the parent's behalf): the months
 * aiOptInPeriod gives for that day, at `monthlyPriceMinor` a month (the default parent price, $6).
 */
function optIn(
  s: Scenario,
  student: StudentRecord,
  at: string,
  monthlyPriceMinor = 600,
): Promise<string> {
  const period = aiOptInPeriod(s.year, at.slice(0, 10))!;
  return admin(s.fixture.schoolId, (tx) =>
    insertOptIn(tx, {
      schoolId: s.fixture.schoolId,
      licenseId: s.licenceId,
      academicYearId: s.yearId,
      windowId: s.windowId,
      studentId: student.id,
      recordedBy: s.fixture.users.ORG_ADMIN.id,
      startMonth: period.startMonth,
      endMonth: period.endMonth,
      monthlyPriceMinor,
      optedInAt: at,
    }),
  );
}

/** The student leaves on `at`: the opt-in is released from the next month (as releaseOptIn does). */
function release(s: Scenario, optInId: string, at: string): Promise<unknown> {
  return admin(s.fixture.schoolId, (tx) =>
    releaseTestOptIn(
      tx,
      optInId,
      s.fixture.users.ORG_ADMIN.id,
      firstOfNextMonth(at.slice(0, 10)),
      at,
    ),
  );
}

function instalments(s: Scenario, student: StudentRecord, dueDates: string[]): Promise<unknown> {
  return admin(s.fixture.schoolId, async (tx) => {
    for (const dueDate of dueDates) {
      await tx`
        INSERT INTO app.installment_cache (
          school_id, erpnext_fee_schedule_id, student_id, due_date, total_amount_minor,
          paid_amount_minor, outstanding_amount_minor, currency_id, synced_at
        )
        SELECT ${s.fixture.schoolId}::uuid, ${`FSCH-${crypto.randomUUID().slice(0, 8)}`},
               ${student.id}::uuid, ${dueDate}::date, 100000, 0, 100000, id, now()
        FROM app.currencies WHERE code = 'USD'
      `;
    }
  });
}

interface PortionView {
  id: string;
  due_date: string;
  first_month: string;
  month_count: number;
  amount_minor: number;
  status: string;
}

function portionsOf(s: Scenario, student: StudentRecord): Promise<PortionView[]> {
  return admin(
    s.fixture.schoolId,
    (tx) => tx<PortionView[]>`
      SELECT id::text, due_date::text, first_month::text, month_count, amount_minor::int, status
      FROM app.student_ai_fee_portions
      WHERE school_id = ${s.fixture.schoolId}::uuid AND student_id = ${student.id}::uuid
      ORDER BY due_date, first_month
    `,
  );
}

/** What ERPNext invoicing does to a portion (the billing worker): freeze it. */
function invoice(s: Scenario, portionId: string, docname: string): Promise<unknown> {
  return admin(
    s.fixture.schoolId,
    (tx) => tx`
      UPDATE app.student_ai_fee_portions
      SET status = 'invoiced', erpnext_invoice_docname = ${docname}, invoiced_at = now()
      WHERE id = ${portionId}::uuid
    `,
  );
}

async function sync(s: Scenario) {
  const response = await authenticatedRequest(
    harness!,
    "POST",
    "/api/finance/student-ai/sync",
    s.finance,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, number>;
}

interface LineView {
  academic_year_id: string;
  academic_year_name: string;
  monthly_price: string;
  monthly_price_minor: number;
  months: number;
  total: string;
  total_minor: number;
  currency: string;
  start_month: string;
  end_month: string;
  late_start: boolean;
  stopped_from: string | null;
  status: string;
  billing: string;
  invoiced: string;
  planned: string;
}

/** The parent's line in the family view: never an amount (the school tells parents the price). */
type ParentLineView = Pick<
  LineView,
  | "academic_year_id"
  | "academic_year_name"
  | "start_month"
  | "end_month"
  | "late_start"
  | "stopped_from"
  | "status"
>;

async function parentLines(s: Scenario, parent: Actor = s.parent) {
  const response = await authenticatedRequest(
    harness!,
    "GET",
    `/api/finance/families/${s.familyId}`,
    parent,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      students: { student_id: string; student_ai_lines: ParentLineView[] }[];
    },
  };
}

/**
 * The student's line as school finance lists it (with its amounts), after checking the parent's
 * family view shows the same line with no amount, price, total or currency.
 */
async function lineOf(s: Scenario, student: StudentRecord = s.student): Promise<LineView> {
  const list = await authenticatedRequest(
    harness!,
    "GET",
    "/api/finance/student-ai/lines",
    s.finance,
  );
  expect(list.status).toBe(200);
  const lines = (
    (await list.json()) as { lines: (LineView & { student_id: string })[] }
  ).lines.filter((entry) => entry.student_id === student.id);
  expect(lines).toHaveLength(1);
  const line = lines[0]!;

  const { status, body } = await parentLines(s);
  expect(status).toBe(200);
  const section = body.students.find((entry) => entry.student_id === student.id)!;
  expect(section.student_ai_lines).toEqual([
    {
      academic_year_id: line.academic_year_id,
      academic_year_name: line.academic_year_name,
      start_month: line.start_month,
      end_month: line.end_month,
      late_start: line.late_start,
      stopped_from: line.stopped_from,
      status: line.status,
    },
  ]);
  return line;
}

const TEN_MONTHS = { startsOn: "2026-09-01", endsOn: "2027-06-30" };
const EIGHT_MONTHS = { startsOn: "2026-09-01", endsOn: "2027-04-30" };

describeDb("the Student AI line on tuition", () => {
  test("10-month year: $6 x 10 = $60, spread 4 + 3 + 3 over the instalments", async () => {
    const s = await scenario(TEN_MONTHS);
    await instalments(s, s.student, ["2026-09-01", "2027-01-01", "2027-04-01"]);
    await optIn(s, s.student, "2026-09-03T08:00:00Z");

    const summary = await sync(s);
    expect(summary).toMatchObject({ students: 1, created: 1 });

    const line = await lineOf(s);
    expect(line).toMatchObject({
      monthly_price: "6.00",
      monthly_price_minor: 600,
      months: 10,
      total: "60.00",
      total_minor: 6000,
      currency: "USD",
      start_month: "2026-09",
      end_month: "2027-06",
      late_start: false,
      stopped_from: null,
      status: "active",
      billing: "auto",
      invoiced: "0.00",
      planned: "60.00",
    });
    // Finance's line never carries the licence price or the revenue share either.
    expect(JSON.stringify(line)).not.toContain("license");
    expect(JSON.stringify(line)).not.toContain("share");

    const portions = await portionsOf(s, s.student);
    expect(portions.map((p) => [p.due_date, p.month_count, p.amount_minor])).toEqual([
      ["2026-09-01", 4, 2400],
      ["2027-01-01", 3, 1800],
      ["2027-04-01", 3, 1800],
    ]);
  });

  test("8-month year: $6 x 8 = $48; months follow the school's year", async () => {
    const s = await scenario(EIGHT_MONTHS);
    await instalments(s, s.student, ["2026-09-05", "2026-12-05", "2027-03-05"]);
    await optIn(s, s.student, "2026-09-01T08:00:00Z");
    await sync(s);

    const line = await lineOf(s);
    expect(line).toMatchObject({ months: 8, total: "48.00", end_month: "2027-04" });
    const portions = await portionsOf(s, s.student);
    expect(portions.map((p) => p.month_count)).toEqual([3, 3, 2]);
    expect(portions.reduce((sum, p) => sum + p.amount_minor, 0)).toBe(4800);
  });

  test("a late opt-in pays the remaining months only, from its start month", async () => {
    const s = await scenario(TEN_MONTHS);
    await instalments(s, s.student, ["2026-09-01", "2027-01-01", "2027-04-01"]);
    await optIn(s, s.student, "2027-02-10T08:00:00Z");
    await sync(s);

    const line = await lineOf(s);
    expect(line).toMatchObject({
      months: 5,
      total: "30.00",
      start_month: "2027-02",
      late_start: true,
    });
    const portions = await portionsOf(s, s.student);
    expect(portions.map((p) => [p.due_date, p.first_month, p.month_count])).toEqual([
      ["2027-04-01", "2027-02-01", 5],
    ]);
  });

  test("reconciliation is idempotent: repeated syncs change nothing", async () => {
    const s = await scenario(TEN_MONTHS);
    await instalments(s, s.student, ["2026-09-01", "2027-01-01"]);
    await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await sync(s);
    const before = await portionsOf(s, s.student);

    const again = await sync(s);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    for (let i = 0; i < 2; i += 1) {
      const direct = await admin(s.fixture.schoolId, (tx) =>
        syncStudentAiFeeItems(tx, s.fixture.schoolId, s.student.id),
      );
      expect(direct.items.map((item) => item.action)).toEqual(["unchanged"]);
    }
    expect(await portionsOf(s, s.student)).toEqual(before);
  });

  test("a released seat stops from the next month; invoiced portions are not changed", async () => {
    const s = await scenario(TEN_MONTHS);
    await instalments(s, s.student, ["2026-09-01", "2027-01-01", "2027-04-01"]);
    const optInId = await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await sync(s);
    const [september] = await portionsOf(s, s.student);
    await invoice(s, september!.id, "ACC-SINV-2026-00001");

    // Leaves on 10 February: charged to the end of February, nothing from March.
    await release(s, optInId, "2027-02-10T08:00:00Z");
    await sync(s);

    const line = await lineOf(s);
    expect(line).toMatchObject({
      months: 6,
      total: "36.00",
      stopped_from: "2027-03",
      status: "released",
      invoiced: "24.00",
      planned: "12.00",
    });
    const portions = await portionsOf(s, s.student);
    expect(portions.map((p) => [p.due_date, p.month_count, p.amount_minor, p.status])).toEqual([
      ["2026-09-01", 4, 2400, "invoiced"],
      ["2027-01-01", 2, 1200, "planned"],
    ]);

    // The database refuses to change an invoiced portion, whoever asks.
    const refused = await admin(
      s.fixture.schoolId,
      (tx) => tx`DELETE FROM app.student_ai_fee_portions WHERE id = ${september!.id}::uuid`,
    ).then(
      () => "deleted",
      (error: { constraint_name?: string }) => error.constraint_name ?? "error",
    );
    expect(refused).toBe("ck_student_ai_fee_portions_invoiced");
  });

  test("released in December after the first instalment was invoiced: nothing more is planned", async () => {
    const s = await scenario(TEN_MONTHS);
    await instalments(s, s.student, ["2026-09-01", "2027-01-01", "2027-04-01"]);
    const optInId = await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await sync(s);
    const [september] = await portionsOf(s, s.student);
    await invoice(s, september!.id, "ACC-SINV-2026-00003");

    await release(s, optInId, "2026-12-10T08:00:00Z");
    await sync(s);
    expect((await portionsOf(s, s.student)).map((p) => p.status)).toEqual(["invoiced"]);
    expect(await lineOf(s)).toMatchObject({
      months: 4,
      total: "24.00",
      stopped_from: "2027-01",
      invoiced: "24.00",
      planned: "0.00",
    });
  });

  test("a transferred seat: the leaver is charged through the transfer month, the new student from the next", async () => {
    const s = await scenario(TEN_MONTHS);
    const newcomer = await createStudent(database!.sql, s.fixture.schoolId);
    await admin(
      s.fixture.schoolId,
      (tx) => tx`
        INSERT INTO app.parent_child_links
          (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (${s.fixture.schoolId}::uuid, ${s.familyId}::uuid, ${s.parent.userId}::uuid,
                ${newcomer.id}::uuid, 'mother')
      `,
    );
    await instalments(s, s.student, ["2026-09-01", "2027-01-01"]);
    await instalments(s, newcomer, ["2026-09-01", "2027-01-01"]);
    const optInId = await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await sync(s);

    // The seat moves on 5 December: the leaver is charged through December, the newcomer from
    // January (phase 2 starts the receiving opt-in the month after) -- December is charged once.
    await admin(s.fixture.schoolId, (tx) =>
      transferTestOptIn(tx, {
        fromOptInId: optInId,
        toStudentId: newcomer.id,
        endedBy: s.fixture.users.ORG_ADMIN.id,
        receiverStartMonth: "2027-01-01",
        transferredAt: "2026-12-05T08:00:00Z",
      }),
    );
    await sync(s);

    expect(await lineOf(s, s.student)).toMatchObject({
      months: 4,
      stopped_from: "2027-01",
      status: "transferred",
    });
    expect(await lineOf(s, newcomer)).toMatchObject({
      months: 6,
      total: "36.00",
      start_month: "2027-01",
      late_start: true,
    });
    expect(
      (await portionsOf(s, newcomer)).map((p) => [p.due_date, p.first_month, p.month_count]),
    ).toEqual([["2027-01-01", "2027-01-01", 6]]);
  });

  test("auto-billing off: no fee items are planned, the parent still sees the line", async () => {
    const s = await scenario(TEN_MONTHS);
    await instalments(s, s.student, ["2026-09-01", "2027-01-01", "2027-04-01"]);
    await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await sync(s);
    const [september] = await portionsOf(s, s.student);
    await invoice(s, september!.id, "ACC-SINV-2026-00002");

    const read = await authenticatedRequest(
      harness!,
      "GET",
      "/api/finance/student-ai/settings",
      s.finance,
    );
    expect(((await read.json()) as { auto_billing: boolean }).auto_billing).toBe(true);

    const off = await authenticatedRequest(
      harness!,
      "PUT",
      "/api/finance/student-ai/settings",
      s.finance,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_billing: false }),
      },
    );
    expect(off.status).toBe(200);
    expect(
      ((await off.json()) as { settings: { auto_billing: boolean } }).settings.auto_billing,
    ).toBe(false);
    // Only the not-yet-invoiced portions go.
    expect((await portionsOf(s, s.student)).map((p) => p.status)).toEqual(["invoiced"]);
    expect(await lineOf(s)).toMatchObject({ billing: "outside", total: "60.00", months: 10 });

    // Back on: only the months from the current month are planned again.
    const on = await authenticatedRequest(
      harness!,
      "PUT",
      "/api/finance/student-ai/settings",
      s.finance,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_billing: true }),
      },
    );
    const { settings } = (await on.json()) as { settings: { auto_billing_since: string } };
    expect(settings.auto_billing_since).toMatch(/^\d{4}-\d{2}$/);
    expect((await lineOf(s)).billing).toBe("auto");
    for (const portion of (await portionsOf(s, s.student)).filter((p) => p.status === "planned")) {
      expect(portion.first_month.slice(0, 7) >= settings.auto_billing_since).toBe(true);
    }
  });

  test("the line carries the price the parent agreed to on the opt-in, fixed", async () => {
    const s = await scenario(TEN_MONTHS);
    await optIn(s, s.student, "2026-09-03T08:00:00Z", 450);
    expect(await sync(s)).toMatchObject({ created: 1 });
    expect(await lineOf(s)).toMatchObject({ monthly_price_minor: 450, total: "45.00", months: 10 });
    // A later change of the school's currency or programme values never re-prices the line.
    await admin(
      null,
      (tx) => tx`
        UPDATE app.schools SET default_currency_id = (SELECT id FROM app.currencies WHERE code = 'JOD')
        WHERE id = ${s.fixture.schoolId}::uuid
      `,
    );
    expect(await sync(s)).toMatchObject({ created: 0, unchanged: 1 });
    expect(await lineOf(s)).toMatchObject({ monthly_price_minor: 450, currency: "USD" });
  });

  test("parents see only their own children's lines, in their own school", async () => {
    const s = await scenario(TEN_MONTHS);
    const other = await scenario(TEN_MONTHS);
    await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await optIn(other, other.student, "2026-09-03T08:00:00Z");
    await sync(s);
    await sync(other);

    // A parent of the school with no link to this family: no access to the family view.
    const stranger = await createUser(database!.sql, s.fixture.schoolId, {
      email: `stranger-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(database!.sql, s.fixture.schoolId, stranger.id, ROLES.PARENT);
    const strangerActor = {
      schoolId: s.fixture.schoolId,
      userId: stranger.id,
      roles: [ROLES.PARENT],
    };
    expect((await parentLines(s, strangerActor)).status).toBe(404);
    // Another school's parent asking for this family: not found either.
    expect((await parentLines(s, other.parent)).status).toBe(404);

    // Row-level security: the linked parent reads their child's line, nobody else's.
    const read = (schoolId: string, userId: string) =>
      asUser(schoolId, userId, async (tx) => {
        const items = await tx<{ student_id: string }[]>`
          SELECT student_id::text FROM app.student_ai_fee_items
        `;
        const portions = await tx<{ student_id: string }[]>`
          SELECT student_id::text FROM app.student_ai_fee_portions
        `;
        return { items: items.map((r) => r.student_id), portions: portions.length };
      });
    expect((await read(s.fixture.schoolId, s.parent.userId)).items).toEqual([s.student.id]);
    expect(await read(s.fixture.schoolId, stranger.id)).toEqual({ items: [], portions: 0 });
    // The other school's parent, armed for this school, sees nothing (and the API never arms it).
    expect((await read(s.fixture.schoolId, other.parent.userId)).items).toEqual([]);
    // Their own school shows only their own child.
    expect((await read(other.fixture.schoolId, other.parent.userId)).items).toEqual([
      other.student.id,
    ]);
    // The runtime role can never write the line itself.
    const write = await asUser(
      s.fixture.schoolId,
      s.parent.userId,
      (tx) => tx`UPDATE app.student_ai_fee_items SET months = 1`,
    ).then(
      () => "written",
      (error: { code?: string }) => error.code ?? "error",
    );
    expect(write).toBe("42501");
  });

  test("finance lists the lines; the routes are finance-only", async () => {
    const s = await scenario(TEN_MONTHS);
    await optIn(s, s.student, "2026-09-03T08:00:00Z");
    await sync(s);

    const list = await authenticatedRequest(
      harness!,
      "GET",
      `/api/finance/student-ai/lines?academic_year_id=${s.yearId}`,
      s.finance,
    );
    expect(list.status).toBe(200);
    const { lines } = (await list.json()) as {
      lines: { student_id: string; student_name: string; total: string }[];
    };
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ student_id: s.student.id, total: "60.00" });
    expect(lines[0]!.student_name.length).toBeGreaterThan(0);

    for (const [method, path] of [
      ["GET", "/api/finance/student-ai/lines"],
      ["POST", "/api/finance/student-ai/sync"],
      ["GET", "/api/finance/student-ai/settings"],
    ] as const) {
      const response = await authenticatedRequest(harness!, method, path, s.parent);
      expect(response.status).toBe(403);
    }
  });
});
