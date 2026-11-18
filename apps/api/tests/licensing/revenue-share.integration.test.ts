/**
 * The Student AI revenue share engine against a real database (migration 000237): the spec's worked
 * example end to end (a pending share, the conversion locked on its measurement day, the share
 * worked out); the Student AI part of a payment that also pays for teacher seats; the credit on the
 * school's next invoice and its instalments; the payout when there is no next invoice (and in payout
 * mode); forfeiture past the cutoff; voids; month-to-month licences; the super admin's re-measure
 * before the lock; the school's own read and the routes' permissions; tenant isolation and the
 * ledger's guards; the measures' real adapters and the programme gate; and the programme values a share uses -- the
 * licence's own, until the super admin re-applies the current ones.
 *
 * The opt-in count, the upload consistency and the commitment are stood in for with
 * useRevenueShareMeasures, school by school, so the figures are the spec's; "the measures" tests
 * run the real adapters (phase 2's opt-ins, phase 4's upload consistency, the licence's
 * commitment). Every programme licence below has an opt-in window (it is in the programme: only
 * such a licence earns a share).
 *
 * The tests share one database and run in order; the last one saves a new global programme version.
 */

import {
  REVENUE_SHARE_MEASURES,
  approveShares,
  licenceInProgramme,
  lockDueConversionSnapshots,
  measureConversion,
  readProgrammeValues,
  rejectShares,
} from "@studafy/billing";
import { ROLES } from "@studafy/constants";
import {
  academicYearMonths,
  conversionMeasureDay,
  instalmentPeriods,
  monthStart,
  splitEvenly,
} from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  acceptQuote,
  createLicense,
  createQuote,
  currentAiProgrammeVersion,
  licenseAiProgramme,
  reapplyAiProgramme,
  recomputeRevenueShare,
  recordPayment,
  runLicenseChange,
  saveAiProgrammeVersion,
  saveSchoolOverride,
  sendQuote,
  transitionLicense,
  useRevenueShareMeasures,
  voidInvoice,
  voidPayment,
} from "../../src/modules/licensing";
import { requireInvoiceDetail } from "../../src/modules/licensing/invoices";
import {
  listRevenueShareEntries,
  schoolRevenueShare,
} from "../../src/modules/licensing/revenue-share";
import { readLicense } from "../../src/modules/licensing/service";
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

import { insertOptIn, insertOptInWindow, releaseTestOptIn } from "./programme-optins";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type { SchoolOverrideInput } from "../../src/modules/licensing/ai-programme";
import type { RevenueShareEntryView } from "../../src/modules/licensing/revenue-share";
import type { TestApp, TestDatabase } from "../harness";
import type { RevenueShareMeasures } from "@studafy/billing";
import type { LicenseCommitment } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let hq: string;
let operator: LicenseActor;
const tiers = { student: "", teacher: "" };

// ---------------------------------------------------------------------------------------------------
// Stand-ins for phases 2 and 4, per school
// ---------------------------------------------------------------------------------------------------

interface Measured {
  enrolled: number;
  optedIn: number;
  upload: number | null;
  commitment: LicenseCommitment;
}
const measured = new Map<string, Measured>();
const fakeMeasures: RevenueShareMeasures = {
  countEnrolledStudents: async (_tx, schoolId) => measured.get(schoolId)?.enrolled ?? 0,
  countStudentAiHolders: async (_tx, schoolId) => measured.get(schoolId)?.optedIn ?? 0,
  uploadConsistencyForPeriod: async (_tx, period) => measured.get(period.schoolId)?.upload ?? null,
  licenceCommitment: async (_tx, schoolId) => measured.get(schoolId)?.commitment ?? "full_year",
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

async function asAdmin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId ?? ""}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

async function asApp<T>(schoolId: string, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** A change in a school as `actor`, through the flow the routes use. */
function as<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (tx: TransactionSql) => Promise<{ result: T; versions?: Map<string, number>; pending?: [] }>,
) {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => {
    const changed = await fn(tx);
    return {
      result: changed.result,
      versions: changed.versions ?? new Map(),
      pending: changed.pending ?? [],
    };
  }).then((r) => r.result);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "no refusal";
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  restoreMeasures = useRevenueShareMeasures(fakeMeasures);

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "revshare-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  await asAdmin(null, async (tx) => {
    // Student AI at the programme's licence price, $4 a seat a month; teachers at $10.
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_revshare', 'Student AI', 'student', 2) RETURNING id::text AS id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank, includes_all_features)
      VALUES ('teacher_revshare', 'Teacher', 'teacher', 1, true) RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      SELECT ${student!.id}::uuid, id, 'monthly'::app.billing_interval, 400 FROM app.currencies WHERE code = 'USD'
      UNION ALL
      SELECT ${teacher!.id}::uuid, id, 'monthly'::app.billing_interval, 1000 FROM app.currencies WHERE code = 'USD'
    `;
    tiers.student = student!.id;
    tiers.teacher = teacher!.id;
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
  /** The academic year opt-in windows are opened for (it covers every licence below). */
  academicYearId: string;
}

async function school(
  measures: Partial<Measured> = {},
  name = "Revenue Share School",
): Promise<SchoolFixture> {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  measured.set(schoolId, {
    enrolled: 500,
    optedIn: 350,
    upload: 8500,
    commitment: "full_year",
    ...measures,
  });
  const academicYearId = await asAdmin(schoolId, async (tx) => {
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, 'AY-RS', 'Year', CURRENT_DATE - 60, CURRENT_DATE + 400, 'active')
      RETURNING id::text AS id
    `;
    return year!.id;
  });
  return {
    schoolId,
    admin: { kind: "school", userId: admin.id, homeSchoolId: schoolId },
    academicYearId,
  };
}

/** Put a licence in the Student AI programme: an opt-in window on it (phase 2). */
function joinProgramme(f: SchoolFixture, licenseId: string): Promise<string> {
  return asAdmin(f.schoolId, (tx) =>
    insertOptInWindow(tx, {
      schoolId: f.schoolId,
      licenseId,
      academicYearId: f.academicYearId,
      openedBy: f.admin.userId,
    }),
  );
}

const ISO = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY);
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
/** Tomorrow, 00:00 UTC: the licences below start then. */
function tomorrow(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

interface ProgrammeLicence {
  licenseId: string;
  invoiceId: string;
  start: Date;
  /** Instalment k's due date (k from 1). */
  due: (k: number) => Date;
}

/**
 * A 10-month Student AI licence for `seats` seats, paid monthly, accepted by the school, in the
 * programme (an opt-in window on it) unless `inProgramme` is false.
 */
async function programmeLicence(
  f: SchoolFixture,
  seats = 350,
  extra: Partial<QuoteTerms> = {},
  months = 10,
  inProgramme = true,
): Promise<ProgrammeLicence> {
  const start = tomorrow();
  const quote = await as(f.schoolId, operator, async (tx) => {
    const created = await createQuote(
      tx,
      f.schoolId,
      {
        kind: "new",
        currencyCode: "USD",
        months,
        startsAt: start,
        student: { planId: tiers.student, seats },
        paymentPlan: "monthly",
        ...extra,
      } as QuoteTerms,
      operator,
    );
    return { result: await sendQuote(tx, f.schoolId, created.id, operator) };
  });
  const { invoice } = (await as(
    f.schoolId,
    f.admin,
    (tx) => acceptQuote(tx, f.schoolId, quote.id, f.admin) as never,
  )) as Awaited<ReturnType<typeof acceptQuote>>["result"];
  if (inProgramme) await joinProgramme(f, invoice.licenseId);
  return {
    licenseId: invoice.licenseId,
    invoiceId: invoice.id,
    start,
    due: (k) => addMonths(start, k - 1),
  };
}

/** Record a transfer received on `on` (the operator records it that day). */
async function pay(f: SchoolFixture, invoiceId: string, amountMinor: number, on: Date) {
  const at = new Date(on.getTime() + 10 * 3_600_000);
  return as(
    f.schoolId,
    operator,
    (tx) =>
      recordPayment(
        tx,
        f.schoolId,
        invoiceId,
        { amountMinor, receivedAt: at, bankReference: `FT${amountMinor}-${at.getTime()}` },
        operator,
        at,
      ) as never,
  ) as Promise<Awaited<ReturnType<typeof recordPayment>>["result"]>;
}

/** The workers' lock, run as of `now` (the hourly job calls the same function). */
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

function recompute(f: SchoolFixture, now: Date): Promise<{ resolved: number; settled: number }> {
  return as(
    f.schoolId,
    operator,
    (tx) => recomputeRevenueShare(tx, f.schoolId, operator, now) as never,
  ) as Promise<{ resolved: number; settled: number }>;
}

function ledger(f: SchoolFixture, licenseId?: string): Promise<RevenueShareEntryView[]> {
  return asAdmin(f.schoolId, (tx) => listRevenueShareEntries(tx, licenseId ? { licenseId } : {}));
}

const byPosition = (entries: RevenueShareEntryView[]) =>
  [...entries].sort(
    (a, b) =>
      a.instalmentPosition - b.instalmentPosition ||
      a.receivedOn.localeCompare(b.receivedOn) ||
      a.kind.localeCompare(b.kind),
  );

/**
 * The months a programme licence counts (THE month rule: the licences start tomorrow, so the first
 * month is tomorrow's, or the next one when tomorrow is late in its month) and the day each month's
 * conversion is measured and locked: its first day, or the licence's first day in the first month.
 */
function licenceMonths(
  licence: ProgrammeLicence,
  months = 10,
): { month: string; measureOn: Date }[] {
  const counted = academicYearMonths(
    ISO(licence.start),
    ISO(addDays(addMonths(licence.start, months), -1)),
  )!;
  return Array.from({ length: counted.last - counted.first + 1 }, (_, i) => {
    const month = monthStart(counted.first + i);
    const day = conversionMeasureDay(month, ISO(licence.start));
    return { month, measureOn: new Date(`${day}T00:00:00Z`) };
  });
}

/** The hourly job month after month: months 1..k locked, each on its measurement day. */
async function lockMonths(f: SchoolFixture, licence: ProgrammeLicence, k: number) {
  for (const { measureOn } of licenceMonths(licence).slice(0, k)) await lock(f, measureOn);
}

/** A super admin approves every share awaiting approval (the weekly statement), then it settles. */
async function approveAll(f: SchoolFixture, now: Date) {
  await asAdmin(f.schoolId, async (tx) => {
    const ids = await tx<{ id: string }[]>`
      SELECT id::text AS id FROM app.ai_programme_revenue_share_entries
      WHERE school_id = ${f.schoolId}::uuid AND status = 'awaiting_approval'
    `;
    await approveShares(
      tx,
      { schoolId: f.schoolId, now, audit: async () => undefined, measures: fakeMeasures },
      ids.map((row) => row.id),
    );
  });
  return recompute(f, now);
}

const latest = (...dates: Date[]) => new Date(Math.max(...dates.map((d) => d.getTime())));

/**
 * A licence with its first `paid` instalments paid on their due dates, those months' conversion
 * locked, and their shares approved (owed, or payout due in payout mode).
 */
async function lockedAndPaid(f: SchoolFixture, paid: number, seats = 350) {
  const licence = await programmeLicence(f, seats);
  const monthly = (seats * 400 * 10) / 10;
  let last = licence.start;
  for (let k = 1; k <= paid; k += 1) {
    // Month 1 is paid on day 29 (its cutoff is day 30); the others on their due dates.
    last = k === 1 ? addDays(licence.start, 29) : licence.due(k);
    await pay(f, licence.invoiceId, monthly, last);
  }
  await lockMonths(f, licence, paid);
  const settleOn = latest(last, licenceMonths(licence)[paid - 1]!.measureOn);
  await recompute(f, settleOn);
  await approveAll(f, settleOn);
  return { ...licence, monthly, settleOn };
}

// ---------------------------------------------------------------------------------------------------
// The worked example
// ---------------------------------------------------------------------------------------------------

describe("the spec's worked example", () => {
  integrationTest(
    "500 enrolled, 350 opted in, uploads on 85% of school days: $14,000 collected earns $1,820",
    async () => {
      const f = await school();
      const licence = await programmeLicence(f);
      const months = licenceMonths(licence);
      expect(months).toHaveLength(10);
      const detail = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, licence.invoiceId, operator),
      );
      // $4 x 350 seats x 10 months = $14,000, in ten monthly instalments.
      expect(detail.totalMinor).toBe(1_400_000);
      expect(detail.instalments.map((i) => i.amountMinor)).toEqual(Array(10).fill(140_000));

      // Month 1 is paid before the measurement day: its share waits for the conversion.
      const first = await pay(f, licence.invoiceId, 140_000, licence.start);
      expect(first.licenseActivated).toBe(true);
      let [entry] = await ledger(f);
      expect(entry).toMatchObject({
        kind: "share",
        status: "pending",
        conversionPending: true,
        bonusPending: false,
        collectedMinor: 140_000,
        baseMinor: 140_000,
        periodFrom: ISO(licence.start),
        periodTo: instalmentPeriods({
          plan: "monthly",
          startDate: ISO(licence.start),
          endDate: ISO(addMonths(licence.start, 10)),
          months: 10,
          instalments: Array.from({ length: 10 }, (_, i) => ({
            position: i + 1,
            dueDate: ISO(licence.due(i + 1)),
          })),
        })[0]!.to,
        measurementPeriodStart: months[0]!.month,
        conversionBps: null,
        amountMinor: 0,
        commitment: "full_year",
      });

      // The day before month 1's measurement day: nothing to lock. On it: month 1 locked, once.
      const m1 = months[0]!.measureOn;
      expect(await lock(f, addDays(m1, -1))).toEqual([]);
      const locked = await lock(f, m1);
      expect(locked).toHaveLength(1);
      expect(locked[0]).toMatchObject({
        periodStart: months[0]!.month,
        measureOn: ISO(m1),
        asOf: ISO(m1),
        enrolledCount: 500,
        optedInCount: 350,
        conversionBps: 7000,
        seats: 350,
        conversionShareBps: 1000,
        floorApplied: false,
        locked: true,
        source: "scheduled",
      });
      expect(await lock(f, addDays(m1, 1))).toEqual([]);

      // The pending share is worked out now: 10% + 3% = 13% of $1,400 = $182, waiting for approval.
      const { resolved } = await recompute(f, m1);
      expect(resolved).toBe(1);
      [entry] = await ledger(f);
      expect(entry).toMatchObject({
        status: "awaiting_approval",
        conversionPending: false,
        conversionBps: 7000,
        seats: 350,
        conversionShareBps: 1000,
        uploadConsistencyBps: 8500,
        bonusBps: 300,
        multiplierBps: 10_000,
        totalBps: 1300,
        amountMinor: 18_200,
      });

      // The other nine months, each paid on its due date: each waits for its own month's conversion,
      // locked on its first day, then for approval. Approved, all ten are owed.
      for (let k = 2; k <= 10; k += 1) await pay(f, licence.invoiceId, 140_000, licence.due(k));
      expect((await ledger(f)).filter((e) => e.status === "pending")).toHaveLength(9);
      await lockMonths(f, licence, 10);
      const end = latest(licence.due(10), months[9]!.measureOn);
      await recompute(f, end);
      let entries = byPosition(await ledger(f));
      expect(entries.map((e) => e.measurementPeriodStart)).toEqual(months.map((m) => m.month));
      expect(
        entries.every((e) => e.status === "awaiting_approval" && e.amountMinor === 18_200),
      ).toBe(true);
      await approveAll(f, end);
      entries = byPosition(await ledger(f));
      expect(entries).toHaveLength(10);
      expect(entries.every((e) => e.status === "owed" && e.amountMinor === 18_200)).toBe(true);
      expect(entries[9]!.periodTo).toBe(ISO(addDays(addMonths(licence.start, 10), -1)));
      const totals = await asAdmin(f.schoolId, (tx) => schoolRevenueShare(tx));
      expect(totals.totals).toEqual([
        expect.objectContaining({
          currencyCode: "USD",
          baseMinor: 1_400_000,
          owedMinor: 182_000,
          earnedMinor: 182_000,
          pendingMinor: 0,
          awaitingApprovalMinor: 0,
        }),
      ]);

      // Each entry is audited in the school (system row) and the operator's home school.
      const audited = await asAdmin(
        hq,
        (tx) => tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM app.audit_logs
          WHERE school_id = ${hq}::uuid AND target_table = 'ai_programme_revenue_share_entries'
            AND action = 'insert' AND new_values ->> 'license_id' = ${licence.licenseId}
        `,
      );
      expect(audited[0]!.count).toBe(10);
    },
  );

  integrationTest(
    "an invoice that also pays for teacher seats: only the Student AI part",
    async () => {
      const f = await school();
      const licence = await programmeLicence(f, 350);
      // Licences sell student seats only for now, so the teacher line is written by hand: students
      // $14,000 and teachers $6,000 on one invoice make 70% of every payment Student AI.
      await asAdmin(
        f.schoolId,
        (tx) => tx`
        INSERT INTO app.license_invoice_lines (
          school_id, invoice_id, position, kind, description, audience, plan_id, seats, months,
          list_price_per_seat_month_minor, list_amount_minor, volume_discount_bps,
          volume_discount_minor, duration_discount_bps, duration_discount_minor, amount_minor
        ) VALUES (
          ${f.schoolId}::uuid, ${licence.invoiceId}::uuid, 99, 'seats', 'Teacher: 60 seats',
          'teacher', ${tiers.teacher}::uuid, 60, 10, 1000, 600000, 0, 0, 0, 0, 600000
        )
      `,
      );
      await lock(f, licenceMonths(licence)[0]!.measureOn);
      await pay(f, licence.invoiceId, 140_000, addDays(licence.start, 29));
      const [entry] = await ledger(f);
      // 70% of $1,400 is $980; 13% of that is $127.40.
      expect(entry).toMatchObject({
        collectedMinor: 140_000,
        baseMinor: 98_000,
        amountMinor: 12_740,
      });
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Credit on the next invoice, payouts
// ---------------------------------------------------------------------------------------------------

describe("credit on the next invoice", () => {
  integrationTest(
    "owed shares come off the school's next invoice: a credit line, the total and its earliest instalments",
    async () => {
      const f = await school();
      const licence = await lockedAndPaid(f, 2);
      expect((await ledger(f)).map((e) => [e.status, e.amountMinor])).toEqual([
        ["owed", 18_200],
        ["owed", 18_200],
      ]);

      // Paying the same invoice never credits it: the credit goes on the NEXT invoice.
      const original = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, licence.invoiceId, operator),
      );
      expect(original.lines.some((l) => l.kind === "ai_share_credit")).toBe(false);

      // 50 more seats for the rest of the term: the seat increase's invoice is the next one. The
      // school accepts it (studafy_app): the credit is applied as the invoice is issued.
      const quote = await as(f.schoolId, operator, async (tx) => {
        const created = await createQuote(
          tx,
          f.schoolId,
          {
            kind: "seat_increase",
            licenseId: licence.licenseId,
            student: { planId: tiers.student, seats: 400 },
            paymentPlan: "monthly",
          } as QuoteTerms,
          operator,
        );
        return { result: await sendQuote(tx, f.schoolId, created.id, operator) };
      });
      const { invoice } = (await as(
        f.schoolId,
        f.admin,
        (tx) => acceptQuote(tx, f.schoolId, quote.id, f.admin) as never,
      )) as Awaited<ReturnType<typeof acceptQuote>>["result"];

      const next = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, invoice.id, operator),
      );
      const credit = next.lines.find((l) => l.kind === "ai_share_credit");
      expect(credit).toMatchObject({ amountMinor: -36_400 });
      expect(next.creditTotalMinor).toBe(36_400);
      expect(next.totalMinor).toBe(next.subtotalMinor - 36_400);
      expect(next.instalments.reduce((s, i) => s + i.amountMinor, 0)).toBe(next.totalMinor);
      // Earliest first: the schedule as issued, then the credit taken off its first instalments.
      const expected = splitEvenly(next.subtotalMinor, next.instalments.length);
      let left = 36_400;
      for (let i = 0; i < expected.length && left > 0; i += 1) {
        const cut = Math.min(left, expected[i]!);
        expected[i]! -= cut;
        left -= cut;
      }
      expect(next.instalments.map((i) => i.amountMinor)).toEqual(expected);
      expect(next.instalments[0]!.amountMinor).toBeLessThan(next.instalments.at(-1)!.amountMinor);

      const entries = await ledger(f);
      expect(entries.map((e) => [e.status, e.creditInvoiceId, e.creditInvoiceNumber])).toEqual([
        ["credited", invoice.id, next.number],
        ["credited", invoice.id, next.number],
      ]);
      // The credit is audited on the invoice.
      const [audit] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ v: string }[]>`
          SELECT new_values ->> 'ai_share_credit_minor' AS v FROM app.audit_logs
          WHERE school_id = ${f.schoolId}::uuid AND target_table = 'license_invoices'
            AND target_id = ${invoice.id}::uuid AND new_values ? 'ai_share_credit_minor'
        `,
      );
      expect(audit!.v).toBe("36400");
      // A later payment on the first invoice: once its month is locked and its share approved, the
      // open seat-increase invoice is still its next one.
      await pay(f, licence.invoiceId, licence.monthly, licence.due(3));
      expect(byPosition(await ledger(f, licence.licenseId))[2]!.status).toBe("pending");
      await lockMonths(f, licence, 3);
      const third = latest(licence.due(3), licenceMonths(licence)[2]!.measureOn);
      await recompute(f, third);
      expect(byPosition(await ledger(f, licence.licenseId))[2]!.status).toBe("awaiting_approval");
      await approveAll(f, third);
      expect(byPosition(await ledger(f, licence.licenseId))[2]).toMatchObject({
        status: "credited",
        creditInvoiceId: invoice.id,
      });
      const after = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, invoice.id, operator),
      );
      expect(after.creditTotalMinor).toBe(54_600);
      expect(after.lines.filter((l) => l.kind === "ai_share_credit")).toHaveLength(2);
    },
  );

  integrationTest(
    "a credit that covers a new licence's first instalment puts it in force on acceptance",
    async () => {
      const f = await school();
      // A small renewal priced next to an owed share bigger than its first instalment.
      const old = await lockedAndPaid(f, 3);
      expect((await ledger(f)).every((e) => e.status === "owed")).toBe(true);
      await as(f.schoolId, operator, async (tx) => {
        const changed = await transitionLicense(
          tx,
          f.schoolId,
          old.licenseId,
          "cancelled",
          operator,
        );
        return { result: changed.result, versions: changed.versions };
      });
      // Cancelled first, so the settle at issuance below sees an open next invoice... and the
      // ended licence: the credit is applied before anything becomes payout_due.
      const renewal = await programmeLicence(f, 30, {}, 10);
      const detail = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, renewal.invoiceId, operator),
      );
      // 30 x $4 x 10 = $1,200, $120 a month; 3 x $182 = $546 of credit covers months 1-4 and part of 5.
      expect(detail.creditTotalMinor).toBe(54_600);
      expect(detail.instalments.slice(0, 5).map((i) => [i.amountMinor, i.status])).toEqual([
        [0, "paid"],
        [0, "paid"],
        [0, "paid"],
        [0, "paid"],
        [12_000 - 6_600, "due"],
      ]);
      expect(
        await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, renewal.licenseId))!.status),
      ).toBe("active");

      // That invoice is voided before anything is paid on it: the shares are owed again, and with
      // the old licence ended and no other invoice open, they are due for payout.
      await as(f.schoolId, operator, async (tx) => ({
        result: await voidInvoice(tx, f.schoolId, renewal.invoiceId, "Wrong quote", operator),
      }));
      expect((await ledger(f, old.licenseId)).map((e) => [e.status, e.creditInvoiceId])).toEqual([
        ["payout_due", null],
        ["payout_due", null],
        ["payout_due", null],
      ]);
    },
  );
});

describe("monthly shares and approval (owner, 2026-11-18)", () => {
  integrationTest(
    "a year paid at once: one share per month it pays for, each final once its month is locked",
    async () => {
      const f = await school();
      const licence = await programmeLicence(f, 350, {
        paymentPlan: "in_full",
      } as Partial<QuoteTerms>);
      const months = licenceMonths(licence);
      await pay(f, licence.invoiceId, 1_400_000, licence.start);
      let entries = await ledger(f);
      // The money split over the ten months: every month its own entry, money and conversion.
      expect(entries).toHaveLength(10);
      expect(entries.every((e) => e.collectedMinor === 140_000)).toBe(true);
      expect([...entries.map((e) => e.measurementPeriodStart)].sort()).toEqual(
        months.map((m) => m.month),
      );
      expect(entries.every((e) => e.status === "pending" && e.conversionPending)).toBe(true);

      // Month by month, each becomes final as its conversion locks on its first day.
      await lockMonths(f, licence, 2);
      await recompute(f, months[1]!.measureOn);
      entries = await ledger(f);
      expect(entries.filter((e) => e.status === "awaiting_approval")).toHaveLength(2);
      expect(entries.filter((e) => e.status === "pending")).toHaveLength(8);

      await lockMonths(f, licence, 10);
      await recompute(f, months[9]!.measureOn);
      entries = await ledger(f);
      // 13% of each month's $1,400: $182 a month, $1,820 in all.
      expect(
        entries.every((e) => e.status === "awaiting_approval" && e.amountMinor === 18_200),
      ).toBe(true);
    },
  );

  integrationTest(
    "a share awaiting approval is never credited; a rejected one never will be",
    async () => {
      const f = await school();
      const licence = await programmeLicence(f);
      await pay(f, licence.invoiceId, 140_000, licence.start);
      await lockMonths(f, licence, 1);
      await recompute(f, licenceMonths(licence)[0]!.measureOn);
      const [entry] = await ledger(f);
      expect(entry).toMatchObject({ status: "awaiting_approval", amountMinor: 18_200 });

      // A next invoice is issued while it waits: nothing is credited on it.
      const next = await programmeLicence(f, 30);
      const detail = await asAdmin(f.schoolId, (tx) =>
        requireInvoiceDetail(tx, next.invoiceId, operator),
      );
      expect(detail.creditTotalMinor).toBe(0);
      expect((await ledger(f, licence.licenseId))[0]!.status).toBe("awaiting_approval");

      // Rejected by the super admin: final, never given, and it cannot be approved afterwards.
      await asAdmin(f.schoolId, (tx) =>
        rejectShares(
          tx,
          { schoolId: f.schoolId, now: new Date(), audit: async () => undefined },
          [entry!.id],
          "Duplicate transfer",
        ),
      );
      await approveAll(f, new Date());
      expect((await ledger(f, licence.licenseId))[0]!.status).toBe("rejected");
      expect(
        await refusal(
          asAdmin(
            f.schoolId,
            (tx) => tx`
              UPDATE app.ai_programme_revenue_share_entries SET status = 'owed', rejected_at = NULL
              WHERE id = ${entry!.id}::uuid
            `,
          ),
        ),
      ).toBe("23514");
      const totals = (await asAdmin(f.schoolId, (tx) => schoolRevenueShare(tx))).totals[0]!;
      expect(totals).toMatchObject({
        rejectedMinor: 18_200,
        earnedMinor: 0,
        awaitingApprovalMinor: 0,
      });
    },
  );
});

describe("payouts", () => {
  let api: TestApp;
  beforeAll(async () => {
    if (!integrationEnabled) return;
    const created = createTestApp({ database: db.sql });
    await created.ready;
    api = created;
  });
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

  integrationTest(
    "a licence that ended with no next invoice: what is owed becomes a payout the super admin records",
    async () => {
      const f = await school();
      const licence = await lockedAndPaid(f, 2);
      await as(f.schoolId, operator, async (tx) => {
        const changed = await transitionLicense(
          tx,
          f.schoolId,
          licence.licenseId,
          "cancelled",
          operator,
        );
        return { result: changed.result, versions: changed.versions };
      });
      const { settled } = await recompute(f, new Date());
      expect(settled).toBe(2);
      expect((await ledger(f)).map((e) => e.status)).toEqual(["payout_due", "payout_due"]);

      const path = `/api/platform/schools/${f.schoolId}/ai-revenue-share/payouts`;
      const body = { currencyCode: "USD", reference: "WIRE-001", paidOn: ISO(new Date()) };
      const changed = await asOperator("POST", path, { ...body, amountMinor: 18_200 });
      expect(changed.status).toBe(409);
      expect(((await changed.json()) as { code: string }).code).toBe(
        "AI_REVENUE_SHARE_PAYOUT_CHANGED",
      );

      const paid = await asOperator("POST", path, { ...body, amountMinor: 36_400 });
      expect(paid.status).toBe(201);
      const payout = (await paid.json()) as { id: string; amountMinor: number; reference: string };
      expect(payout).toMatchObject({ amountMinor: 36_400, reference: "WIRE-001" });
      expect((await ledger(f)).map((e) => [e.status, e.payoutId])).toEqual([
        ["paid_out", payout.id],
        ["paid_out", payout.id],
      ]);
      const again = await asOperator("POST", path, { ...body, amountMinor: 36_400 });
      expect(((await again.json()) as { code: string }).code).toBe("AI_REVENUE_SHARE_NOTHING_DUE");

      const [audit] = await asAdmin(
        hq,
        (tx) => tx<{ actor: string }[]>`
          SELECT actor_id::text AS actor FROM app.audit_logs
          WHERE school_id = ${hq}::uuid AND target_table = 'ai_programme_revenue_share_payouts'
            AND target_id = ${payout.id}::uuid
        `,
      );
      expect(audit!.actor).toBe(operator.userId);
    },
  );

  integrationTest("in payout mode a share is due for payout at once, never credited", async () => {
    const f = await school();
    await asAdmin(f.schoolId, (tx) =>
      saveSchoolOverride(
        tx,
        f.schoolId,
        { ...EMPTY_OVERRIDE, payoutMode: "payout", reason: "Paid out by transfer" },
        operator,
      ),
    );
    const licence = await lockedAndPaid(f, 1);
    expect((await ledger(f)).map((e) => [e.status, e.amountMinor])).toEqual([
      ["payout_due", 18_200],
    ]);
    // A next invoice does not take it.
    await programmeLicence(f, 30);
    expect((await ledger(f, licence.licenseId))[0]!.status).toBe("payout_due");
  });
});

const EMPTY_OVERRIDE: Omit<SchoolOverrideInput, "reason"> = {
  licensePriceMinor: null,
  parentPriceMinor: null,
  minSeats: null,
  maxShareBps: null,
  conversionTiers: null,
  largeSchoolMinSeats: null,
  largeSchoolShareBps: null,
  contentBonusTiers: null,
  bonusRequiresConversionShare: null,
  measurementOffsetDays: null,
  nonpaymentGraceDays: null,
  monthToMonthShareBps: null,
  payoutMode: null,
};

// ---------------------------------------------------------------------------------------------------
// Forfeiture, voids, month-to-month
// ---------------------------------------------------------------------------------------------------

describe("forfeiture (decision 11)", () => {
  integrationTest(
    "an instalment unpaid at its cutoff forfeits its share, part-paid before or paid late",
    async () => {
      const f = await school();
      const licence = await lockedAndPaid(f, 1);
      // Half of month 2 on its due date; month 2's conversion locks and the share awaits approval.
      await pay(f, licence.invoiceId, 70_000, licence.due(2));
      await lockMonths(f, licence, 2);
      await recompute(f, latest(licence.due(2), licenceMonths(licence)[1]!.measureOn));
      let entries = byPosition(await ledger(f));
      expect(entries.map((e) => [e.instalmentPosition, e.status, e.amountMinor])).toEqual([
        [1, "owed", 18_200],
        [2, "awaiting_approval", 9_100],
      ]);

      // Day 29 after month 2's due date: nothing happens. Day 30 (the AI stop): its share is lost,
      // approved or not.
      await recompute(f, addDays(licence.due(2), 29));
      expect(byPosition(await ledger(f))[1]!.status).toBe("awaiting_approval");
      await recompute(f, addDays(licence.due(2), 30));
      entries = byPosition(await ledger(f));
      expect(entries.map((e) => [e.instalmentPosition, e.status, e.forfeitReason])).toEqual([
        [1, "owed", null],
        [2, "forfeited", "unpaid_at_cutoff"],
      ]);

      // The late rest of month 2 earns nothing either; month 3 paid on time earns as usual.
      await pay(f, licence.invoiceId, 70_000, addDays(licence.due(2), 35));
      await pay(f, licence.invoiceId, 140_000, addDays(licence.due(2), 35));
      await lockMonths(f, licence, 3);
      const third = latest(addDays(licence.due(2), 35), licenceMonths(licence)[2]!.measureOn);
      await recompute(f, third);
      await approveAll(f, third);
      entries = byPosition(await ledger(f));
      expect(entries.map((e) => [e.instalmentPosition, e.status, e.forfeitReason])).toEqual([
        [1, "owed", null],
        [2, "forfeited", "unpaid_at_cutoff"],
        [2, "forfeited", "late_payment"],
        [3, "owed", null],
      ]);
      // Forfeited shares never reach an invoice.
      const totals = (await asAdmin(f.schoolId, (tx) => schoolRevenueShare(tx))).totals[0]!;
      expect(totals).toMatchObject({ owedMinor: 36_400, forfeitedMinor: 18_200 });
    },
  );
});

describe("voids", () => {
  integrationTest(
    "a voided payment voids its share; one already credited is reversed",
    async () => {
      const f = await school();
      const licence = await lockedAndPaid(f, 2);
      const payments = await asAdmin(
        f.schoolId,
        (tx) => tx<{ id: string }[]>`
        SELECT id::text AS id FROM app.license_payments
        WHERE school_id = ${f.schoolId}::uuid ORDER BY received_at
      `,
      );
      // The second payment, not credited yet: its share is void.
      await as(f.schoolId, operator, async (tx) => ({
        result: await voidPayment(tx, f.schoolId, payments[1]!.id, "Wrong amount", operator),
      }));
      expect(byPosition(await ledger(f)).map((e) => e.status)).toEqual(["owed", "void"]);

      // The first is credited on the next invoice, then its payment is voided: a reversal is owed.
      const next = await programmeLicence(f, 30);
      expect(byPosition(await ledger(f, licence.licenseId))[0]!.status).toBe("credited");
      await as(f.schoolId, operator, async (tx) => ({
        result: await voidPayment(tx, f.schoolId, payments[0]!.id, "Bounced", operator),
      }));
      const entries = await ledger(f, licence.licenseId);
      const reversal = entries.find((e) => e.kind === "reversal")!;
      expect(reversal).toMatchObject({
        status: "owed",
        amountMinor: -18_200,
        collectedMinor: -140_000,
      });
      expect(reversal.reversesEntryId).toBe(entries.find((e) => e.status === "credited")!.id);
      void next;
    },
  );
});

describe("month-to-month licences", () => {
  integrationTest("earn 0% by default; the share the settings give otherwise", async () => {
    const f = await school({ commitment: "month_to_month" });
    await lockedAndPaid(f, 1);
    expect((await ledger(f)).map((e) => [e.status, e.multiplierBps, e.amountMinor])).toEqual([
      ["zero", 0, 0],
    ]);

    const half = await school({ commitment: "month_to_month" });
    await asAdmin(half.schoolId, (tx) =>
      saveSchoolOverride(
        tx,
        half.schoolId,
        { ...EMPTY_OVERRIDE, monthToMonthShareBps: 5000, reason: "Half for monthly schools" },
        operator,
      ),
    );
    await lockedAndPaid(half, 1);
    expect((await ledger(half)).map((e) => [e.status, e.totalBps, e.amountMinor])).toEqual([
      ["owed", 650, 9_100],
    ]);
  });

  integrationTest("a conversion under the first tier: a zero share, recorded", async () => {
    const f = await school({ enrolled: 500, optedIn: 100 });
    await lockedAndPaid(f, 1, 100);
    expect((await ledger(f)).map((e) => [e.status, e.conversionBps, e.totalBps])).toEqual([
      ["zero", 2000, 0],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Routes and permissions
// ---------------------------------------------------------------------------------------------------

describe("routes", () => {
  let api: TestApp;
  beforeAll(async () => {
    if (!integrationEnabled) return;
    const created = createTestApp({ database: db.sql });
    await created.ready;
    api = created;
  });
  const json = (body: unknown) => ({
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
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
      body === undefined ? undefined : json(body),
    );

  integrationTest(
    "the super admin re-measures before the lock, with a reason; not after",
    async () => {
      const f = await school({ enrolled: 200, optedIn: 90 });
      const licence = await programmeLicence(f, 90);
      const path = `/api/platform/schools/${f.schoolId}/licenses/${licence.licenseId}/ai-revenue-share`;

      const view = await asOperator("GET", path);
      expect(view.status).toBe(200);
      expect(
        ((await view.json()) as { rate: { conversionSource: string } }).rate.conversionSource,
      ).toBe("none");

      const noReason = await asOperator("POST", `${path}/measure`, { reason: "  " });
      expect(noReason.status).toBe(422);
      const measured1 = await asOperator("POST", `${path}/measure`, {
        reason: "Opt-ins came in late",
      });
      expect(measured1.status).toBe(201);
      const after = (await measured1.json()) as {
        periods: {
          periodStart: string;
          locked: unknown;
          measurements: { conversionBps: number; source: string }[];
        }[];
        rate: { conversionSource: string; conversionShareBps: number };
      };
      // Monthly periods, newest first: the one re-measured is the month today falls in (the first).
      const first = after.periods.find((p) => p.measurements.length > 0)!;
      expect(after.periods).toHaveLength(10);
      expect(first.locked).toBeNull();
      expect(first.measurements[0]).toMatchObject({
        conversionBps: 4500,
        source: "super_admin",
      });
      expect(after.rate).toMatchObject({
        conversionSource: "provisional",
        conversionShareBps: 600,
      });

      await lock(f, licenceMonths(licence)[0]!.measureOn);
      const refused = await asOperator("POST", `${path}/measure`, { reason: "Again" });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe(
        "AI_REVENUE_SHARE_CONVERSION_LOCKED",
      );

      // Audited in the operator's home school with the reason.
      const [audit] = await asAdmin(
        hq,
        (tx) => tx<{ v: string }[]>`
        SELECT new_values ->> 'reason' AS v FROM app.audit_logs
        WHERE school_id = ${hq}::uuid AND target_table = 'ai_programme_conversion_snapshots'
          AND new_values ->> 'license_id' = ${licence.licenseId}
      `,
      );
      expect(audit!.v).toBe("Opt-ins came in late");

      expect(
        (await asOperator("GET", `/api/platform/schools/${f.schoolId}/ai-revenue-share`)).status,
      ).toBe(200);
      expect(
        (await asOperator("POST", `/api/platform/schools/${f.schoolId}/ai-revenue-share/recompute`))
          .status,
      ).toBe(200);
    },
  );

  integrationTest(
    "the school reads its own share: leadership and finance, nobody else, never another school's",
    async () => {
      const f = await school();
      await lockedAndPaid(f, 1);
      const other = await school({}, "Other School");
      await lockedAndPaid(other, 1);

      const read = async (schoolId: string, role: (typeof ROLES)[keyof typeof ROLES]) => {
        const user = await createUser(db.sql, schoolId);
        await assignRole(db.sql, schoolId, user.id, role);
        return authenticatedRequest(api, "GET", "/api/school/ai-revenue-share", {
          schoolId,
          userId: user.id,
          roles: [role],
          channel: AUTH_CHANNELS.WEB,
        });
      };
      for (const role of [ROLES.FINANCE, ROLES.PRINCIPAL, ROLES.ORG_ADMIN]) {
        const response = await read(f.schoolId, role);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { entries: { amountMinor: number }[] };
        expect(body.entries.map((e) => e.amountMinor)).toEqual([18_200]);
      }
      for (const role of [ROLES.INSTRUCTOR, ROLES.PARENT, ROLES.STUDENT]) {
        expect((await read(f.schoolId, role)).status).toBe(403);
      }

      // The console is the super admin's only.
      const admin = await authenticatedRequest(
        api,
        "GET",
        `/api/platform/schools/${f.schoolId}/ai-revenue-share`,
        {
          schoolId: f.schoolId,
          userId: f.admin.userId,
          roles: [ROLES.ORG_ADMIN],
          channel: AUTH_CHANNELS.WEB,
        },
      );
      expect(admin.status).toBe(403);

      // Tenant isolation: the runtime role sees only the armed school's rows, and writes none.
      const seen = await asApp(
        f.schoolId,
        (tx) =>
          tx<
            { school_id: string }[]
          >`SELECT school_id::text AS school_id FROM app.ai_programme_revenue_share_entries`,
      );
      expect(seen.length).toBe(1);
      expect(seen.every((row) => row.school_id === f.schoolId)).toBe(true);
      expect(
        await refusal(
          asApp(
            f.schoolId,
            (tx) => tx`UPDATE app.ai_programme_revenue_share_entries SET status = 'void'`,
          ),
        ),
      ).toBe("42501");
      expect(
        await refusal(
          asApp(f.schoolId, (tx) => tx`DELETE FROM app.ai_programme_conversion_snapshots`),
        ),
      ).toBe("42501");
    },
  );
});

describe("the ledger's guards", () => {
  integrationTest("a final share's figures never change; rows are never deleted", async () => {
    const f = await school();
    await lockedAndPaid(f, 1);
    const [entry] = await ledger(f);
    const attempt = (statement: string) =>
      refusal(asAdmin(f.schoolId, (tx) => tx.unsafe(statement.replace("$id", entry!.id))));
    expect(
      await attempt(
        `UPDATE app.ai_programme_revenue_share_entries SET amount_minor = 1 WHERE id = '$id'`,
      ),
    ).toBe("23514");
    expect(
      await attempt(
        `UPDATE app.ai_programme_revenue_share_entries SET collected_minor = 1 WHERE id = '$id'`,
      ),
    ).toBe("23514");
    expect(
      await attempt(
        `UPDATE app.ai_programme_revenue_share_entries SET status = 'pending' WHERE id = '$id'`,
      ),
    ).toBe("23514");
    expect(
      await attempt(`DELETE FROM app.ai_programme_revenue_share_entries WHERE id = '$id'`),
    ).toBe("55000");
    expect(await attempt(`UPDATE app.ai_programme_conversion_snapshots SET seats = 1`)).toBe(
      "55000",
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// The measures, the programme gate, and the programme values
// ---------------------------------------------------------------------------------------------------

describe("the measures", () => {
  integrationTest(
    "enrolled students, and phase 2's opt-ins for the year active at the end of the day",
    async () => {
      const f = await school();
      const students: { id: string; userId: string }[] = [];
      for (let i = 0; i < 4; i += 1) students.push(await createStudent(db.sql, f.schoolId));
      // Enrolled for a while: a student counts only on the days they were enrolled.
      await asAdmin(
        f.schoolId,
        (tx) => tx`
          UPDATE app.students SET created_at = now() - interval '10 days',
                                  updated_at = GREATEST(updated_at, now() - interval '10 days')
          WHERE school_id = ${f.schoolId}::uuid
        `,
      );
      const licenseId = await as(f.schoolId, operator, async (tx) => {
        const license = await createLicense(
          tx,
          f.schoolId,
          {
            startsAt: new Date(Date.now() - 5 * DAY),
            endsAt: new Date(Date.now() + 300 * DAY),
            currencyCode: "USD",
            includeFamilyPlus: false,
            student: { planId: tiers.student, seats: 3 },
          },
          operator,
        );
        const active = await transitionLicense(tx, f.schoolId, license.id, "active", operator);
        return { result: active.result.id, versions: active.versions };
      });
      const windowId = await joinProgramme(f, licenseId);
      // Three opt in three days ago; one of them is released yesterday.
      const optIns = await asAdmin(f.schoolId, async (tx) => {
        const ids: string[] = [];
        for (const student of students.slice(0, 3)) {
          ids.push(
            await insertOptIn(tx, {
              schoolId: f.schoolId,
              licenseId,
              academicYearId: f.academicYearId,
              windowId,
              studentId: student.id,
              recordedBy: f.admin.userId,
              startMonth: `${ISO(new Date()).slice(0, 7)}-01`,
              endMonth: `${ISO(addDays(new Date(), 300)).slice(0, 7)}-01`,
              monthlyPriceMinor: 600,
              optedInAt: addDays(new Date(), -3).toISOString(),
            }),
          );
        }
        return ids;
      });
      const thisMonth = `${ISO(new Date()).slice(0, 7)}-01`;
      const count = (onDate: string, month = thisMonth) =>
        asAdmin(f.schoolId, (tx) =>
          REVENUE_SHARE_MEASURES.countStudentAiHolders(tx, f.schoolId, licenseId, month, onDate),
        );
      const today = ISO(new Date());
      const measurement = await asAdmin(f.schoolId, (tx) =>
        measureConversion(
          tx,
          {
            schoolId: f.schoolId,
            now: new Date(),
            audit: async () => undefined,
            measures: REVENUE_SHARE_MEASURES,
          },
          licenseId,
          thisMonth,
          today,
        ),
      );
      expect(measurement).toMatchObject({
        enrolledCount: 4,
        optedInCount: 3,
        conversionBps: 7500,
        seats: 3,
      });
      // Before they opted in, nobody had.
      expect(await count(ISO(addDays(new Date(), -4)))).toBe(0);
      // Released yesterday: still counted on the days before, not after.
      await asAdmin(f.schoolId, (tx) =>
        releaseTestOptIn(
          tx,
          optIns[0]!,
          f.admin.userId,
          `${ISO(addDays(new Date(), 40)).slice(0, 7)}-01`,
          addDays(new Date(), -1).toISOString(),
        ),
      );
      expect(await count(ISO(addDays(new Date(), -2)))).toBe(3);
      expect(await count(today)).toBe(2);

      // Upload consistency waits until the days are over; a finished period with no class that has
      // Student AI measures 0. The commitment is the licence's own.
      const adapters = await asAdmin(f.schoolId, async (tx) => ({
        // Ends tomorrow (UTC): still ongoing in the school's own timezone, which may already be a
        // day ahead of UTC late in the evening.
        ongoing: await REVENUE_SHARE_MEASURES.uploadConsistencyForPeriod(tx, {
          schoolId: f.schoolId,
          licenseId,
          from: today,
          to: ISO(addDays(new Date(), 1)),
        }),
        finished: await REVENUE_SHARE_MEASURES.uploadConsistencyForPeriod(tx, {
          schoolId: f.schoolId,
          licenseId,
          from: ISO(addDays(new Date(), -10)),
          to: ISO(addDays(new Date(), -3)),
        }),
        commitment: await REVENUE_SHARE_MEASURES.licenceCommitment(tx, f.schoolId, licenseId),
        inProgramme: await licenceInProgramme(tx, licenseId),
      }));
      expect(adapters).toEqual({
        ongoing: null,
        finished: 0,
        commitment: "full_year",
        inProgramme: true,
      });
    },
  );

  integrationTest(
    "a licence outside the programme (no opt-in window, no opt-ins) earns no share",
    async () => {
      const f = await school({}, "Not In The Programme");
      const licence = await programmeLicence(f, 350, {}, 10, false);
      await lock(f, licenceMonths(licence)[0]!.measureOn);
      const first = await pay(f, licence.invoiceId, 140_000, licence.start);
      expect(first.licenseActivated).toBe(true);
      expect(await ledger(f)).toEqual([]);
      const snapshots = await asAdmin(
        f.schoolId,
        (tx) => tx`
        SELECT 1 FROM app.ai_programme_conversion_snapshots
        WHERE school_id = ${f.schoolId}::uuid
      `,
      );
      expect(snapshots).toHaveLength(0);
    },
  );
});

describe("the programme values a share uses", () => {
  integrationTest(
    "the licence's signed version, through new global versions, until the current ones are re-applied",
    async () => {
      const f = await school();
      const licence = await programmeLicence(f);
      const signedVersion = (
        await asAdmin(f.schoolId, async (tx) => (await readLicense(tx, licence.licenseId))!)
      ).aiProgrammeVersionId;

      // The engine's reader resolves exactly what the settings console does.
      await asAdmin(f.schoolId, async (tx) => {
        const license = (await readLicense(tx, licence.licenseId))!;
        const console = await licenseAiProgramme(tx, license);
        const engine = await readProgrammeValues(
          tx,
          { versionId: license.aiProgrammeVersionId, overrideId: license.aiProgrammeOverrideId },
          license.currencyCode,
        );
        expect(engine).toEqual(console.signed);
      });

      // A pending share is recorded, then Studafy lowers the 70% tier to 8% for new licences.
      await pay(f, licence.invoiceId, 140_000, licence.start);
      const current = await asAdmin(null, currentAiProgrammeVersion);
      await asAdmin(null, (tx) =>
        saveAiProgrammeVersion(
          tx,
          {
            ...current.settings,
            conversionTiers: current.settings.conversionTiers.map((t) =>
              t.fromBps === 7000 ? { ...t, shareBps: 800 } : t,
            ),
            reason: "Lower 70% tier for new licences",
            basedOnVersionId: current.id,
          },
          operator,
        ),
      );
      await pay(f, licence.invoiceId, 140_000, licence.due(2));
      await lockMonths(f, licence, 2);
      await recompute(f, latest(licence.due(2), licenceMonths(licence)[1]!.measureOn));
      let entries = byPosition(await ledger(f));
      expect(entries.map((e) => [e.programmeVersionId, e.totalBps])).toEqual([
        [signedVersion, 1300],
        [signedVersion, 1300],
      ]);

      // Re-applied: the next payment uses the new values; what was recorded keeps its own.
      await asAdmin(f.schoolId, async (tx) => {
        const license = (await readLicense(tx, licence.licenseId, { forUpdate: true }))!;
        await reapplyAiProgramme(tx, f.schoolId, license, "Move to current values", operator);
      });
      await pay(f, licence.invoiceId, 140_000, licence.due(3));
      await lockMonths(f, licence, 3);
      await recompute(f, latest(licence.due(3), licenceMonths(licence)[2]!.measureOn));
      entries = byPosition(await ledger(f));
      const newVersion = (await asAdmin(null, currentAiProgrammeVersion)).id;
      expect(entries.map((e) => [e.programmeVersionId, e.conversionShareBps, e.totalBps])).toEqual([
        [signedVersion, 1000, 1300],
        [signedVersion, 1000, 1300],
        [newVersion, 800, 1100],
      ]);
    },
  );
});
