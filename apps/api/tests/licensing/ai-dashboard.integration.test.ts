/**
 * The Student AI programme's dashboards (phase 6) against a real database: the spec's worked example
 * (500 enrolled, 350 opted in, 10 months, uploads on 85% of school days -> 13%, a $1,820 share, a
 * $7,000 margin, $8,820 earned, Studafy keeps $12,180) and the same school on an 8-month year, as
 * the school and the console read them; the margin's basis (collected, estimated, part-paid); who may
 * read what (leadership and finance, the super admin; never a parent, teacher or student, never
 * another school); and the fix for payments recorded before a licence entered the programme.
 *
 * As in revenue-share.integration.test.ts, the opt-in count, the upload consistency and the
 * commitment are stood in for school by school (useRevenueShareMeasures), so the figures are the
 * spec's. The tuition lines (phase 3) are written straight into their tables, with ERPNext's
 * invoices in the invoice cache, paid or not.
 */

import { lockDueConversionSnapshots } from "@studafy/billing";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  acceptQuote,
  createQuote,
  recomputeRevenueShare,
  recordPayment,
  runLicenseChange,
  sendQuote,
  useRevenueShareMeasures,
  voidPayment,
} from "../../src/modules/licensing";
import { listRevenueShareEntries } from "../../src/modules/licensing/revenue-share";
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

import { insertOptInWindow, insertPriceOverride } from "./programme-optins";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type {
  AiProgrammeDashboard,
  AiProgrammeSchoolRow,
  PlatformAiProgrammeDashboard,
} from "../../src/modules/licensing/ai-dashboard";
import type { TestApp, TestDatabase } from "../harness";
import type { RevenueShareMeasures } from "@studafy/billing";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let api: TestApp;
let hq: string;
let operator: LicenseActor;
let studentTier = "";

interface Measured {
  enrolled: number;
  optedIn: number;
  upload: number | null;
}
const measured = new Map<string, Measured>();
const fakeMeasures: RevenueShareMeasures = {
  countEnrolledStudents: async (_tx, schoolId) => measured.get(schoolId)?.enrolled ?? 0,
  countOptedInStudents: async (_tx, schoolId) => measured.get(schoolId)?.optedIn ?? 0,
  uploadConsistencyForPeriod: async (_tx, period) => measured.get(period.schoolId)?.upload ?? null,
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

async function asAdmin<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

function as<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<unknown>,
) {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => {
    const changed = (await fn(tx)) as { result?: T } | T;
    const result =
      changed && typeof changed === "object" && "result" in changed
        ? (changed as { result: T }).result
        : (changed as T);
    return { result, versions: new Map<string, number>(), pending: [] };
  }).then((r) => r.result);
}

const ISO = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function tomorrow(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
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
  const op = await createUser(db.sql, hq, { email: "dashboard-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', '', true)`;
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_dashboard', 'Student AI', 'student', 2) RETURNING id::text AS id
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

interface SchoolFixture {
  schoolId: string;
  admin: LicenseActor;
  academicYearId: string;
  yearStart: string;
}

/**
 * The spec's prices, set explicitly for the school (parents $6, the licence $4 a seat a month): the
 * global defaults are now parents $4 and the licence $4 (owner, 2026-11-18). `null` keeps the
 * global defaults.
 */
const SPEC_PRICES = { parentPriceMinor: 600, licensePriceMinor: 400 };

async function school(
  name: string,
  measures: Partial<Measured> = {},
  prices: { parentPriceMinor: number; licensePriceMinor: number } | null = SPEC_PRICES,
): Promise<SchoolFixture> {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, ROLES.ORG_ADMIN);
  measured.set(schoolId, { enrolled: 500, optedIn: 350, upload: 8500, ...measures });
  if (prices) {
    // Before any quote, so the licence is signed with these prices.
    await asAdmin(schoolId, (tx) =>
      insertPriceOverride(tx, {
        schoolId,
        createdBy: operator.userId,
        createdBySchoolId: hq,
        ...prices,
      }),
    );
  }
  const year = await asAdmin(schoolId, async (tx) => {
    const [row] = await tx<{ id: string; starts_on: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, 'AY-DB', 'This year', CURRENT_DATE - 60, CURRENT_DATE + 400,
              'active')
      RETURNING id::text AS id, starts_on::text AS starts_on
    `;
    return row!;
  });
  return {
    schoolId,
    admin: { kind: "school", userId: admin.id, homeSchoolId: schoolId },
    academicYearId: year.id,
    yearStart: year.starts_on,
  };
}

/** A Student AI licence of `seats` seats x $4 x `months`, paid monthly, accepted by the school. */
async function licence(f: SchoolFixture, seats: number, months: number, inProgramme = true) {
  const start = tomorrow();
  const quote = (await as(f.schoolId, operator, async (tx) => {
    const created = await createQuote(
      tx,
      f.schoolId,
      {
        kind: "new",
        currencyCode: "USD",
        months,
        startsAt: start,
        student: { planId: studentTier, seats },
        paymentPlan: "monthly",
      } as QuoteTerms,
      operator,
    );
    return sendQuote(tx, f.schoolId, created.id, operator);
  })) as { id: string };
  const accepted = (await as(f.schoolId, f.admin, (tx) =>
    acceptQuote(tx, f.schoolId, quote.id, f.admin),
  )) as { invoice: { id: string; licenseId: string } };
  if (inProgramme) {
    await asAdmin(f.schoolId, (tx) =>
      insertOptInWindow(tx, {
        schoolId: f.schoolId,
        licenseId: accepted.invoice.licenseId,
        academicYearId: f.academicYearId,
        openedBy: f.admin.userId,
      }),
    );
  }
  return {
    licenseId: accepted.invoice.licenseId,
    invoiceId: accepted.invoice.id,
    start,
    due: (k: number) => addMonths(start, k - 1),
  };
}

function pay(f: SchoolFixture, invoiceId: string, amountMinor: number, on: Date) {
  const at = new Date(on.getTime() + 10 * 3_600_000);
  return as(f.schoolId, operator, (tx) =>
    recordPayment(
      tx,
      f.schoolId,
      invoiceId,
      { amountMinor, receivedAt: at, bankReference: `FT${amountMinor}-${at.getTime()}` },
      operator,
      at,
    ),
  );
}

function lock(f: SchoolFixture, now: Date) {
  return asAdmin(f.schoolId, (tx) =>
    lockDueConversionSnapshots(tx, {
      schoolId: f.schoolId,
      now,
      audit: async () => undefined,
      measures: fakeMeasures,
    }),
  );
}

function recompute(f: SchoolFixture, now: Date) {
  return as(f.schoolId, operator, (tx) =>
    recomputeRevenueShare(tx, f.schoolId, operator, now),
  ) as Promise<{ recorded: number; resolved: number; settled: number }>;
}

/**
 * `count` opted-in students' Student AI tuition lines for the year: `priceMinor` (default $6, the
 * spec's parent price) x `months`, each on one ERPNext invoice (billed through Studafy) whose paid
 * part is `paidShare` -- or, for `outside` billing, the school bills it itself and nothing is
 * invoiced.
 */
async function tuitionLines(
  f: SchoolFixture,
  licenseId: string,
  input: {
    count: number;
    months: number;
    billing?: "auto" | "outside";
    paidShare?: number;
    priceMinor?: number;
  },
) {
  const billing = input.billing ?? "auto";
  const paidShare = input.paidShare ?? 1;
  const price = input.priceMinor ?? 600;
  await asAdmin(f.schoolId, async (tx) => {
    const tag = crypto.randomUUID().slice(0, 8);
    await tx`
      INSERT INTO app.users (school_id, email, normalized_email, status)
      SELECT ${f.schoolId}::uuid, 'kid-' || ${tag} || '-' || n || '@test.local',
             'kid-' || ${tag} || '-' || n || '@test.local', 'active'
      FROM generate_series(1, ${input.count}) AS n
    `;
    await tx`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      SELECT ${f.schoolId}::uuid, u.id, 'ADM-' || ${tag} || '-' || row_number() OVER (), 'Kid',
             'Student', 'enrolled'
      FROM app.users AS u
      WHERE u.school_id = ${f.schoolId}::uuid AND u.email LIKE ${`kid-${tag}-%`}
    `;
    await tx`
      INSERT INTO app.student_ai_fee_items (
        school_id, student_id, academic_year_id, license_id, currency_id, monthly_price_minor,
        start_month, end_month, months, total_minor, billing
      )
      SELECT s.school_id, s.id, ${f.academicYearId}::uuid, ${licenseId}::uuid, c.id, ${price},
             date_trunc('month', ${f.yearStart}::date)::date,
             (date_trunc('month', ${f.yearStart}::date) + (${input.months - 1} * interval '1 month'))::date,
             ${input.months}, ${price * input.months}, ${billing}
      FROM app.students AS s
      JOIN app.users AS u ON u.id = s.user_id AND u.school_id = s.school_id
      CROSS JOIN app.currencies AS c
      WHERE s.school_id = ${f.schoolId}::uuid AND u.email LIKE ${`kid-${tag}-%`} AND c.code = 'USD'
    `;
    if (billing === "outside") return;
    // One ERPNext invoice per student: tuition $500 + the Student AI line, paid as asked.
    const total = 50_000 + price * input.months;
    await tx`
      INSERT INTO app.student_ai_fee_portions (
        school_id, item_id, student_id, due_date, first_month, month_count, amount_minor, status,
        erpnext_invoice_docname, invoiced_at
      )
      SELECT i.school_id, i.id, i.student_id, i.start_month, i.start_month, i.months,
             i.total_minor, 'invoiced', 'ACC-SINV-' || ${tag} || '-' || row_number() OVER (),
             CURRENT_TIMESTAMP
      FROM app.student_ai_fee_items AS i
      JOIN app.students AS s ON s.id = i.student_id AND s.school_id = i.school_id
      JOIN app.users AS u ON u.id = s.user_id AND u.school_id = s.school_id
      WHERE i.school_id = ${f.schoolId}::uuid AND u.email LIKE ${`kid-${tag}-%`}
    `;
    await tx`
      INSERT INTO app.invoice_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status, total_amount_minor,
        outstanding_amount_minor, issued_date, last_synced_at
      )
      SELECT p.school_id, p.student_id, i.currency_id, p.erpnext_invoice_docname,
             ${paidShare >= 1 ? "Paid" : paidShare > 0 ? "Partly Paid" : "Unpaid"},
             ${total}, ${Math.round(total * (1 - paidShare))}, CURRENT_DATE, CURRENT_TIMESTAMP
      FROM app.student_ai_fee_portions AS p
      JOIN app.student_ai_fee_items AS i ON i.id = p.item_id AND i.school_id = p.school_id
      WHERE p.school_id = ${f.schoolId}::uuid
        AND p.erpnext_invoice_docname LIKE ${`ACC-SINV-${tag}-%`}
    `;
  });
}

async function newUser(schoolId: string, role: Role) {
  const user = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, user.id, role);
  return user;
}

function get(path: string, schoolId: string, userId: string, role: Role) {
  return authenticatedRequest(api, "GET", path, {
    schoolId,
    userId,
    roles: [role],
    channel: AUTH_CHANNELS.WEB,
  });
}

async function schoolDashboard(f: SchoolFixture, role: Role = ROLES.FINANCE) {
  const user = await newUser(f.schoolId, role);
  const response = await get("/api/school/ai-revenue-share/summary", f.schoolId, user.id, role);
  expect(response.status).toBe(200);
  return (await response.json()) as AiProgrammeDashboard;
}

async function consoleDashboard(f: SchoolFixture) {
  const response = await get(
    `/api/platform/schools/${f.schoolId}/ai-revenue-share/summary`,
    hq,
    operator.userId,
    ROLES.SUPER_ADMIN,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as PlatformAiProgrammeDashboard;
}

/**
 * A licence paid in full on its first day, its conversion locked and its share worked out. The
 * spec's prices (parents $6, licence $4) unless `defaults`: the global defaults (both $4).
 */
async function workedExample(name: string, months: number, defaults = false) {
  const f = await school(name, {}, defaults ? null : SPEC_PRICES);
  const lic = await licence(f, 350, months);
  // $4 x 350 seats x `months`, paid in full on the licence's first day.
  await pay(f, lic.invoiceId, 400 * 350 * months, lic.start);
  const measureDay = addDays(lic.start, 30);
  await lock(f, new Date(measureDay.getTime() + 3_600_000));
  await recompute(f, new Date(measureDay.getTime() + 2 * 3_600_000));
  await tuitionLines(f, lic.licenseId, { count: 350, months, priceMinor: defaults ? 400 : 600 });
  return { f, lic };
}

// ---------------------------------------------------------------------------------------------------
// The worked example
// ---------------------------------------------------------------------------------------------------

describe("the spec's worked example, on the dashboards", () => {
  integrationTest(
    "10 months: 13% -> $1,820 share, $7,000 margin, $8,820 earned; Studafy keeps $12,180",
    async () => {
      const { f, lic } = await workedExample("Worked Example School", 10);
      const entries = await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx));
      expect(entries).toHaveLength(10);
      expect(entries.every((e) => e.status === "owed" && e.totalBps === 1300)).toBe(true);

      const view = await schoolDashboard(f);
      expect(view.license).toMatchObject({
        id: lic.licenseId,
        studentSeats: 350,
        inProgramme: true,
        commitment: "full_year",
      });
      expect(view.students).toEqual({ enrolled: 500, optedIn: 350, conversionBps: 7000 });
      expect(view.conversion).toMatchObject({
        source: "locked",
        enrolled: 500,
        optedIn: 350,
        conversionBps: 7000,
        tierFromBps: 7000,
        shareBps: 1000,
        floorApplied: false,
        periodStart: ISO(lic.start),
        measureOn: ISO(addDays(lic.start, 30)),
      });
      // "Add 75 more seats -> unlock 12%"; the 500-seat floor (8%) pays less than 10%.
      expect(view.nextTier).toEqual({ fromBps: 8500, shareBps: 1200, optInsNeeded: 75 });
      expect(view.largeSchoolFloor).toBeNull();
      expect(view.earnings.share).toEqual({
        collectedMinor: 1_400_000,
        earnedMinor: 182_000,
        pendingMinor: 0,
        owedMinor: 182_000,
        creditedMinor: 0,
        payoutDueMinor: 0,
        paidOutMinor: 0,
        forfeitedMinor: 0,
      });
      expect(view.earnings.margin).toMatchObject({
        basis: "collected",
        autoBilling: true,
        perStudentMonthMinor: 200,
        lines: 350,
        billedMinor: 700_000,
        collectedMinor: 700_000,
        estimatedMinor: 0,
        expectedMinor: 700_000,
      });
      expect(view.earnings.totalMinor).toBe(882_000);
      expect(view.earnings.estimated).toBe(false);
      expect(view.studafy).toEqual({
        invoicedMinor: 1_400_000,
        paidMinor: 1_400_000,
        outstandingMinor: 0,
        overdueMinor: 0,
        sharesCreditedMinor: 0,
      });
      expect(view.ledger).toMatchObject({ owedMinor: 182_000, earnedMinor: 182_000 });
      expect(view.values).toMatchObject({ licensePriceMinor: 400, parentPriceMinor: 600 });
      // The school's view never carries what Studafy keeps.
      expect(JSON.stringify(view)).not.toContain("studafyNet");

      const platform = await consoleDashboard(f);
      expect(platform.schoolName).toBe("Worked Example School");
      expect(platform.studafyNet).toEqual({ netMinor: 1_218_000, perSeatMinor: 3480, seats: 350 });
      expect(platform.earnings.totalMinor).toBe(882_000);

      const overview = await get(
        "/api/platform/ai-revenue-share/schools",
        hq,
        operator.userId,
        ROLES.SUPER_ADMIN,
      );
      expect(overview.status).toBe(200);
      const { schools } = (await overview.json()) as { schools: AiProgrammeSchoolRow[] };
      expect(schools.find((s) => s.schoolId === f.schoolId)).toMatchObject({
        schoolName: "Worked Example School",
        licenseId: lic.licenseId,
        inProgramme: true,
        studentSeats: 350,
        enrolled: 500,
        optedIn: 350,
        conversionBps: 7000,
        conversionSource: "locked",
        conversionShareBps: 1000,
        collectedMinor: 1_400_000,
        owedMinor: 182_000,
        earnedMinor: 182_000,
        forfeitedMinor: 0,
        studafyNetMinor: 1_218_000,
        studafyNetPerSeatMinor: 3480,
      });
    },
    120_000,
  );

  integrationTest(
    "8 months: $1,456 share, $5,600 margin, $7,056 earned; Studafy keeps $9,744 ($27.84 a seat)",
    async () => {
      const { f } = await workedExample("Eight Month School", 8);
      const view = await schoolDashboard(f, ROLES.PRINCIPAL);
      expect(view.earnings.share).toMatchObject({
        collectedMinor: 1_120_000,
        earnedMinor: 145_600,
      });
      expect(view.earnings.margin).toMatchObject({ collectedMinor: 560_000, lines: 350 });
      expect(view.earnings.totalMinor).toBe(705_600);
      const platform = await consoleDashboard(f);
      expect(platform.studafyNet).toEqual({ netMinor: 974_400, perSeatMinor: 2784, seats: 350 });
    },
    120_000,
  );
});

describe("the global defaults: parents $4, the licence $4", () => {
  integrationTest(
    "the school keeps no margin; the share is still worked out on what Studafy collects",
    async () => {
      const { f } = await workedExample("Default Prices School", 10, true);
      const view = await schoolDashboard(f);
      expect(view.values).toMatchObject({ licensePriceMinor: 400, parentPriceMinor: 400 });
      // 13% of the $14,000 Studafy collected, whatever the parents are charged.
      expect(view.earnings.share).toMatchObject({
        collectedMinor: 1_400_000,
        earnedMinor: 182_000,
        owedMinor: 182_000,
      });
      expect(view.earnings.margin).toMatchObject({
        basis: "collected",
        perStudentMonthMinor: 0,
        lines: 350,
        billedMinor: 0,
        collectedMinor: 0,
        expectedMinor: 0,
      });
      expect(view.earnings.totalMinor).toBe(182_000);
      const platform = await consoleDashboard(f);
      expect(platform.studafyNet).toEqual({ netMinor: 1_218_000, perSeatMinor: 3480, seats: 350 });
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------------------------------
// The margin's basis
// ---------------------------------------------------------------------------------------------------

describe("the school's margin", () => {
  integrationTest(
    "auto-billing off: the lines the school bills itself are an estimate; part-paid is pro rata",
    async () => {
      const f = await school("Margin School", { enrolled: 200, optedIn: 60 });
      const lic = await licence(f, 60, 10);
      // 40 lines billed through Studafy, their invoices half paid; 20 billed by the school.
      await tuitionLines(f, lic.licenseId, { count: 40, months: 10, paidShare: 0.5 });
      await tuitionLines(f, lic.licenseId, { count: 20, months: 10, billing: "outside" });
      await asAdmin(
        f.schoolId,
        (tx) =>
          tx`INSERT INTO app.student_ai_billing_settings (school_id, auto_billing)
           VALUES (${f.schoolId}::uuid, false)`,
      );
      const view = await schoolDashboard(f, ROLES.ORG_ADMIN);
      // Each invoice is $560 ($500 + $60), half paid: half of each line's $20 margin, $10.
      expect(view.earnings.margin).toEqual({
        basis: "mixed",
        autoBilling: false,
        perStudentMonthMinor: 200,
        lines: 60,
        billedMinor: 40 * 2000,
        collectedMinor: 40 * 1000,
        estimatedMinor: 20 * 2000,
        expectedMinor: 60 * 2000,
      });
      // Nothing paid to Studafy yet: no share.
      expect(view.earnings.share.earnedMinor).toBe(0);
      expect(view.earnings.totalMinor).toBe(40 * 1000 + 20 * 2000);
      expect(view.earnings.estimated).toBe(true);
      // 30% conversion -> 4%; 40% is 20 more opt-ins away (6%); the 500-seat floor (8%) 440 seats.
      expect(view.conversion).toMatchObject({ source: "live", conversionBps: 3000, shareBps: 400 });
      expect(view.nextTier).toEqual({ fromBps: 4000, shareBps: 600, optInsNeeded: 20 });
      expect(view.largeSchoolFloor).toEqual({ minSeats: 500, shareBps: 800, seatsNeeded: 440 });
      expect(view.studafy).toMatchObject({
        invoicedMinor: 60 * 400 * 10,
        paidMinor: 0,
        outstandingMinor: 60 * 400 * 10,
      });
    },
    120_000,
  );

  integrationTest("a school with no licence and no lines has nothing to show", async () => {
    const f = await school("Empty School", { enrolled: 0, optedIn: 0 });
    const view = await schoolDashboard(f);
    expect(view.license).toBeNull();
    expect(view.conversion).toBeNull();
    expect(view.nextTier).toBeNull();
    expect(view.studafy).toBeNull();
    expect(view.earnings).toMatchObject({ totalMinor: 0, margin: { basis: "none", lines: 0 } });
  });
});

// ---------------------------------------------------------------------------------------------------
// Who reads what
// ---------------------------------------------------------------------------------------------------

describe("who reads the dashboards", () => {
  integrationTest(
    "leadership and finance read their own school's; parents, teachers and students never",
    async () => {
      const f = await school("Access School");
      const lic = await licence(f, 350, 10);
      await pay(f, lic.invoiceId, 140_000, lic.start);
      const other = await school("Other Access School", { enrolled: 10, optedIn: 1 });

      for (const role of [ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.FINANCE]) {
        const view = await schoolDashboard(f, role);
        expect(view.schoolId).toBe(f.schoolId);
        expect(view.license?.id).toBe(lic.licenseId);
      }
      // Another school's finance reads its own (empty) programme, never this one's.
      const theirs = await schoolDashboard(other);
      expect(theirs.schoolId).toBe(other.schoolId);
      expect(theirs.license).toBeNull();
      expect(theirs.earnings.share.collectedMinor).toBe(0);

      for (const role of [
        ROLES.PARENT,
        ROLES.INSTRUCTOR,
        ROLES.STUDENT,
        ROLES.ATTENDANCE_OFFICER,
      ]) {
        const user = await newUser(f.schoolId, role);
        for (const path of [
          "/api/school/ai-revenue-share/summary",
          "/api/school/ai-revenue-share",
        ]) {
          expect((await get(path, f.schoolId, user.id, role)).status).toBe(403);
        }
      }
      // The console's reads are the super admin's only.
      for (const path of [
        `/api/platform/schools/${f.schoolId}/ai-revenue-share/summary`,
        "/api/platform/ai-revenue-share/schools",
      ]) {
        expect((await get(path, f.schoolId, f.admin.userId, ROLES.ORG_ADMIN)).status).toBe(403);
      }
      const missing = await get(
        `/api/platform/schools/${crypto.randomUUID()}/ai-revenue-share/summary`,
        hq,
        operator.userId,
        ROLES.SUPER_ADMIN,
      );
      expect(missing.status).toBe(404);
    },
    120_000,
  );

  integrationTest(
    "no parent route carries a price, a total, an amount, the licence price, the share or the conversion",
    async () => {
      // The school sells at the spec's prices (parents $6, licence $4): the school tells parents
      // the price; the app is never sent it (owner, 2026-11-18).
      const f = await school("Parent School");
      await licence(f, 350, 10);
      const parent = await newUser(f.schoolId, ROLES.PARENT);
      // Two enrolled children of one family: one the parent opts in, one left available.
      const kids = [
        await createStudent(db.sql, f.schoolId, { firstName: "Amina", lastName: "Tazi" }),
        await createStudent(db.sql, f.schoolId, { firstName: "Omar", lastName: "Tazi" }),
      ];
      const familyId = await asAdmin(f.schoolId, async (tx) => {
        const [family] = await tx<{ id: string }[]>`
          INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
          VALUES (${f.schoolId}::uuid, 'Tazi family', ${parent.id}::uuid)
          RETURNING id::text AS id
        `;
        for (const kid of kids) {
          await tx`
            INSERT INTO app.parent_child_links
              (school_id, parent_user_id, student_id, relationship, family_id)
            VALUES (${f.schoolId}::uuid, ${parent.id}::uuid, ${kid.id}::uuid, 'mother',
                    ${family!.id}::uuid)
          `;
        }
        return family!.id;
      });

      const asParent = (method: string, path: string, body?: unknown) =>
        authenticatedRequest(
          api,
          method,
          path,
          { schoolId: f.schoolId, userId: parent.id, roles: [ROLES.PARENT] },
          body === undefined
            ? undefined
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
        );
      const asLeader = (method: string, path: string, body?: unknown) =>
        authenticatedRequest(
          api,
          method,
          path,
          { schoolId: f.schoolId, userId: f.admin.userId, roles: [ROLES.ORG_ADMIN] },
          body === undefined
            ? undefined
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
        );

      // The school opens a window today (its own local day).
      const overview = await asLeader("GET", "/api/school/license/student-ai");
      expect(overview.status).toBe(200);
      const { today } = (await overview.json()) as { today: string };
      const opened = await asLeader("POST", "/api/school/license/student-ai/windows", {
        academicYearId: f.academicYearId,
        opensOn: today,
        closesOn: today,
        acknowledgeMinimumSeats: true,
      });
      expect(opened.status).toBe(201);

      // Every key of a parent-facing body: no money, and nothing of the licence or the share.
      const PRICE_KEY = /price|total|minor|amount|currency|invoiced|planned|cost|fee/i;
      const PROGRAMME_KEY = /licen[cs]e|share|revenue|conversion|bonus|margin|seat|studafy/i;
      const keysOf = (value: unknown, keys = new Set<string>()): Set<string> => {
        if (Array.isArray(value)) value.forEach((inner) => keysOf(inner, keys));
        else if (value && typeof value === "object") {
          for (const [key, inner] of Object.entries(value)) {
            keys.add(key);
            keysOf(inner, keys);
          }
        }
        return keys;
      };
      const expectClean = (where: string, body: unknown) => {
        for (const key of keysOf(body)) {
          expect({ where, key, price: PRICE_KEY.test(key) }).toEqual({ where, key, price: false });
          expect({ where, key, programme: PROGRAMME_KEY.test(key) }).toEqual({
            where,
            key,
            programme: false,
          });
        }
        // No formatted money in any string either ("$6", "6.00 USD", "60.00").
        expect(JSON.stringify(body)).not.toMatch(/\$\d|\d+\.\d{2}\b|\bUSD\b/);
      };

      // GET /api/parent/student-ai: one child available, then (below) one opted in.
      const before = await asParent("GET", "/api/parent/student-ai");
      expect(before.status).toBe(200);
      const offers = (await before.json()) as {
        schoolName: string;
        termsVersion: string;
        offers: { studentId: string; state: string; period: unknown }[];
      };
      expect(offers.schoolName).toBe("Parent School");
      expect(offers.offers.map((o) => o.state)).toEqual(["available", "available"]);
      expect(offers.offers[0]!.period).not.toBeNull();
      expectClean("GET /api/parent/student-ai (available)", offers);

      // POST /api/parent/student-ai/opt-ins: only the terms, never a price; none comes back.
      const made = await asParent("POST", "/api/parent/student-ai/opt-ins", {
        studentId: kids[0]!.id,
        acceptTerms: true,
        termsVersion: offers.termsVersion,
      });
      expect(made.status).toBe(201);
      expectClean("POST /api/parent/student-ai/opt-ins", await made.json());
      // ...while the opt-in still records the price in force, for billing.
      const [recorded] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ monthly_price_minor: string }[]>`
          SELECT monthly_price_minor::text FROM app.ai_optins WHERE student_id = ${kids[0]!.id}::uuid
        `,
      );
      expect(Number(recorded!.monthly_price_minor)).toBe(600);

      const after = await asParent("GET", "/api/parent/student-ai");
      expect(after.status).toBe(200);
      const afterBody = (await after.json()) as { offers: { state: string }[] };
      expect(afterBody.offers.map((o) => o.state).sort()).toEqual(["available", "opted_in"]);
      expectClean("GET /api/parent/student-ai (opted in)", afterBody);

      // The family view's Student AI line (the school's own fee invoices keep their amounts).
      const family = await asParent("GET", `/api/finance/families/${familyId}`);
      expect(family.status).toBe(200);
      const lines = (
        (await family.json()) as { students: { student_ai_lines: unknown[] }[] }
      ).students.flatMap((section) => section.student_ai_lines);
      expect(lines).toHaveLength(1);
      expectClean("GET /api/finance/families/{familyId} student_ai_lines", lines);

      // The parent's Student AI notifications (in-app and push text).
      const notifications = await asParent("GET", "/api/notifications");
      expect(notifications.status).toBe(200);
      const text = JSON.stringify(await notifications.json());
      expect(text).toContain("Student AI confirmed");
      expect(text).not.toMatch(/\$\d|\d+\.\d{2}\b|\bUSD\b/);

      // Every read that carries a price, the licence price, the share or the conversion is
      // refused to a parent.
      for (const path of [
        "/api/school/ai-revenue-share",
        "/api/school/ai-revenue-share/summary",
        "/api/school/license/student-ai",
        "/api/school/license/student-ai/students",
        "/api/school/license/upload-consistency",
        "/api/school/license",
        "/api/school/license/invoices",
        "/api/finance/student-ai/lines",
        "/api/finance/student-ai/settings",
        `/api/platform/schools/${f.schoolId}/ai-revenue-share/summary`,
        `/api/platform/schools/${f.schoolId}/ai-programme`,
      ]) {
        expect({ path, status: (await asParent("GET", path)).status }).toEqual({
          path,
          status: 403,
        });
      }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------------------------------
// Payments recorded before the licence entered the programme
// ---------------------------------------------------------------------------------------------------

describe("payments recorded before the licence entered the programme", () => {
  integrationTest(
    "opening the first window records their shares: on time pending, late forfeited, once only",
    async () => {
      const f = await school("Late Joiner School");
      const lic = await licence(f, 350, 10, false);
      // Month 1 paid on time; month 2 paid 40 days after it fell due (past its 30-day cutoff).
      await pay(f, lic.invoiceId, 140_000, lic.start);
      await pay(f, lic.invoiceId, 140_000, addDays(lic.due(2), 40));
      expect(await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx))).toHaveLength(0);

      // The school opens its first opt-in window: the licence is in the programme.
      const response = await authenticatedRequest(
        api,
        "POST",
        "/api/school/license/student-ai/windows",
        {
          schoolId: f.schoolId,
          userId: f.admin.userId,
          roles: [ROLES.ORG_ADMIN],
          channel: AUTH_CHANNELS.WEB,
        },
        {
          body: JSON.stringify({
            opensOn: ISO(new Date()),
            closesOn: ISO(addDays(new Date(), 14)),
            acknowledgeMinimumSeats: true,
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(response.status).toBe(201);

      const entries = (await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx))).sort(
        (a, b) => a.instalmentPosition - b.instalmentPosition,
      );
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        kind: "share",
        instalmentPosition: 1,
        collectedMinor: 140_000,
        status: "pending",
        conversionPending: true,
        forfeitReason: null,
      });
      expect(entries[1]).toMatchObject({
        instalmentPosition: 2,
        collectedMinor: 140_000,
        status: "forfeited",
        forfeitReason: "late_payment",
      });

      // Once only: the console's recompute records nothing more; then the lock works month 1 out.
      const measureDay = addDays(lic.start, 30);
      expect((await recompute(f, new Date())).recorded).toBe(0);
      await lock(f, new Date(measureDay.getTime() + 3_600_000));
      await recompute(f, new Date(measureDay.getTime() + 2 * 3_600_000));
      const after = (await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx))).sort(
        (a, b) => a.instalmentPosition - b.instalmentPosition,
      );
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({ status: "owed", totalBps: 1300, amountMinor: 18_200 });
      // A forfeited share is final as recorded: it never becomes money.
      expect(after[1]).toMatchObject({ status: "forfeited", forfeitReason: "late_payment" });

      // A later payment is recorded the usual way, once.
      await pay(f, lic.invoiceId, 140_000, lic.due(3));
      expect(await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx))).toHaveLength(3);
      expect((await recompute(f, new Date())).recorded).toBe(0);
    },
    120_000,
  );

  integrationTest(
    "the console's recompute records what the window's step missed; a voided payment never earns",
    async () => {
      const f = await school("Repair School");
      const lic = await licence(f, 350, 10, false);
      await pay(f, lic.invoiceId, 140_000, lic.start);
      // A second transfer, recorded by mistake and voided: it never earns.
      const mistaken = (await pay(f, lic.invoiceId, 140_000, lic.due(2))) as {
        payment: { id: string };
      };
      await as(f.schoolId, operator, (tx) =>
        voidPayment(tx, f.schoolId, mistaken.payment.id, "Recorded twice", operator),
      );
      // In the programme without the window's after-commit step (as if it had failed).
      await asAdmin(f.schoolId, (tx) =>
        insertOptInWindow(tx, {
          schoolId: f.schoolId,
          licenseId: lic.licenseId,
          academicYearId: f.academicYearId,
          openedBy: f.admin.userId,
        }),
      );
      expect(await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx))).toHaveLength(0);
      const result = await recompute(f, new Date());
      expect(result.recorded).toBe(1);
      const [entry] = await asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx));
      expect(entry).toMatchObject({ instalmentPosition: 1, collectedMinor: 140_000 });
    },
    120_000,
  );
});
