/**
 * The Student AI weekly statements against a real database (migration 000251, owner's rules of
 * 2026-11-18): a parent's tuition invoice carrying Student AI months, paid in full, makes those
 * months collected (a part payment does not); the week's statement gathers them with the school's
 * share (the conversion of the month they were collected in, the previous month's upload bonus);
 * the super admin approves it (a statement invoice for the net, the months billed), and paying that
 * invoice activates the months -- without ever starting or stopping the licence; hold and reject
 * (the months come back on a later statement); the guard against a statement that changed; a voided
 * statement invoice; and who may read and decide.
 *
 * The conversion, the upload consistency and the commitment are stood in for, as in
 * revenue-share.integration.test.ts (500 enrolled, 350 with Student AI: 70% -> 10%, uploads 85% ->
 * +3%: 13%).
 */

import {
  buildWeeklyStatements,
  lockDueConversionSnapshots,
  recordCollectedStudentAiMonths,
  weekStartOf,
} from "@studafy/billing";
import { ROLES } from "@studafy/constants";
import { academicYearMonths, conversionMeasureDay, monthStart } from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { setStudentAiAutoBilling } from "../../src/modules/finance/student-ai/service";
import {
  acceptQuote,
  createQuote,
  recordPayment,
  runLicenseChange,
  sendQuote,
  useRevenueShareMeasures,
  voidInvoice,
} from "../../src/modules/licensing";
import { instalmentsPastCutoff } from "../../src/modules/licensing/ai-stop";
import { readInvoice, requireInvoiceDetail } from "../../src/modules/licensing/invoices";
import { readLicense } from "../../src/modules/licensing/service";
import { resolveUserEntitlement } from "../../src/modules/subscriptions/entitlements/resolve";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import { insertOptIn, insertOptInWindow } from "./programme-optins";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type { TestApp, TestDatabase } from "../harness";
import type { RevenueShareMeasures } from "@studafy/billing";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let api: TestApp;
let hq: string;
let operator: LicenseActor;
let studentTier = "";

const fakeMeasures: RevenueShareMeasures = {
  countEnrolledStudents: async () => 500,
  countStudentAiHolders: async () => 350,
  uploadConsistencyForPeriod: async () => 8500,
  licenceCommitment: async () => "full_year",
};
let restoreMeasures: (() => void) | null = null;

function deps(): LicensingDeps {
  return {
    database: db.sql,
    redis: null,
    logger,
    providers: { stripe: null, googlePlay: null },
    storage: null,
  };
}

async function asAdmin<T>(schoolId: string | null, fn: (tx: TransactionSql) => Promise<T>) {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId ?? ""}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

function as<T>(schoolId: string, actor: LicenseActor, fn: (tx: TransactionSql) => Promise<T>) {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => ({
    result: await fn(tx),
    versions: new Map<string, number>(),
    pending: [],
  })).then((r) => r.result);
}

const ISO = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  restoreMeasures = useRevenueShareMeasures(fakeMeasures);
  const created = createTestApp({ database: db.sql });
  await created.ready;
  api = created;

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "statements-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };
  await asAdmin(null, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_statements', 'Student AI', 'student', 2) RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      SELECT ${plan!.id}::uuid, id, 'monthly'::app.billing_interval, 400
      FROM app.currencies WHERE code = 'USD'
    `;
    studentTier = plan!.id;
  });
}, 180_000);

afterAll(async () => {
  restoreMeasures?.();
  await db?.cleanup();
});

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

interface Fixture {
  schoolId: string;
  admin: LicenseActor;
  academicYearId: string;
  licenseId: string;
  licenceInvoiceId: string;
  windowId: string;
  start: Date;
  /** The licence's months and the day each one's conversion is measured. */
  months: { month: string; measureOn: Date }[];
}

/** A school with a 10-month Student AI licence (350 seats, paid monthly) in the programme. */
async function fixture(name: string): Promise<Fixture> {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const adminUser = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, adminUser.id, "ORG_ADMIN");
  const admin: LicenseActor = { kind: "school", userId: adminUser.id, homeSchoolId: schoolId };
  const academicYearId = await asAdmin(schoolId, async (tx) => {
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, 'AY-ST', 'Year', CURRENT_DATE - 60, CURRENT_DATE + 400, 'active')
      RETURNING id::text AS id
    `;
    return year!.id;
  });
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const quote = await as(schoolId, operator, async (tx) => {
    const created = await createQuote(
      tx,
      schoolId,
      {
        kind: "new",
        currencyCode: "USD",
        months: 10,
        startsAt: start,
        student: { planId: studentTier, seats: 350 },
        paymentPlan: "monthly",
      } as QuoteTerms,
      operator,
    );
    return sendQuote(tx, schoolId, created.id, operator);
  });
  const { invoice } = (await as(schoolId, admin, (tx) =>
    acceptQuote(tx, schoolId, quote.id, admin).then((r) => r.result),
  )) as { invoice: { id: string; licenseId: string } };
  const windowId = await asAdmin(schoolId, (tx) =>
    insertOptInWindow(tx, {
      schoolId,
      licenseId: invoice.licenseId,
      academicYearId,
      openedBy: adminUser.id,
    }),
  );
  const counted = academicYearMonths(ISO(start), ISO(addDays(addMonths(start, 10), -1)))!;
  const months = Array.from({ length: counted.last - counted.first + 1 }, (_, i) => {
    const month = monthStart(counted.first + i);
    return { month, measureOn: new Date(`${conversionMeasureDay(month, ISO(start))}T00:00:00Z`) };
  });
  return {
    schoolId,
    admin,
    academicYearId,
    licenseId: invoice.licenseId,
    licenceInvoiceId: invoice.id,
    windowId,
    start,
    months,
  };
}

/**
 * An opted-in student whose parent's tuition invoice carries `count` Student AI months from
 * `firstMonth`, with `paidMinor` of its `totalMinor` paid. Returns the student and the invoice.
 */
async function tuitionWithAiMonths(
  f: Fixture,
  input: { firstMonth: string; count: number; totalMinor: number; paidMinor: number },
  programme = true,
): Promise<{ studentId: string; userId: string; docname: string }> {
  const student = await createStudent(db.sql, f.schoolId);
  const docname = `ACC-SINV-${crypto.randomUUID().slice(0, 8)}`;
  await asAdmin(f.schoolId, async (tx) => {
    // A programme seat (000252): what an opt-in holds since, paid month by month on statements.
    const [seat] = await tx<{ id: string }[]>`
      INSERT INTO app.license_seats (
        school_id, license_id, audience, user_id, student_id, assigned_by, programme
      ) VALUES (
        ${f.schoolId}::uuid, ${f.licenseId}::uuid, 'student', ${student.userId}::uuid,
        ${student.id}::uuid, ${f.admin.userId}::uuid, ${programme}
      )
      RETURNING id::text AS id
    `;
    await insertOptIn(tx, {
      seatId: seat!.id,
      schoolId: f.schoolId,
      licenseId: f.licenseId,
      academicYearId: f.academicYearId,
      windowId: f.windowId,
      studentId: student.id,
      recordedBy: f.admin.userId,
      startMonth: f.months[0]!.month,
      endMonth: f.months[9]!.month,
      monthlyPriceMinor: 600,
    });
    const [usd] = await tx<
      { id: string }[]
    >`SELECT id::text AS id FROM app.currencies WHERE code = 'USD'`;
    const [item] = await tx<{ id: string }[]>`
      INSERT INTO app.student_ai_fee_items (
        school_id, student_id, academic_year_id, license_id, currency_id, monthly_price_minor,
        start_month, end_month, months, total_minor
      ) VALUES (
        ${f.schoolId}::uuid, ${student.id}::uuid, ${f.academicYearId}::uuid, ${f.licenseId}::uuid,
        ${usd!.id}::uuid, 600, ${f.months[0]!.month}::date, ${f.months[9]!.month}::date, 10, 6000
      )
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.student_ai_fee_portions (
        school_id, item_id, student_id, due_date, first_month, month_count, amount_minor, status,
        erpnext_invoice_docname, invoiced_at
      ) VALUES (
        ${f.schoolId}::uuid, ${item!.id}::uuid, ${student.id}::uuid, ${input.firstMonth}::date,
        ${input.firstMonth}::date, ${input.count}, ${600 * input.count}, 'invoiced', ${docname},
        CURRENT_TIMESTAMP
      )
    `;
    await tx`
      INSERT INTO app.invoice_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor,
        outstanding_amount_minor, issued_date, due_date, last_synced_at
      ) VALUES (
        ${f.schoolId}::uuid, ${student.id}::uuid, ${usd!.id}::uuid, ${docname},
        ${input.paidMinor === input.totalMinor ? "Paid" : "Partly Paid"}, ${input.totalMinor},
        ${input.totalMinor - input.paidMinor}, CURRENT_DATE, CURRENT_DATE, CURRENT_TIMESTAMP
      )
    `;
  });
  return { studentId: student.id, userId: student.userId, docname };
}

const ctxFor = (f: Fixture, now: Date) => ({
  schoolId: f.schoolId,
  now,
  audit: async () => undefined,
  measures: fakeMeasures,
});

function collect(f: Fixture, now: Date) {
  return asAdmin(f.schoolId, (tx) => recordCollectedStudentAiMonths(tx, ctxFor(f, now)));
}

async function lockMonth(f: Fixture, k: number) {
  await asAdmin(f.schoolId, (tx) =>
    lockDueConversionSnapshots(tx, ctxFor(f, f.months[k - 1]!.measureOn)),
  );
}

function build(f: Fixture, now: Date) {
  return asAdmin(f.schoolId, (tx) =>
    buildWeeklyStatements(tx, ctxFor(f, now), weekStartOf(ISO(now))),
  );
}

const asOperator = (method: string, path: string, body?: unknown) =>
  authenticatedRequest(
    api,
    method,
    path,
    {
      schoolId: hq,
      userId: operator.userId,
      roles: [ROLES.SUPER_ADMIN],
      channel: AUTH_CHANNELS.WEB,
    },
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
  );

const monthsOf = (f: Fixture) =>
  asAdmin(
    f.schoolId,
    (tx) => tx<{ month: string; status: string; statement_id: string | null }[]>`
      SELECT month::text AS month, status, statement_id::text AS statement_id
      FROM app.student_ai_months WHERE school_id = ${f.schoolId}::uuid ORDER BY month
    `,
  );

// ---------------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------------

describe("collected months -> weekly statement -> approval -> payment -> activated", () => {
  integrationTest(
    "three months paid by a parent are billed net of the 13% share and activated once paid",
    async () => {
      const f = await fixture("Statement School");
      // Month 2 has begun: its conversion is locked; the parent's invoice for months 2-4 is paid.
      await lockMonth(f, 2);
      const now = new Date(f.months[1]!.measureOn.getTime() + 10 * 3_600_000);
      const payer = await tuitionWithAiMonths(f, {
        firstMonth: f.months[1]!.month,
        count: 3,
        totalMinor: 25_000,
        paidMinor: 25_000,
      });
      // Another parent paid only part of theirs: nothing is collected for it.
      await tuitionWithAiMonths(f, {
        firstMonth: f.months[1]!.month,
        count: 3,
        totalMinor: 25_000,
        paidMinor: 20_000,
      });

      expect(await collect(f, now)).toEqual({ recorded: 3, voided: 0 });
      expect(await collect(f, now)).toEqual({ recorded: 0, voided: 0 });
      expect((await monthsOf(f)).map((m) => [m.month, m.status])).toEqual([
        [f.months[1]!.month, "collected"],
        [f.months[2]!.month, "collected"],
        [f.months[3]!.month, "collected"],
      ]);

      // The week's statement: 3 x $4 = $12 owed to Studafy, less 13% of each month ($0.52).
      const [statement] = await build(f, now);
      expect(statement).toMatchObject({
        weekStart: weekStartOf(ISO(now)),
        monthsCount: 3,
        grossMinor: 1_200,
        shareMinor: 156,
        netMinor: 1_044,
        licenceShareCount: 0,
      });
      expect(await build(f, now)).toEqual([]);

      const path = `/api/platform/schools/${f.schoolId}/ai-revenue-share/statements/${statement!.id}`;
      const queue = await asOperator(
        "GET",
        "/api/platform/ai-revenue-share/statements?status=awaiting_approval",
      );
      expect(queue.status).toBe(200);
      const listed = (
        (await queue.json()) as { statements: { id: string; schoolName: string }[] }
      ).statements.find((s) => s.id === statement!.id);
      expect(listed).toMatchObject({ schoolName: "Statement School" });

      // Approving with figures that are not the statement's is refused.
      const stale = await asOperator("POST", `${path}/approve`, {
        expectedNetMinor: 1_000,
        expectedLicenceShareMinor: 0,
      });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { code: string }).code).toBe(
        "AI_REVENUE_SHARE_STATEMENT_CHANGED",
      );

      const approved = await asOperator("POST", `${path}/approve`, {
        expectedNetMinor: 1_044,
        expectedLicenceShareMinor: 0,
      });
      expect(approved.status).toBe(200);
      const detail = (await approved.json()) as {
        status: string;
        invoiceId: string;
        months: { status: string; shareMinor: number }[];
      };
      expect(detail.status).toBe("approved");
      expect(detail.months.map((m) => [m.status, m.shareMinor])).toEqual([
        ["billed", 52],
        ["billed", 52],
        ["billed", 52],
      ]);
      const again = await asOperator("POST", `${path}/reject`, { reason: "Too late" });
      expect(((await again.json()) as { code: string }).code).toBe(
        "AI_REVENUE_SHARE_STATEMENT_DECIDED",
      );

      // The statement invoice: the months, the share credited, the net to pay.
      const invoice = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, detail.invoiceId, operator),
      );
      expect(invoice).toMatchObject({ kind: "ai_statement", totalMinor: 1_044 });
      expect(invoice.lines.map((l) => [l.kind, l.amountMinor])).toEqual([
        ["student_ai_months", 1_200],
        ["ai_share_credit", -156],
      ]);

      // Unpaid past its cutoff, it never stops the licence.
      const pastCutoff = await asAdmin(f.schoolId, (tx) =>
        instalmentsPastCutoff(tx, f.licenseId, addDays(now, 400)),
      );
      const licenceOnly = await asAdmin(
        f.schoolId,
        (tx) => tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM app.license_invoice_instalments AS inst
          JOIN app.license_invoices AS i ON i.id = inst.invoice_id AND i.school_id = inst.school_id
          WHERE i.id = ${f.licenceInvoiceId}::uuid AND inst.status <> 'paid'
        `,
      );
      expect(pastCutoff).toBe(licenceOnly[0]!.count);

      // The school pays it: the months are activated; the licence is not touched.
      const before = await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, f.licenseId))!);
      const paid = (await as(f.schoolId, operator, (tx) =>
        recordPayment(
          tx,
          f.schoolId,
          detail.invoiceId,
          { amountMinor: 1_044, receivedAt: now, bankReference: "FT-STATEMENT-1" },
          operator,
          now,
        ).then((r) => r.result),
      )) as { licenseActivated: boolean; invoice: { status: string } };
      expect(paid).toMatchObject({ licenseActivated: false, invoice: { status: "paid" } });
      expect((await monthsOf(f)).every((m) => m.status === "activated")).toBe(true);
      const after = await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, f.licenseId))!);
      expect(after.status).toBe(before.status);

      // The student's programme seat now covers exactly those months (000252) -- once the licence
      // is in force (its first instalment paid).
      await as(f.schoolId, operator, (tx) =>
        recordPayment(
          tx,
          f.schoolId,
          f.licenceInvoiceId,
          { amountMinor: 140_000, receivedAt: now, bankReference: "FT-LICENCE-1" },
          operator,
          now,
        ).then((r) => r.result),
      );
      const entitlement = await asAdmin(f.schoolId, (tx) =>
        resolveUserEntitlement(tx, f.schoolId, payer.userId),
      );
      expect(entitlement.seats.map((seat) => seat.activeMonths)).toEqual([
        [f.months[1]!.month, f.months[2]!.month, f.months[3]!.month],
      ]);

      // The school reads its statements; a teacher may not; the console is the super admin's.
      const finance = await createUser(db.sql, f.schoolId);
      await assignRole(db.sql, f.schoolId, finance.id, ROLES.FINANCE);
      const own = await authenticatedRequest(
        api,
        "GET",
        "/api/school/ai-revenue-share/statements",
        {
          schoolId: f.schoolId,
          userId: finance.id,
          roles: [ROLES.FINANCE],
          channel: AUTH_CHANNELS.WEB,
        },
      );
      expect(own.status).toBe(200);
      expect(((await own.json()) as { statements: { id: string }[] }).statements).toHaveLength(1);
      const consoleForAdmin = await authenticatedRequest(api, "GET", path, {
        schoolId: f.schoolId,
        userId: f.admin.userId,
        roles: [ROLES.ORG_ADMIN],
        channel: AUTH_CHANNELS.WEB,
      });
      expect(consoleForAdmin.status).toBe(403);
    },
    120_000,
  );

  integrationTest(
    "an opt-in on a seat the school bought is never billed again; auto-billing stays on",
    async () => {
      const f = await fixture("Legacy Seat School");
      await lockMonth(f, 2);
      const now = new Date(f.months[1]!.measureOn.getTime() + 10 * 3_600_000);
      await tuitionWithAiMonths(
        f,
        { firstMonth: f.months[1]!.month, count: 2, totalMinor: 9_000, paidMinor: 9_000 },
        false,
      );
      expect(await collect(f, now)).toEqual({ recorded: 0, voided: 0 });

      // With a programme opt-in, Student AI auto-billing cannot be turned off.
      await tuitionWithAiMonths(f, {
        firstMonth: f.months[1]!.month,
        count: 1,
        totalMinor: 2_000,
        paidMinor: 2_000,
      });
      const refused = await asAdmin(f.schoolId, (tx) =>
        setStudentAiAutoBilling(tx, f.schoolId, null, false).then(
          () => "no refusal",
          (err: { code?: string }) => err.code ?? String(err),
        ),
      );
      expect(refused).toBe("AI_OPTIN_AUTO_BILLING_REQUIRED");
    },
  );

  integrationTest("held, then rejected: its months come back on the next statement", async () => {
    const f = await fixture("Rejected Statement School");
    await lockMonth(f, 2);
    const now = new Date(f.months[1]!.measureOn.getTime() + 10 * 3_600_000);
    await tuitionWithAiMonths(f, {
      firstMonth: f.months[1]!.month,
      count: 2,
      totalMinor: 9_000,
      paidMinor: 9_000,
    });
    await collect(f, now);
    const [statement] = await build(f, now);
    const path = `/api/platform/schools/${f.schoolId}/ai-revenue-share/statements/${statement!.id}`;

    expect((await asOperator("POST", `${path}/hold`, { note: " " })).status).toBe(422);
    const held = await asOperator("POST", `${path}/hold`, { note: "Checking the transfers" });
    expect(((await held.json()) as { status: string }).status).toBe("held");
    const rejected = await asOperator("POST", `${path}/reject`, { reason: "Wrong school" });
    expect(((await rejected.json()) as { status: string }).status).toBe("rejected");
    expect((await monthsOf(f)).every((m) => m.status === "collected" && !m.statement_id)).toBe(
      true,
    );

    const nextWeek = addDays(now, 7);
    const [next] = await build(f, nextWeek);
    expect(next).toMatchObject({ monthsCount: 2, weekStart: weekStartOf(ISO(nextWeek)) });
  });

  integrationTest("a statement invoice voided unpaid sends its months back", async () => {
    const f = await fixture("Voided Statement School");
    await lockMonth(f, 2);
    const now = new Date(f.months[1]!.measureOn.getTime() + 10 * 3_600_000);
    await tuitionWithAiMonths(f, {
      firstMonth: f.months[1]!.month,
      count: 1,
      totalMinor: 2_000,
      paidMinor: 2_000,
    });
    await collect(f, now);
    const [statement] = await build(f, now);
    const path = `/api/platform/schools/${f.schoolId}/ai-revenue-share/statements/${statement!.id}`;
    const approved = (await (
      await asOperator("POST", `${path}/approve`, {
        expectedNetMinor: statement!.netMinor,
        expectedLicenceShareMinor: 0,
      })
    ).json()) as { invoiceId: string };
    expect((await monthsOf(f))[0]!.status).toBe("billed");
    await as(f.schoolId, operator, (tx) =>
      voidInvoice(tx, f.schoolId, approved.invoiceId, "Issued in error", operator),
    );
    expect([...(await monthsOf(f))]).toEqual([
      { month: f.months[1]!.month, status: "collected", statement_id: null },
    ]);
    const voided = await asAdmin(f.schoolId, (tx) => readInvoice(tx, approved.invoiceId));
    expect(voided!.status).toBe("void");
  });

  integrationTest(
    "a cancelled tuition invoice voids its months before they are billed",
    async () => {
      const f = await fixture("Cancelled Tuition School");
      await lockMonth(f, 2);
      const now = new Date(f.months[1]!.measureOn.getTime() + 10 * 3_600_000);
      const { docname } = await tuitionWithAiMonths(f, {
        firstMonth: f.months[1]!.month,
        count: 2,
        totalMinor: 5_000,
        paidMinor: 5_000,
      });
      await collect(f, now);
      await asAdmin(
        f.schoolId,
        (tx) => tx`
        UPDATE app.invoice_cache SET erpnext_status = 'Cancelled'
        WHERE school_id = ${f.schoolId}::uuid AND erpnext_docname = ${docname}
      `,
      );
      expect(await collect(f, now)).toEqual({ recorded: 0, voided: 2 });
      expect(await build(f, now)).toEqual([]);
    },
  );
});
