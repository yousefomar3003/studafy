/**
 * Student AI opt-in and programme seats against a real database (migration 000235): opening and
 * closing a window (licence, price, minimum seats acknowledged); a parent's opt-in (terms, price
 * shown, late opt-in priced for the months left, window and eligibility, one per year, cannot be
 * undone); the school recording on a parent's behalf (single, bulk, admission numbers, note,
 * audited); seats following opt-ins (assigned through the seat model, waiting when the licence is
 * full, the automatic seat request sized to the minimum, filled when seats grow); a leaving
 * student's seat transferred or released from the next month (and the generic unassign refused);
 * parents isolated across families and schools; and the routes' permissions.
 */

import { ROLES } from "@studafy/constants";
import { AI_OPTIN_TERMS_VERSION } from "@studafy/license-pricing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { runLicenseChange } from "../../src/modules/licensing";
import {
  closeWindow,
  fillWaitingOptInSeats,
  listOptInStudents,
  openWindow,
  parentOffers,
  parentOptIn,
  recordOnBehalf,
  releaseOptIn,
  schoolAiOptInOverview,
  transferOptIn,
} from "../../src/modules/licensing/ai-optin";
import { unassignSeat, updateLicense } from "../../src/modules/licensing/service";
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

import { insertPriceOverride } from "./programme-optins";

import type { LicenseActor, LicensingDeps } from "../../src/modules/licensing";
import type { OpenWindowInput } from "../../src/modules/licensing/ai-optin";
import type { PendingRenewalStop } from "../../src/modules/licensing/overlap";
import type { TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const logger = createLogger({ destination: () => undefined });
const VERSION = "a1000000-0000-4000-8000-000000000001";

/** Mid-November: a late opt-in in a September-June year covers November to June, 8 months. */
const NOW = new Date("2026-11-17T10:00:00Z");
const BEFORE_YEAR = new Date("2026-08-20T10:00:00Z");

let db: TestDatabase;
let hq: string;
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

/** As the runtime role, as one user: what RLS lets them see and do. */
async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** A change in a school as `actor`, through the flow the routes use. */
function as<T>(
  schoolId: string,
  actor: LicenseActor,
  fn: (
    tx: TransactionSql,
  ) => Promise<{ result: T; versions?: Map<string, number>; pending?: PendingRenewalStop[] }>,
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
    const { code, message } = err as { code?: string; message?: string };
    // Coded API errors are their code; a database refusal its SQLSTATE, or its message for a
    // trigger's check_violation (several share 23514).
    return code === "23514" ? (message ?? code) : (code ?? String(err));
  }
  return "no refusal";
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "optin-ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };
  studentTier = await asAdmin(null, async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_ai_optin', 'Student AI', 'student', 3) RETURNING id::text AS id
    `;
    return plan!.id;
  });
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

interface Fixture {
  schoolId: string;
  admin: LicenseActor;
  licenseId: string;
  yearId: string;
  gradeId: string;
  sectionA: string;
  sectionB: string;
}

/** A school with an active licence of `seats` student seats and a September-June academic year. */
async function school(seats = 5, options: { license?: boolean } = {}): Promise<Fixture> {
  const schoolId = (await createSchool(db.sql)).id;
  const adminUser = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, adminUser.id, "ORG_ADMIN");
  return asAdmin(schoolId, async (tx) => {
    // This suite's prices, set explicitly: parents $6 a month, the licence $4 a seat a month (the
    // global defaults are $4 and $4).
    const overrideId =
      options.license === false
        ? null
        : await insertPriceOverride(tx, {
            schoolId,
            createdBy: operator.userId,
            createdBySchoolId: hq,
            parentPriceMinor: 600,
            licensePriceMinor: 400,
          });
    const [license] =
      options.license === false
        ? [{ id: "" }]
        : await tx<{ id: string }[]>`
            INSERT INTO app.school_licenses (
              school_id, status, starts_at, ends_at, student_plan_id, student_seats, currency_id,
              created_by, activated_at, ai_programme_version_id, ai_programme_override_id
            )
            SELECT ${schoolId}::uuid, 'active', '2026-09-01T00:00:00Z', '2027-07-01T00:00:00Z',
                   ${studentTier}::uuid, ${seats}, c.id, ${adminUser.id}::uuid, now(),
                   ${VERSION}::uuid, ${overrideId}::uuid
            FROM app.currencies AS c WHERE c.code = 'USD'
            RETURNING id::text AS id
          `;
    const [year] = await tx<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${schoolId}::uuid, 'AY-2026', '2026-27', '2026-09-01', '2027-06-30', 'active')
      RETURNING id::text AS id
    `;
    const [grade] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_levels (school_id, name, sort_order)
      VALUES (${schoolId}::uuid, 'Grade 5', 5) RETURNING id::text AS id
    `;
    const sections = await tx<{ id: string }[]>`
      INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
      VALUES (${schoolId}::uuid, ${year!.id}::uuid, ${grade!.id}::uuid, 'A'),
             (${schoolId}::uuid, ${year!.id}::uuid, ${grade!.id}::uuid, 'B')
      RETURNING id::text AS id
    `;
    return {
      schoolId,
      admin: { kind: "school", userId: adminUser.id, homeSchoolId: schoolId } as LicenseActor,
      licenseId: license!.id,
      yearId: year!.id,
      gradeId: grade!.id,
      sectionA: sections[0]!.id,
      sectionB: sections[1]!.id,
    };
  });
}

interface Child {
  studentId: string;
  userId: string;
  admissionNumber: string;
  parent: LicenseActor;
}

/** An enrolled child placed in `sectionId`, with a parent (new, or the one given). */
async function child(f: Fixture, sectionId: string, parent?: LicenseActor): Promise<Child> {
  const student = await createStudent(db.sql, f.schoolId, { firstName: "Amina", lastName: "Tazi" });
  let parentActor = parent;
  if (!parentActor) {
    const parentUser = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, parentUser.id, "PARENT");
    parentActor = { kind: "school", userId: parentUser.id, homeSchoolId: f.schoolId };
  }
  await asAdmin(f.schoolId, async (tx) => {
    await tx`
      INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
      VALUES (${f.schoolId}::uuid, ${student.id}::uuid, ${f.yearId}::uuid, ${sectionId}::uuid)
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${f.schoolId}::uuid, 'Family', ${parentActor!.userId}::uuid)
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${f.schoolId}::uuid, ${parentActor!.userId}::uuid, ${student.id}::uuid, 'mother',
              ${family!.id}::uuid)
    `;
  });
  return {
    studentId: student.id,
    userId: student.userId,
    admissionNumber: student.admissionNumber,
    parent: parentActor,
  };
}

const window = (overrides: Partial<OpenWindowInput> = {}): OpenWindowInput => ({
  opensOn: "2026-11-01",
  closesOn: "2026-12-15",
  acknowledgeMinimumSeats: true,
  ...overrides,
});

async function open(f: Fixture, overrides: Partial<OpenWindowInput> = {}, now = NOW) {
  return as(f.schoolId, f.admin, async (tx) => ({
    result: await openWindow(tx, f.schoolId, window(overrides), f.admin, now),
  }));
}

function optIn(
  c: Child,
  f: Fixture,
  now = NOW,
  acceptTerms = true,
  termsVersion = AI_OPTIN_TERMS_VERSION,
) {
  return as(f.schoolId, c.parent, (tx) =>
    parentOptIn(
      tx,
      f.schoolId,
      { studentId: c.studentId, acceptTerms, termsVersion },
      c.parent,
      now,
    ),
  );
}

async function leave(f: Fixture, studentId: string) {
  await asAdmin(
    f.schoolId,
    (tx) => tx`UPDATE app.students SET status = 'withdrawn' WHERE id = ${studentId}::uuid`,
  );
}

async function seatOf(f: Fixture, optInId: string) {
  return asAdmin(f.schoolId, async (tx) => {
    const [row] = await tx<{ seat_id: string | null; unassigned_at: Date | null }[]>`
      SELECT o.seat_id::text AS seat_id, s.unassigned_at
      FROM app.ai_optins AS o LEFT JOIN app.license_seats AS s ON s.id = o.seat_id
      WHERE o.id = ${optInId}::uuid
    `;
    return row!;
  });
}

async function seatRequests(f: Fixture) {
  const rows = await asAdmin(
    f.schoolId,
    (tx) => tx<{ student_seats: number; status: string; source: string }[]>`
      SELECT student_seats, status, source FROM app.license_change_requests
      WHERE school_id = ${f.schoolId}::uuid ORDER BY created_at
    `,
  );
  return [...rows];
}

// ---------------------------------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------------------------------

describe("windows", () => {
  integrationTest("needs a licence and the minimum accepted; one open at a time", async () => {
    const none = await school(5, { license: false });
    expect(await refusal(open(none))).toBe("AI_OPTIN_NO_LICENCE");

    const f = await school(5);
    expect(await refusal(open(f, { acknowledgeMinimumSeats: false }))).toBe(
      "AI_OPTIN_MINIMUM_NOT_ACKNOWLEDGED",
    );
    expect(await refusal(open(f, { closesOn: "2027-08-01" }))).toBe("AI_OPTIN_WINDOW_INVALID");
    expect(await refusal(open(f, { opensOn: "2026-12-20", closesOn: "2026-12-01" }))).toBe(
      "AI_OPTIN_WINDOW_INVALID",
    );

    const opened = await open(f);
    expect(opened.state).toBe("open");
    expect(opened.academicYear.name).toBe("2026-27");
    expect(await refusal(open(f))).toBe("AI_OPTIN_WINDOW_ALREADY_OPEN");

    // Accepting the minimum asks Studafy for it: 5 seats < 30, an automatic request for 30.
    expect(await seatRequests(f)).toEqual([
      { student_seats: 30, status: "open", source: "ai_optin" },
    ]);

    const closed = await as(f.schoolId, f.admin, async (tx) => ({
      result: await closeWindow(tx, f.schoolId, opened.id, f.admin, NOW),
    }));
    expect(closed.state).toBe("closed");
    expect((await open(f, { opensOn: "2026-11-20" })).state).toBe("scheduled");
  });

  integrationTest("the overview shows price, months, minimum and counts", async () => {
    const f = await school(5);
    await open(f);
    await child(f, f.sectionA);
    const overview = await asUser(f.schoolId, f.admin.userId, (tx) =>
      schoolAiOptInOverview(tx, NOW),
    );
    expect(overview.blocker).toBeNull();
    expect(overview.programme).toMatchObject({
      currencyCode: "USD",
      monthlyPriceMinor: 600,
      minSeats: 30,
    });
    expect(overview.pricingToday).toEqual({
      startMonth: "2026-11-01",
      endMonth: "2027-06-01",
      months: 8,
      totalMinor: 4800,
    });
    expect(overview.counts.eligible).toBe(1);
    expect(overview.seatsNeeded).toBe(30);
    expect(overview.openSeatRequest?.studentSeats).toBe(30);
  });
});

// ---------------------------------------------------------------------------------------------------
// A parent opts in
// ---------------------------------------------------------------------------------------------------

describe("a parent opts in", () => {
  integrationTest(
    "the current terms are required; late opt-in pays the months left at the price in force",
    async () => {
      const f = await school(5);
      await open(f);
      const c = await child(f, f.sectionA);

      expect(await refusal(optIn(c, f, NOW, false))).toBe("AI_OPTIN_TERMS_REQUIRED");
      // Terms the parent read before they changed are not the terms in force.
      expect(await refusal(optIn(c, f, NOW, true, "2026-11-17"))).toBe("AI_OPTIN_TERMS_CHANGED");

      // No price is echoed back by the parent: the price in force is snapshotted for billing.
      const made = await optIn(c, f);
      expect(made).toMatchObject({
        source: "parent",
        status: "active",
        termsVersion: AI_OPTIN_TERMS_VERSION,
        startMonth: "2026-11-01",
        endMonth: "2027-06-01",
        months: 8,
        monthlyPriceMinor: 600,
        totalMinor: 4800,
        parent: { userId: c.parent.userId },
        recordedBy: { userId: c.parent.userId },
      });
      // A seat on the licence, through the seat model.
      expect(made.seatId).not.toBeNull();
      const seat = await seatOf(f, made.id);
      expect(seat.unassigned_at).toBeNull();

      expect(await refusal(optIn(c, f))).toBe("AI_OPTIN_ALREADY_OPTED_IN");

      // The confirmation, in-app (push sends it), to the child's parent.
      const sent = await asAdmin(
        f.schoolId,
        (tx) => tx<{ body: string }[]>`
          SELECT body FROM app.notifications
          WHERE user_id = ${c.parent.userId}::uuid AND notification_type = 'AI_OPTIN_CONFIRMED'
        `,
      );
      expect(sent.map((n) => n.body)).toEqual(["Student AI confirmed for Amina Tazi"]);
    },
  );

  integrationTest("before the year starts, the whole academic year", async () => {
    const f = await school(5);
    await open(f, { opensOn: "2026-08-15", closesOn: "2026-09-30" }, BEFORE_YEAR);
    const c = await child(f, f.sectionA);
    const made = await optIn(c, f, BEFORE_YEAR);
    expect(made).toMatchObject({ startMonth: "2026-09-01", months: 10, totalMinor: 6000 });
  });

  integrationTest("only while a window is open, only for children in it", async () => {
    const f = await school(5);
    const c = await child(f, f.sectionA);
    expect(await refusal(optIn(c, f))).toBe("AI_OPTIN_WINDOW_CLOSED");

    await open(f, { sectionIds: [f.sectionB] });
    expect(await refusal(optIn(c, f))).toBe("AI_OPTIN_NOT_ELIGIBLE");

    // Another family's child: not theirs to opt in.
    const other = await child(f, f.sectionB);
    expect(
      await refusal(
        as(f.schoolId, c.parent, (tx) =>
          parentOptIn(
            tx,
            f.schoolId,
            {
              studentId: other.studentId,
              acceptTerms: true,
              termsVersion: AI_OPTIN_TERMS_VERSION,
            },
            c.parent,
            NOW,
          ),
        ),
      ),
    ).toBe("AI_OPTIN_NOT_ELIGIBLE");
  });

  integrationTest(
    "cannot be undone: not by the parent, not by deleting, not by unassigning",
    async () => {
      const f = await school(5);
      await open(f);
      const c = await child(f, f.sectionA);
      const made = await optIn(c, f);

      // The parent's own transaction cannot end it: only leadership may (ai_optins_end_scope).
      expect(
        await refusal(
          asUser(
            f.schoolId,
            c.parent.userId,
            (tx) => tx`
              UPDATE app.ai_optins SET status = 'released', ended_at = now(),
                ended_by = ${c.parent.userId}::uuid, end_note = 'changed my mind',
                released_effective_month = '2026-12-01'
              WHERE id = ${made.id}::uuid
            `,
          ),
        ),
      ).toBe("42501");
      // Nor change the price, nor delete it, whoever asks.
      expect(
        await refusal(
          asAdmin(
            f.schoolId,
            (tx) => tx`UPDATE app.ai_optins SET months = 1 WHERE id = ${made.id}::uuid`,
          ),
        ),
      ).toContain("cannot be changed");
      expect(
        await refusal(
          asAdmin(f.schoolId, (tx) => tx`DELETE FROM app.ai_optins WHERE id = ${made.id}::uuid`),
        ),
      ).toContain("never deleted");

      // The generic unassign refuses a programme seat, in the API and in the database.
      expect(
        await refusal(
          as(f.schoolId, f.admin, (tx) =>
            unassignSeat(tx, f.schoolId, f.licenseId, made.seatId!, f.admin),
          ),
        ),
      ).toBe("LICENSE_SEAT_PROGRAMME_LOCKED");
      expect(
        await refusal(
          asAdmin(
            f.schoolId,
            (tx) => tx`
            UPDATE app.license_seats SET unassigned_at = now(), unassigned_by = ${f.admin.userId}::uuid
            WHERE id = ${made.seatId!}::uuid
          `,
          ),
        ),
      ).toContain("transfer or release");
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// The school records on a parent's behalf
// ---------------------------------------------------------------------------------------------------

describe("on a parent's behalf", () => {
  integrationTest("single, bulk and admission numbers, with a note, audited", async () => {
    const f = await school(10);
    await open(f, { gradeLevelIds: [f.gradeId] });
    const a = await child(f, f.sectionA);
    const b = await child(f, f.sectionB);
    const already = await child(f, f.sectionA);
    await optIn(already, f);

    const result = await as(f.schoolId, f.admin, (tx) =>
      recordOnBehalf(
        tx,
        f.schoolId,
        {
          studentIds: [a.studentId, already.studentId],
          admissionNumbers: [b.admissionNumber.toLowerCase(), "NO-SUCH-NUMBER"],
          note: "Paper form signed at enrolment",
        },
        f.admin,
        NOW,
      ),
    );
    expect(result.recorded.map((o) => o.studentId).sort()).toEqual(
      [a.studentId, b.studentId].sort(),
    );
    expect(result.recorded[0]).toMatchObject({
      source: "school_on_behalf",
      parent: null,
      note: "Paper form signed at enrolment",
      recordedBy: { userId: f.admin.userId },
      totalMinor: 4800,
    });
    expect(result.notRecorded).toEqual(
      expect.arrayContaining([
        { studentId: null, reference: "NO-SUCH-NUMBER", reason: "not_found" },
        {
          studentId: already.studentId,
          reference: already.studentId,
          reason: "already_opted_in",
        },
      ]),
    );

    const audited = await asAdmin(
      f.schoolId,
      (tx) => tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.audit_logs
        WHERE school_id = ${f.schoolId}::uuid AND target_table = 'ai_optins' AND action = 'insert'
      `,
    );
    expect(audited[0]!.n).toBe(3);

    // The child's parent is told, as for their own opt-in.
    const told = await asAdmin(
      f.schoolId,
      (tx) => tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM app.notifications
        WHERE user_id = ${a.parent.userId}::uuid AND notification_type = 'AI_OPTIN_CONFIRMED'
      `,
    );
    expect(told[0]!.n).toBe(1);

    const list = await asUser(f.schoolId, f.admin.userId, (tx) =>
      listOptInStudents(tx, { filter: "opted_in", limit: 50, offset: 0 }, NOW),
    );
    expect(list.total).toBe(3);
  });

  integrationTest("refused while no window is open", async () => {
    const f = await school(10);
    const a = await child(f, f.sectionA);
    expect(
      await refusal(
        as(f.schoolId, f.admin, (tx) =>
          recordOnBehalf(
            tx,
            f.schoolId,
            { studentIds: [a.studentId], note: "Phone call" },
            f.admin,
            NOW,
          ),
        ),
      ),
    ).toBe("AI_OPTIN_WINDOW_CLOSED");
  });
});

// ---------------------------------------------------------------------------------------------------
// Seats follow opt-ins
// ---------------------------------------------------------------------------------------------------

describe("seats", () => {
  integrationTest(
    "opt-ins beyond the licence wait, the request grows, more seats fill them",
    async () => {
      const f = await school(2);
      await open(f);
      const kids = [
        await child(f, f.sectionA),
        await child(f, f.sectionA),
        await child(f, f.sectionB),
      ];
      const made = [];
      for (const kid of kids) made.push(await optIn(kid, f));
      expect(made.map((o) => o.seatId !== null)).toEqual([true, true, false]);

      // One automatic request, at the minimum (30 > 3 opt-ins).
      expect(await seatRequests(f)).toEqual([
        { student_seats: 30, status: "open", source: "ai_optin" },
      ]);

      // The super admin raises the licence (what a seat-increase quote does): the wait is over.
      await as(f.schoolId, operator, async (tx) => {
        const changed = await updateLicense(
          tx,
          f.schoolId,
          f.licenseId,
          { student: { planId: studentTier, seats: 30 } },
          operator,
        );
        const filled = await fillWaitingOptInSeats(tx, f.schoolId, f.licenseId, operator, NOW);
        expect(filled.result).toBe(1);
        return { result: changed.result };
      });
      expect((await seatOf(f, made[2]!.id)).seat_id).not.toBeNull();
    },
  );

  integrationTest(
    "a student who already holds a seat keeps it, now for the programme",
    async () => {
      const f = await school(5);
      const c = await child(f, f.sectionA);
      const seatId = await asAdmin(f.schoolId, async (tx) => {
        const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.license_seats (school_id, license_id, audience, user_id, student_id, assigned_by)
        VALUES (${f.schoolId}::uuid, ${f.licenseId}::uuid, 'student', ${c.userId}::uuid,
                ${c.studentId}::uuid, ${f.admin.userId}::uuid)
        RETURNING id::text AS id
      `;
        return row!.id;
      });
      await open(f);
      const made = await optIn(c, f);
      expect(made.seatId).toBe(seatId);
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// A student leaves
// ---------------------------------------------------------------------------------------------------

describe("a student leaves", () => {
  integrationTest(
    "release: only once they left; not charged from next month; seat frees",
    async () => {
      const f = await school(1);
      await open(f);
      const leaver = await child(f, f.sectionA);
      const waiting = await child(f, f.sectionA);
      const held = await optIn(leaver, f);
      const queued = await optIn(waiting, f);
      expect(queued.seatId).toBeNull();

      const release = () =>
        as(f.schoolId, f.admin, (tx) =>
          releaseOptIn(tx, f.schoolId, held.id, { note: "Moved abroad" }, f.admin, NOW),
        );
      expect(await refusal(release())).toBe("AI_OPTIN_STUDENT_NOT_LEFT");

      await leave(f, leaver.studentId);
      const released = await release();
      expect(released).toMatchObject({
        status: "released",
        releasedEffectiveMonth: "2026-12-01",
        endNote: "Moved abroad",
      });
      expect((await seatOf(f, held.id)).unassigned_at).not.toBeNull();
      // The freed seat goes to the student waiting for one.
      expect((await seatOf(f, queued.id)).seat_id).not.toBeNull();
      expect(await refusal(release())).toBe("AI_OPTIN_ENDED");
    },
  );

  integrationTest(
    "transfer: the seat goes to another student, same price, no billing change",
    async () => {
      const f = await school(1);
      await open(f);
      const leaver = await child(f, f.sectionA);
      const next = await child(f, f.sectionB);
      const held = await optIn(leaver, f);
      await leave(f, leaver.studentId);

      const moved = await as(f.schoolId, f.admin, (tx) =>
        transferOptIn(
          tx,
          f.schoolId,
          held.id,
          { toStudentId: next.studentId, note: "Seat given to a sibling" },
          f.admin,
          NOW,
        ),
      );
      expect(moved.from).toMatchObject({ status: "transferred", transferredToId: moved.to.id });
      expect(moved.to).toMatchObject({
        source: "transfer",
        status: "active",
        transferredFromId: held.id,
        monthlyPriceMinor: 600,
        // Charged from the month after the transfer: the leaver pays through November.
        startMonth: "2026-12-01",
        months: 7,
        studentId: next.studentId,
      });
      expect(moved.to.seatId).not.toBeNull();
      expect((await seatOf(f, held.id)).unassigned_at).not.toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------------------------------

describe("isolation", () => {
  integrationTest("a parent sees only their own children, in their own school", async () => {
    const f = await school(10);
    await open(f);
    const mine = await child(f, f.sectionA);
    const sibling = await child(f, f.sectionB, mine.parent);
    const theirs = await child(f, f.sectionA);
    await optIn(mine, f);
    await optIn(theirs, f);

    const offers = await asUser(f.schoolId, mine.parent.userId, (tx) =>
      parentOffers(tx, mine.parent.userId, NOW),
    );
    expect(offers.offers.map((o) => [o.studentId, o.state]).sort()).toEqual(
      [
        [mine.studentId, "opted_in"],
        [sibling.studentId, "available"],
      ].sort(),
    );
    const available = offers.offers.find((o) => o.state === "available")!;
    // The months joining today covers; never a price (the school tells parents).
    expect(available.period).toEqual({ startMonth: "2026-11-01", endMonth: "2027-06-01" });
    expect(Object.keys(available)).not.toContain("pricing");
    const confirmed = offers.offers.find((o) => o.state === "opted_in")!;
    expect(confirmed.optIn).toMatchObject({ status: "active", startMonth: "2026-11-01" });
    expect(Object.keys(confirmed.optIn!).sort()).toEqual(
      [
        "endMonth",
        "id",
        "optedInAt",
        "releasedEffectiveMonth",
        "source",
        "startMonth",
        "status",
        "studentId",
        "studentName",
        "termsVersion",
        "waitingForSchool",
      ].sort(),
    );

    // RLS: the other family's opt-in is invisible to this parent.
    const visible = await asUser(
      f.schoolId,
      mine.parent.userId,
      (tx) =>
        tx<{ student_id: string }[]>`SELECT student_id::text AS student_id FROM app.ai_optins`,
    );
    expect(visible.map((r) => r.student_id)).toEqual([mine.studentId]);

    // Another school: its own window, its own children; nothing of the first school.
    const g = await school(10);
    const elsewhere = await child(g, g.sectionA);
    const none = await asUser(
      g.schoolId,
      elsewhere.parent.userId,
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM app.ai_optins`,
    );
    expect(none[0]!.n).toBe(0);
    const closed = await asUser(g.schoolId, elsewhere.parent.userId, (tx) =>
      parentOffers(tx, elsewhere.parent.userId, NOW),
    );
    expect(closed.offers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Routes
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

  integrationTest("leadership manages; a parent opts in; nobody else does either", async () => {
    const f = await school(10);
    const c = await child(f, f.sectionA);
    const teacher = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, teacher.id, "INSTRUCTOR");
    const request = (
      userId: string,
      roles: string[],
      method: string,
      path: string,
      body?: unknown,
    ) =>
      authenticatedRequest(
        api,
        method,
        path,
        {
          schoolId: f.schoolId,
          userId,
          roles: roles as never,
          channel: AUTH_CHANNELS.WEB,
        },
        body === undefined ? undefined : json(body),
      );

    expect(
      (await request(teacher.id, [ROLES.INSTRUCTOR], "GET", "/api/school/license/student-ai"))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          c.parent.userId,
          [ROLES.PARENT],
          "POST",
          "/api/school/license/student-ai/windows",
          {},
        )
      ).status,
    ).toBe(403);
    // The school admin does not hold the parent's permission: it records on their behalf instead.
    expect(
      (await request(f.admin.userId, [ROLES.ORG_ADMIN], "GET", "/api/parent/student-ai")).status,
    ).toBe(403);

    const today = new Date().toISOString().slice(0, 10);
    const opened = await request(
      f.admin.userId,
      [ROLES.ORG_ADMIN],
      "POST",
      "/api/school/license/student-ai/windows",
      {
        opensOn: today,
        closesOn: "2027-06-30",
        acknowledgeMinimumSeats: true,
      },
    );
    expect(opened.status).toBe(201);

    const offers = await request(c.parent.userId, [ROLES.PARENT], "GET", "/api/parent/student-ai");
    expect(offers.status).toBe(200);
    const body = (await offers.json()) as {
      schoolName: string;
      offers: { studentId: string; state: string }[];
      termsVersion: string;
    };
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]!.state).toBe("available");

    const made = await request(
      c.parent.userId,
      [ROLES.PARENT],
      "POST",
      "/api/parent/student-ai/opt-ins",
      {
        studentId: c.studentId,
        acceptTerms: true,
        termsVersion: body.termsVersion,
      },
    );
    expect(made.status).toBe(201);
    // The parent's confirmation carries no price, total or currency.
    const madeBody = (await made.json()) as Record<string, unknown>;
    expect(madeBody).toMatchObject({ studentId: c.studentId, status: "active" });
    for (const key of Object.keys(madeBody)) {
      expect(key).not.toMatch(/price|total|minor|currency|amount/i);
    }

    const overview = await request(
      f.admin.userId,
      [ROLES.PRINCIPAL],
      "GET",
      "/api/school/license/student-ai",
    );
    expect(overview.status).toBe(200);
    expect(((await overview.json()) as { counts: { optedIn: number } }).counts.optedIn).toBe(1);
  });
});
