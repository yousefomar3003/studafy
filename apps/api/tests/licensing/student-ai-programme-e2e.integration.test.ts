/**
 * The Student AI programme end to end, against a real database, through the integrated phases:
 *
 *   window (phase 2) -> a parent's opt-in and one recorded on a parent's behalf -> licence seats ->
 *   the tuition lines (phase 3, re-synced after each opt-in commits) -> the conversion locked on day
 *   30 (phase 5, measured from phase 2's opt-ins) -> a payment recorded -> its share entry, with the
 *   content bonus from the real upload consistency (phase 4, the classes of students holding
 *   programme seats) -> the share credited on the school's next invoice.
 *
 * The school year began two months ago. Opt-ins can only be taken "now" through the routes, so once
 * they are made the test moves them back to the start of the year (the one place it edits history,
 * with triggers off, as if they had been taken then): the licence, the measurement day and the
 * period the payment covers are all in the past, as they are for a real school mid-year.
 */

import {
  REVENUE_SHARE_MEASURES,
  approveShares,
  lockDueConversionSnapshots,
} from "@studafy/billing";
import { ROLES } from "@studafy/constants";
import { academicYearMonths, monthCount, monthsBetween } from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import {
  acceptQuote,
  createQuote,
  recordPayment,
  runLicenseChange,
  sendQuote,
} from "../../src/modules/licensing";
import { requireInvoiceDetail } from "../../src/modules/licensing/invoices";
import { listRevenueShareEntries } from "../../src/modules/licensing/revenue-share";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import { insertPriceOverride } from "./programme-optins";

import type { LicenseActor, LicensingDeps, QuoteTerms } from "../../src/modules/licensing";
import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const DAY = 86_400_000;

let db: TestDatabase;
let api: TestApp;
let operator: LicenseActor;
let studentTier = "";

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

/** A change as `actor`, through the flow the routes use. */
function as<T>(schoolId: string, actor: LicenseActor, fn: (tx: TransactionSql) => Promise<T>) {
  return runLicenseChange(deps(), schoolId, actor, async (tx) => ({
    result: await fn(tx),
    versions: new Map<string, number>(),
    pending: [],
  })).then((r) => r.result);
}

const ISO = (date: Date) => date.toISOString().slice(0, 10);
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  const created = createTestApp({ database: db.sql });
  await created.ready;
  api = created;

  const hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "programme-e2e-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', '', true)`;
    // The programme's school licence price, $4 a seat a month.
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_programme_e2e', 'Student AI', 'student', 2) RETURNING id::text AS id
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
  await db?.cleanup();
});

describe("the Student AI programme, end to end", () => {
  integrationTest(
    "window -> opt-ins -> seats -> tuition lines -> month 1's conversion -> payment -> share with the real bonus -> approval -> credit",
    async () => {
      // ---- The school: a year that began on the 1st two months ago, every day a school day (UTC+0). ----
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
      const yearEnd = new Date(addMonths(start, 10).getTime() - DAY);
      const schoolId = (await createSchool(db.sql, { name: "Programme School" })).id;
      const adminUser = await createUser(db.sql, schoolId);
      await assignRole(db.sql, schoolId, adminUser.id, ROLES.ORG_ADMIN);
      const financeUser = await createUser(db.sql, schoolId);
      await assignRole(db.sql, schoolId, financeUser.id, ROLES.FINANCE);
      const parentUser = await createUser(db.sql, schoolId);
      await assignRole(db.sql, schoolId, parentUser.id, ROLES.PARENT);
      const admin: LicenseActor = { kind: "school", userId: adminUser.id, homeSchoolId: schoolId };
      const teacher = await createTeacher(db.sql, schoolId);
      const kids = [
        await createStudent(db.sql, schoolId, { firstName: "Amina", lastName: "Tazi" }),
        await createStudent(db.sql, schoolId, { firstName: "Omar", lastName: "Haddad" }),
        await createStudent(db.sql, schoolId, { firstName: "Lina", lastName: "Saleh" }),
      ];

      const setup = await asAdmin(schoolId, async (tx) => {
        await tx`
          INSERT INTO app.school_settings (school_id, timezone, school_days)
          VALUES (${schoolId}::uuid, 'Africa/Abidjan', '{1,2,3,4,5,6,7}')
        `;
        const [year] = await tx<{ id: string }[]>`
          INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
          VALUES (${schoolId}::uuid, 'AY-E2E', 'This year', ${ISO(start)}::date,
                  ${ISO(yearEnd)}::date, 'active')
          RETURNING id::text AS id
        `;
        const [term] = await tx<{ id: string }[]>`
          INSERT INTO app.terms
            (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
          VALUES (${schoolId}::uuid, ${year!.id}::uuid, 'T1', 'Term 1', 1, ${ISO(start)}::date,
                  ${ISO(yearEnd)}::date, 'active')
          RETURNING id::text AS id
        `;
        const [subject] = await tx<{ id: string }[]>`
          INSERT INTO app.subjects (school_id, code, name, status)
          VALUES (${schoolId}::uuid, 'SCI', 'Science', 'active') RETURNING id::text AS id
        `;
        const [room] = await tx<{ id: string }[]>`
          INSERT INTO app.rooms (school_id, code, name, room_type, capacity, building)
          VALUES (${schoolId}::uuid, 'R1', 'Room', 'physical', 30, 'Main') RETURNING id::text AS id
        `;
        const [course] = await tx<{ id: string }[]>`
          INSERT INTO app.courses (school_id, subject_id, code, name, credit_hours, status)
          VALUES (${schoolId}::uuid, ${subject!.id}::uuid, 'ALG', 'Algebra', 1, 'active')
          RETURNING id::text AS id
        `;
        const [klass] = await tx<{ id: string }[]>`
          INSERT INTO app.classes
            (school_id, course_id, academic_year_id, term_id, lead_teacher_id, room_id, code, status)
          VALUES (${schoolId}::uuid, ${course!.id}::uuid, ${year!.id}::uuid, ${term!.id}::uuid,
                  ${teacher.id}::uuid, ${room!.id}::uuid, 'ALG-1', 'active')
          RETURNING id::text AS id
        `;
        const [family] = await tx<{ id: string }[]>`
          INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
          VALUES (${schoolId}::uuid, 'Tazi family', ${parentUser.id}::uuid)
          RETURNING id::text AS id
        `;
        for (const kid of kids) {
          await tx`
            INSERT INTO app.enrollments (school_id, class_id, student_id, enrolled_at)
            VALUES (${schoolId}::uuid, ${klass!.id}::uuid, ${kid.id}::uuid, ${start})
          `;
        }
        // The parent's child is the first; the second's parents use paper (recorded on behalf).
        await tx`
          INSERT INTO app.parent_child_links
            (school_id, parent_user_id, student_id, relationship, family_id)
          VALUES (${schoolId}::uuid, ${parentUser.id}::uuid, ${kids[0]!.id}::uuid, 'mother',
                  ${family!.id}::uuid)
        `;
        return { yearId: year!.id, classId: klass!.id, familyId: family!.id };
      });

      // The school's prices, set explicitly: parents $6, the licence $4 a seat a month (the global
      // defaults are $4 and $4). Before the quote, so the licence is signed with them.
      await asAdmin(schoolId, (tx) =>
        insertPriceOverride(tx, {
          schoolId,
          createdBy: operator.userId,
          createdBySchoolId: operator.homeSchoolId,
          parentPriceMinor: 600,
          licensePriceMinor: 400,
        }),
      );

      // ---- The licence: 30 seats (the minimum) x $4 x 10 months, monthly, from the year's start. ----
      const quote = await as(schoolId, operator, async (tx) => {
        const created = await createQuote(
          tx,
          schoolId,
          {
            kind: "new",
            currencyCode: "USD",
            months: 10,
            startsAt: start,
            student: { planId: studentTier, seats: 30 },
            paymentPlan: "monthly",
          } as QuoteTerms,
          operator,
        );
        return sendQuote(tx, schoolId, created.id, operator);
      });
      const accepted = (await as(schoolId, admin, (tx) =>
        acceptQuote(tx, schoolId, quote.id, admin).then((r) => r.result),
      )) as { invoice: { id: string; licenseId: string } };
      const invoiceId = accepted.invoice.id;
      const licenseId = accepted.invoice.licenseId;

      const request = (
        userId: string,
        roles: Role[],
        method: string,
        path: string,
        body?: unknown,
      ) =>
        authenticatedRequest(
          api,
          method,
          path,
          { schoolId, userId, roles, channel: AUTH_CHANNELS.WEB },
          body === undefined
            ? undefined
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
        );

      // ---- Phase 2: the school opens a window; a parent opts in; the school records another. ----
      const today = ISO(now);
      const opened = await request(
        adminUser.id,
        [ROLES.ORG_ADMIN],
        "POST",
        "/api/school/license/student-ai/windows",
        {
          opensOn: today,
          closesOn: ISO(new Date(now.getTime() + 14 * DAY)),
          acknowledgeMinimumSeats: true,
        },
      );
      expect(opened.status).toBe(201);

      const offers = (await (
        await request(parentUser.id, [ROLES.PARENT], "GET", "/api/parent/student-ai")
      ).json()) as {
        offers: { studentId: string; period: { startMonth: string; endMonth: string } }[];
        termsVersion: string;
      };
      const offer = offers.offers.find((o) => o.studentId === kids[0]!.id)!;
      // The parent is told the months, never the price (the school tells them).
      expect(JSON.stringify(offers)).not.toMatch(/price|total|minor|currency|amount/i);
      const monthsLeft = monthsBetween(offer.period.startMonth, offer.period.endMonth);
      const parentMade = await request(
        parentUser.id,
        [ROLES.PARENT],
        "POST",
        "/api/parent/student-ai/opt-ins",
        {
          studentId: kids[0]!.id,
          acceptTerms: true,
          termsVersion: offers.termsVersion,
        },
      );
      expect(parentMade.status).toBe(201);
      const recorded = await request(
        adminUser.id,
        [ROLES.ORG_ADMIN],
        "POST",
        "/api/school/license/student-ai/opt-ins",
        {
          studentIds: [kids[1]!.id],
          note: "Paper form signed at enrolment",
        },
      );
      expect(recorded.status).toBe(200);

      // Seats: both hold one of the licence's seats.
      const optIns = await asAdmin(
        schoolId,
        (tx) =>
          tx<{ id: string; student_id: string; seat_id: string | null; months: number }[]>`
          SELECT id::text AS id, student_id::text AS student_id, seat_id::text AS seat_id, months
          FROM app.ai_optins WHERE school_id = ${schoolId}::uuid ORDER BY opted_in_at
        `,
      );
      expect(optIns).toHaveLength(2);
      expect(optIns.every((o) => o.seat_id !== null)).toBe(true);

      // ---- Phase 3: the tuition lines followed the opt-ins as they committed. ----
      const lines = async () => {
        const response = await request(
          financeUser.id,
          [ROLES.FINANCE],
          "GET",
          "/api/finance/student-ai/lines",
        );
        expect(response.status).toBe(200);
        return (
          (await response.json()) as {
            lines: {
              student_id: string;
              months: number;
              total_minor: number;
              monthly_price_minor: number;
            }[];
          }
        ).lines;
      };
      const late = await lines();
      expect(late.map((l) => l.student_id).sort()).toEqual([kids[0]!.id, kids[1]!.id].sort());
      for (const line of late) {
        // Opted in this month: the months left in the year, $6 each.
        expect(line).toMatchObject({ months: monthsLeft, monthly_price_minor: 600 });
        expect(line.total_minor).toBe(600 * monthsLeft);
      }

      // ---- As if taken on the year's first day: move the opt-ins, seats and students back. ----
      const fullYear = monthCount(academicYearMonths(ISO(start), ISO(yearEnd)));
      expect(fullYear).toBe(10);
      const takenAt = new Date(start.getTime() + 8 * 3_600_000);
      await db.sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          UPDATE app.ai_optins
          SET opted_in_at = ${takenAt}, seat_assigned_at = ${takenAt}, created_at = ${takenAt},
              start_month = ${ISO(start)}::date, months = ${fullYear},
              total_minor = monthly_price_minor * ${fullYear}
          WHERE school_id = ${schoolId}::uuid
        `;
        await tx`
          UPDATE app.license_seats SET assigned_at = ${takenAt}
          WHERE school_id = ${schoolId}::uuid AND license_id = ${licenseId}::uuid
        `;
        await tx`
          UPDATE app.students SET created_at = ${new Date(start.getTime() - 10 * DAY)}
          WHERE school_id = ${schoolId}::uuid
        `;
      });
      const resynced = await request(
        financeUser.id,
        [ROLES.FINANCE],
        "POST",
        "/api/finance/student-ai/sync",
      );
      expect(resynced.status).toBe(200);
      for (const line of await lines()) {
        // $6 x 10 = $60, paid with tuition.
        expect(line).toMatchObject({ months: 10, total_minor: 6000 });
      }

      // ---- Teachers upload on every day of the first month but three (every day a school day). ----
      const daysInFirstMonth = new Date(
        Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
      ).getUTCDate();
      await asAdmin(schoolId, async (tx) => {
        for (let day = 1; day <= daysInFirstMonth - 3; day += 1) {
          const at = new Date(start.getTime() + (day - 1) * DAY + 9 * 3_600_000);
          await tx`
            INSERT INTO app.materials
              (school_id, class_id, uploaded_by_user_id, last_edited_by_user_id, title, storage_key,
               original_file_name, mime_type, size_bytes, ingest_status, ingested_at, published_at,
               source_kind)
            VALUES (${schoolId}::uuid, ${setup.classId}::uuid, ${teacher.userId}::uuid,
                    ${teacher.userId}::uuid, 'Lesson',
                    ${`permanent/${schoolId}/materials/${crypto.randomUUID()}`}, 'lesson.pdf',
                    'application/pdf', 1024, 'ready', ${at}, ${at}, 'class')
          `;
        }
      });
      const uploadBps = Math.floor(((daysInFirstMonth - 3) * 10_000) / daysInFirstMonth);
      expect(uploadBps).toBeGreaterThanOrEqual(8000);

      // ---- Phase 5: the hourly job locks month 1's conversion on its first day -- 2 of 3 enrolled
      // hold Student AI from the school, 66.66%. Conversion is monthly (owner, 2026-11-18). ----
      const measureDay = start;
      const locked = await asAdmin(schoolId, (tx) =>
        lockDueConversionSnapshots(tx, {
          schoolId,
          now: new Date(measureDay.getTime() + 3_600_000),
          audit: async () => undefined,
          measures: REVENUE_SHARE_MEASURES,
        }),
      );
      expect(locked).toHaveLength(1);
      expect(locked[0]).toMatchObject({
        enrolledCount: 3,
        optedInCount: 2,
        conversionBps: 6666,
        conversionShareBps: 800,
        // The large-school floor's test: the students the school provides Student AI to.
        seats: 2,
      });

      // ---- The school pays its first instalment on day 5: $120. ----
      const paid = (await as(schoolId, operator, (tx) =>
        recordPayment(
          tx,
          schoolId,
          invoiceId,
          {
            amountMinor: 12_000,
            receivedAt: new Date(start.getTime() + 5 * DAY),
            bankReference: "FT-E2E-1",
          },
          operator,
        ).then((r) => r.result),
      )) as { licenseActivated: boolean };
      expect(paid.licenseActivated).toBe(true);

      // Its share: 8% conversion + 3% content bonus (the real upload consistency) = 11% of $120,
      // final (month 1 is locked and over), waiting for the super admin's approval.
      const [entry] = await asAdmin(schoolId, (tx) => listRevenueShareEntries(tx, { licenseId }));
      expect(entry).toMatchObject({
        kind: "share",
        status: "awaiting_approval",
        collectedMinor: 12_000,
        baseMinor: 12_000,
        periodFrom: ISO(start),
        periodTo: ISO(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0))),
        conversionBps: 6666,
        conversionShareBps: 800,
        uploadConsistencyBps: uploadBps,
        bonusBps: 300,
        totalBps: 1100,
        amountMinor: 1_320,
        conversionPending: false,
        bonusPending: false,
      });

      // ---- A super admin approves it on the school's weekly statement: owed. ----
      await asAdmin(schoolId, (tx) =>
        approveShares(tx, { schoolId, now: new Date(), audit: async () => undefined }, [entry!.id]),
      );
      expect(
        (await asAdmin(schoolId, (tx) => listRevenueShareEntries(tx, { licenseId })))[0]!.status,
      ).toBe("owed");

      // ---- The school's next invoice (more seats) carries the credit. ----
      const increase = await as(schoolId, operator, async (tx) => {
        const created = await createQuote(
          tx,
          schoolId,
          {
            kind: "seat_increase",
            licenseId,
            student: { planId: studentTier, seats: 40 },
            paymentPlan: "monthly",
          } as QuoteTerms,
          operator,
        );
        return sendQuote(tx, schoolId, created.id, operator);
      });
      const next = (await as(schoolId, admin, (tx) =>
        acceptQuote(tx, schoolId, increase.id, admin).then((r) => r.result),
      )) as { invoice: { id: string } };
      const detail = await asAdmin(schoolId, (tx) =>
        requireInvoiceDetail(tx, next.invoice.id, operator),
      );
      expect(detail.lines.find((l) => l.kind === "ai_share_credit")).toMatchObject({
        amountMinor: -1_320,
      });
      expect(detail.creditTotalMinor).toBe(1_320);
      const [credited] = await asAdmin(schoolId, (tx) =>
        listRevenueShareEntries(tx, { licenseId }),
      );
      expect(credited).toMatchObject({ status: "credited", creditInvoiceId: next.invoice.id });

      // The parent sees only the Student AI line: never the licence price, the share, or the price
      // and total parents are charged (the school tells them).
      const family = await request(
        parentUser.id,
        [ROLES.PARENT],
        "GET",
        `/api/finance/families/${setup.familyId}`,
      );
      expect(family.status).toBe(200);
      const text = await family.text();
      expect(text).toContain("student_ai_lines");
      expect(text).not.toContain("share");
      expect(text).not.toContain("licen");
      const section = (
        JSON.parse(text) as { students: { student_ai_lines: Record<string, unknown>[] }[] }
      ).students.flatMap((s) => s.student_ai_lines);
      expect(section).toHaveLength(1);
      for (const key of Object.keys(section[0]!)) {
        expect(key).not.toMatch(/price|total|minor|currency|amount|invoiced|planned/i);
      }
    },
    120_000,
  );
});
