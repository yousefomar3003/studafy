/**
 * School licenses and seats against a real database (migration 000163, session 2 of
 * docs/billing/feature-licensing.md).
 *
 * What only Postgres can prove: the seat cap and eligibility triggers (including two assignments
 * racing for the last seat), tenant isolation of the new tables, resolution from real license and
 * seat rows, the overlap credit and renewal stops recorded against real personal subscriptions, the
 * entitlement version bumps and outbox events every change emits, and the routes' permissions.
 */

import { PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS } from "../../src/modules/auth/channels";
import { createFeatureService } from "../../src/modules/features";
import {
  assignSeats,
  createLicense,
  runLicenseChange,
  transitionLicense,
  unassignSeat,
  updateLicense,
} from "../../src/modules/licensing";
import { createEntitlementService } from "../../src/modules/subscriptions/entitlements/service";
import { createRedisClient } from "../../src/redis";
import {
  assignRole,
  authenticatedRequest,
  createAcademicYear,
  createSchool,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { LicenseActor, LicensingDeps, SeatScope } from "../../src/modules/licensing";
import type { RedisClient } from "../../src/redis";
import type { TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const redisUrl = process.env.REDIS_URL;
const redisTest = test.skipIf(!integrationEnabled || !redisUrl);

const logger = createLogger({ destination: () => undefined });

let db: TestDatabase;
let redis: RedisClient | null = null;
let hq: string;
let operator: LicenseActor;
const tiers = { student: "", teacher: "", parent: "" };

/** Provider mocks: record calls, fail on demand. */
const stripeCalls: string[] = [];
const googleCalls: string[] = [];
let stripeFails = false;

function deps(): LicensingDeps {
  return {
    database: db.sql,
    redis,
    logger,
    providers: {
      stripe: {
        scheduleCancellation: async ({
          providerSubscriptionId,
        }: {
          providerSubscriptionId: string;
        }) => {
          if (stripeFails) throw new Error("stripe is down");
          stripeCalls.push(providerSubscriptionId);
        },
      } as never,
      googlePlay: {
        cancel: async (token: string) => {
          googleCalls.push(token);
        },
      } as never,
    },
  };
}

async function asAdmin<T>(
  schoolId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    if (schoolId) await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
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

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase({ maxConnections: 12 });
  await migrateDatabase(db.url);
  if (redisUrl) {
    redis = createRedisClient({ url: redisUrl, logger });
    await redis.connect();
  }

  hq = (await createSchool(db.sql, { name: "Studafy HQ" })).id;
  const op = await createUser(db.sql, hq, { email: "ops@studafy.test" });
  await assignRole(db.sql, hq, op.id, "SUPER_ADMIN");
  operator = { kind: "platform", userId: op.id, homeSchoolId: hq };

  // Tiers: a priced student tier, a teacher tier that includes everything, a Family+ parent tier.
  await asAdmin(null, async (tx) => {
    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('student_plus_it', 'Student Plus', 'student', 2) RETURNING id::text AS id
    `;
    const [teacher] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank, includes_all_features)
      VALUES ('teacher_pro_it', 'Teacher Pro', 'teacher', 1, true) RETURNING id::text AS id
    `;
    const [parent] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, audience, rank)
      VALUES ('family_it', 'Family+', 'parent', 1) RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.plan_features (plan_id, feature_key, monthly_limit) VALUES
        (${student!.id}::uuid, 'ai_tutor', 300),
        (${student!.id}::uuid, 'study_tools', 50),
        (${parent!.id}::uuid, 'family_plus', NULL)
    `;
    // 30.00 USD per seat per month.
    await tx`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      SELECT ${student!.id}::uuid, id, 'monthly', 3000 FROM app.currencies WHERE code = 'USD'
    `;
    tiers.student = student!.id;
    tiers.teacher = teacher!.id;
    tiers.parent = parent!.id;
  });
}, 180_000);

afterAll(async () => {
  redis?.disconnect();
  await db?.cleanup();
});

// ---------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------

interface SchoolFixture {
  schoolId: string;
  admin: LicenseActor;
  adminUserId: string;
  students: { id: string; userId: string }[];
}

async function school(students = 3, name = "Licensed School"): Promise<SchoolFixture> {
  const schoolId = (await createSchool(db.sql, { name })).id;
  const admin = await createUser(db.sql, schoolId);
  await assignRole(db.sql, schoolId, admin.id, "ORG_ADMIN");
  const created = [];
  for (let i = 0; i < students; i += 1) {
    const s = await createStudent(db.sql, schoolId, {
      firstName: "Test",
      lastName: `Student ${String(i).padStart(2, "0")}`,
    });
    created.push({ id: s.id, userId: s.userId });
  }
  return {
    schoolId,
    adminUserId: admin.id,
    admin: { kind: "school", userId: admin.id, homeSchoolId: schoolId },
    students: created,
  };
}

async function parentOf(schoolId: string, studentId: string, email?: string): Promise<string> {
  const parent = await createUser(db.sql, schoolId, email ? { email } : undefined);
  await assignRole(db.sql, schoolId, parent.id, "PARENT");
  await asAdmin(schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'License test family', ${parent.id}::uuid)
      RETURNING id::text AS id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${studentId}::uuid, 'guardian')
    `;
  });
  return parent.id;
}

async function license(
  schoolId: string,
  seats: { student?: number; teacher?: number; parent?: number } = { student: 2 },
  options: { activate?: boolean; startsAt?: Date; endsAt?: Date } = {},
): Promise<string> {
  const { result } = await runLicenseChange(deps(), schoolId, operator, async (tx) => ({
    result: await createLicense(
      tx,
      schoolId,
      {
        startsAt: options.startsAt ?? new Date(Date.now() - 86_400_000),
        endsAt: options.endsAt ?? new Date(Date.now() + 365 * 86_400_000),
        currencyCode: "USD",
        includeFamilyPlus: (seats.parent ?? 0) > 0,
        student: seats.student ? { planId: tiers.student, seats: seats.student } : undefined,
        teacher: seats.teacher ? { planId: tiers.teacher, seats: seats.teacher } : undefined,
        parent: seats.parent ? { planId: tiers.parent, seats: seats.parent } : undefined,
      },
      operator,
    ),
    versions: new Map(),
    pending: [],
  }));
  if (options.activate ?? true) await setStatus(schoolId, result.id, "active");
  return result.id;
}

async function setStatus(
  schoolId: string,
  licenseId: string,
  status: "active" | "suspended" | "cancelled" | "awaiting_payment",
) {
  return runLicenseChange(deps(), schoolId, operator, (tx) =>
    transitionLicense(tx, schoolId, licenseId, status, operator),
  );
}

async function assign(
  f: SchoolFixture,
  licenseId: string,
  request:
    | { audience: "student" | "teacher" | "parent"; userIds: string[] }
    | { audience: "student" | "teacher" | "parent"; scope: SeatScope },
) {
  return runLicenseChange(deps(), f.schoolId, f.admin, (tx) =>
    assignSeats(tx, f.schoolId, licenseId, request, f.admin),
  );
}

function features(schoolId: string, userId: string) {
  const entitlements = createEntitlementService({ database: db.sql, redis: null, logger });
  return createFeatureService({ database: db.sql, entitlements, logger }).resolveFeatures(
    schoolId,
    userId,
  );
}

// ---------------------------------------------------------------------------------------------------
// Seat cap
// ---------------------------------------------------------------------------------------------------

describe("seat cap", () => {
  integrationTest("assigns until the purchased seats run out and reports the rest", async () => {
    const f = await school(3);
    const licenseId = await license(f.schoolId, { student: 2 });

    const { result } = await assign(f, licenseId, {
      audience: "student",
      userIds: f.students.map((s) => s.userId),
    });

    expect(result.assigned).toHaveLength(2);
    expect(result.notAssigned).toEqual([
      expect.objectContaining({ userId: f.students[2]!.userId, reason: "no_seats_left" }),
    ]);
  });

  integrationTest(
    "the database refuses a seat beyond the purchased count, whoever writes it",
    async () => {
      const f = await school(2);
      const licenseId = await license(f.schoolId, { student: 1 });
      const insert = (s: { id: string; userId: string }) =>
        asApp(
          f.schoolId,
          (tx) => tx`
        INSERT INTO app.license_seats (school_id, license_id, audience, user_id, student_id, assigned_by)
        VALUES (${f.schoolId}::uuid, ${licenseId}::uuid, 'student', ${s.userId}::uuid,
                ${s.id}::uuid, ${f.adminUserId}::uuid)
      `,
        );

      await insert(f.students[0]!);
      await expect(insert(f.students[1]!)).rejects.toThrow(
        /ck_license_seats_capacity|seats of license/,
      );
    },
  );

  integrationTest("two assignments racing for the last seat: exactly one gets it", async () => {
    const f = await school(2);
    const licenseId = await license(f.schoolId, { student: 1 });

    // Raw inserts, bypassing the service's own lock: only the trigger's row lock stands between them.
    const race = await Promise.allSettled(
      f.students.map((s) =>
        asApp(
          f.schoolId,
          (tx) => tx`
          INSERT INTO app.license_seats (school_id, license_id, audience, user_id, student_id, assigned_by)
          VALUES (${f.schoolId}::uuid, ${licenseId}::uuid, 'student', ${s.userId}::uuid,
                  ${s.id}::uuid, ${f.adminUserId}::uuid)
        `,
        ),
      ),
    );
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // And through the service, from two admins at once.
    const g = await school(2);
    const other = await license(g.schoolId, { student: 1 });
    const results = await Promise.all(
      g.students.map((s) => assign(g, other, { audience: "student", userIds: [s.userId] })),
    );
    expect(results.flatMap((r) => r.result.assigned)).toHaveLength(1);
    expect(results.flatMap((r) => r.result.notAssigned).map((n) => n.reason)).toEqual([
      "no_seats_left",
    ]);
    const [count] = await asAdmin(
      g.schoolId,
      (tx) => tx<{ n: string }[]>`
      SELECT count(*)::text AS n FROM app.license_seats WHERE license_id = ${other}::uuid AND unassigned_at IS NULL
    `,
    );
    expect(count!.n).toBe("1");
  });

  integrationTest("a seat count cannot drop below the seats already assigned", async () => {
    const f = await school(2);
    const licenseId = await license(f.schoolId, { student: 2 });
    await assign(f, licenseId, { audience: "student", userIds: f.students.map((s) => s.userId) });

    await expect(
      runLicenseChange(deps(), f.schoolId, operator, (tx) =>
        updateLicense(tx, f.schoolId, licenseId, { student: { seats: 1 } }, operator),
      ),
    ).rejects.toMatchObject({ code: "LICENSE_SEATS_BELOW_ASSIGNED" });
  });

  integrationTest("bulk: 'all eligible' fills seats in name order until they run out", async () => {
    const f = await school(3);
    const licenseId = await license(f.schoolId, { student: 2 });

    const { result } = await assign(f, licenseId, { audience: "student", scope: { kind: "all" } });

    expect(result.assigned.map((a) => a.name)).toEqual(["Test Student 00", "Test Student 01"]);
    expect(result.notAssigned).toEqual([
      expect.objectContaining({ userId: f.students[2]!.userId, reason: "no_seats_left" }),
    ]);
  });

  integrationTest("bulk by section seats that section's students only", async () => {
    const f = await school(3);
    const licenseId = await license(f.schoolId, { student: 10 });
    const year = await createAcademicYear(db.sql, f.schoolId);
    const sectionId = await asAdmin(f.schoolId, async (tx) => {
      const [grade] = await tx<{ id: string }[]>`
        INSERT INTO app.grade_levels (school_id, name, sort_order)
        VALUES (${f.schoolId}::uuid, 'Grade 7', 7) RETURNING id::text AS id
      `;
      const [section] = await tx<{ id: string }[]>`
        INSERT INTO app.sections (school_id, academic_year_id, grade_level_id, name)
        VALUES (${f.schoolId}::uuid, ${year.id}::uuid, ${grade!.id}::uuid, '7A')
        RETURNING id::text AS id
      `;
      for (const student of [f.students[0]!, f.students[2]!]) {
        await tx`
          INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
          VALUES (${f.schoolId}::uuid, ${student.id}::uuid, ${year.id}::uuid, ${section!.id}::uuid)
        `;
      }
      return section!.id;
    });

    const { result } = await assign(f, licenseId, {
      audience: "student",
      scope: { kind: "section", sectionId },
    });

    expect(result.assigned.map((a) => a.userId).sort()).toEqual(
      [f.students[0]!.userId, f.students[2]!.userId].sort(),
    );
    // A second run reports them as already seated rather than seating anyone else.
    const again = await assign(f, licenseId, {
      audience: "student",
      scope: { kind: "section", sectionId },
    });
    expect(again.result.assigned).toHaveLength(0);
    expect(again.result.notAssigned.map((n) => n.reason)).toEqual([
      "already_assigned",
      "already_assigned",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Eligibility and isolation
// ---------------------------------------------------------------------------------------------------

describe("eligibility", () => {
  integrationTest("only members of the school in the seat's audience can hold one", async () => {
    const f = await school(2);
    const teacher = await createTeacher(db.sql, f.schoolId);
    const parent = await parentOf(f.schoolId, f.students[0]!.id);
    const licenseId = await license(f.schoolId, { student: 5, teacher: 5, parent: 5 });

    // A withdrawn student, a terminated teacher.
    await asAdmin(f.schoolId, async (tx) => {
      await tx`UPDATE app.students SET status = 'withdrawn' WHERE id = ${f.students[1]!.id}::uuid`;
    });
    const gone = await createTeacher(db.sql, f.schoolId);
    await asAdmin(
      f.schoolId,
      (tx) => tx`
      UPDATE app.teachers SET employment_status = 'terminated'
      WHERE id = ${gone.id}::uuid
    `,
    );
    const outsider = await school(1, "Another School");

    const students = await assign(f, licenseId, {
      audience: "student",
      userIds: [f.students[0]!.userId, f.students[1]!.userId, outsider.students[0]!.userId],
    });
    expect(students.result.assigned.map((a) => a.userId)).toEqual([f.students[0]!.userId]);
    expect(students.result.notAssigned.map((n) => n.reason).sort()).toEqual([
      "not_eligible",
      "not_eligible",
    ]);

    const teachers = await assign(f, licenseId, {
      audience: "teacher",
      userIds: [teacher.userId, gone.userId],
    });
    expect(teachers.result.assigned.map((a) => a.userId)).toEqual([teacher.userId]);

    // A parent seat goes to a linked parent; a student is not a parent.
    const parents = await assign(f, licenseId, {
      audience: "parent",
      userIds: [parent, f.students[0]!.userId],
    });
    expect(parents.result.assigned.map((a) => a.userId)).toEqual([parent]);
    expect(parents.result.notAssigned).toEqual([
      expect.objectContaining({ userId: f.students[0]!.userId, reason: "not_eligible" }),
    ]);
  });

  integrationTest("the trigger refuses an ineligible seat written directly", async () => {
    const f = await school(1);
    const licenseId = await license(f.schoolId, { student: 1, teacher: 1 });

    await expect(
      asApp(
        f.schoolId,
        (tx) => tx`
        INSERT INTO app.license_seats (school_id, license_id, audience, user_id, assigned_by)
        VALUES (${f.schoolId}::uuid, ${licenseId}::uuid, 'teacher', ${f.students[0]!.userId}::uuid,
                ${f.adminUserId}::uuid)
      `,
      ),
    ).rejects.toThrow(/ck_license_seats_eligible|cannot hold/);
  });

  integrationTest("parent seats need a license that includes Family+", async () => {
    const f = await school(1);
    const parent = await parentOf(f.schoolId, f.students[0]!.id);
    const licenseId = await license(f.schoolId, { student: 1 });

    await expect(
      assign(f, licenseId, { audience: "parent", userIds: [parent] }),
    ).rejects.toMatchObject({ code: "LICENSE_AUDIENCE_NOT_LICENSED" });
  });

  integrationTest("licenses and seats are isolated per school", async () => {
    const a = await school(1);
    const b = await school(1);
    const licenseId = await license(a.schoolId, { student: 1 });
    await assign(a, licenseId, { audience: "student", userIds: [a.students[0]!.userId] });

    await asApp(b.schoolId, async (tx) => {
      expect(await tx`SELECT id FROM app.school_licenses`).toHaveLength(0);
      expect(await tx`SELECT id FROM app.license_seats`).toHaveLength(0);
    });
    await asApp(a.schoolId, async (tx) => {
      expect(await tx`SELECT id FROM app.school_licenses`).toHaveLength(1);
      expect(await tx`SELECT id FROM app.license_seats`).toHaveLength(1);
    });
    // School B cannot seat its student on school A's license.
    await expect(
      asApp(
        b.schoolId,
        (tx) => tx`
        INSERT INTO app.license_seats (school_id, license_id, audience, user_id, student_id, assigned_by)
        VALUES (${b.schoolId}::uuid, ${licenseId}::uuid, 'student', ${b.students[0]!.userId}::uuid,
                ${b.students[0]!.id}::uuid, ${b.adminUserId}::uuid)
      `,
      ),
    ).rejects.toThrow();
    // And no DELETE: seats end by unassignment.
    await expect(asApp(a.schoolId, (tx) => tx`DELETE FROM app.license_seats`)).rejects.toThrow(
      /permission denied/,
    );
  });

  integrationTest("one active license per school", async () => {
    const f = await school(0);
    await license(f.schoolId, { student: 1 });
    const second = await license(f.schoolId, { student: 1 }, { activate: false });

    await expect(setStatus(f.schoolId, second, "active")).rejects.toMatchObject({
      code: "LICENSE_ALREADY_ACTIVE",
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Resolver matrix from real rows
// ---------------------------------------------------------------------------------------------------

describe("resolution from licenses and seats", () => {
  integrationTest("a seat on an active license covers; no seat does not", async () => {
    const f = await school(2);
    const licenseId = await license(f.schoolId, { student: 1 });
    await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });

    const seated = await features(f.schoolId, f.students[0]!.userId);
    const unseated = await features(f.schoolId, f.students[1]!.userId);

    expect(seated.ai_tutor).toMatchObject({ active: true, source: "school_license", limit: 300 });
    expect(seated.study_tools).toMatchObject({ active: true, limit: 50 });
    expect(unseated.ai_tutor).toMatchObject({ active: false, reason: "not_included" });
  });

  for (const status of ["suspended", "cancelled", "expired"] as const) {
    integrationTest(`a ${status} license stops covering`, async () => {
      const f = await school(1);
      const licenseId = await license(f.schoolId, { student: 1 });
      await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });

      if (status === "expired") {
        // The expiry job is session 3; the status is set as it will set it.
        await asAdmin(
          f.schoolId,
          (tx) => tx`
          UPDATE app.school_licenses SET status = 'expired' WHERE id = ${licenseId}::uuid
        `,
        );
      } else {
        await setStatus(f.schoolId, licenseId, status);
      }

      expect((await features(f.schoolId, f.students[0]!.userId)).ai_tutor).toMatchObject({
        active: false,
        reason: "expired",
      });
    });
  }

  integrationTest("personal only, and personal plus a seat (best of both)", async () => {
    const f = await school(2);
    // A personal Student Plus... no: a personal ai_addon (unlimited) and a seat (limit 300).
    await asApp(
      f.schoolId,
      (tx) => tx`
      INSERT INTO app.user_subscriptions (
        school_id, user_id, plan_id, provider, status, current_period_start, current_period_end,
        provider_reference
      )
      SELECT ${f.schoolId}::uuid, u.id, p.id, 'tap', 'active', now() - interval '5 days',
             now() + interval '25 days', 'agr_' || left(u.id::text, 8)
      FROM app.users AS u, app.plans AS p
      WHERE u.id IN (${f.students[0]!.userId}::uuid, ${f.students[1]!.userId}::uuid)
        AND p.code = 'ai_addon'
    `,
    );
    const licenseId = await license(f.schoolId, { student: 1 });
    await assign(f, licenseId, { audience: "student", userIds: [f.students[1]!.userId] });

    const personalOnly = await features(f.schoolId, f.students[0]!.userId);
    const both = await features(f.schoolId, f.students[1]!.userId);

    expect(personalOnly.ai_tutor).toMatchObject({ active: true, source: "purchase", limit: null });
    expect(both.ai_tutor).toMatchObject({ active: true, limit: null, source: "school_license" });
    expect(both.ai_tutor.sources.map((s) => s.source).sort()).toEqual([
      "purchase",
      "school_license",
    ]);
    // notebook only through the personal ai_addon tier.
    expect(both.notebook).toMatchObject({ active: true, source: "purchase" });
  });

  integrationTest("a Family+ parent is covered at the licensed school only", async () => {
    const a = await school(1, "Alpha");
    const b = await school(1, "Beta");
    const email = `parent-${crypto.randomUUID().slice(0, 6)}@two-schools.test`;
    const parentA = await parentOf(a.schoolId, a.students[0]!.id, email);
    const parentB = await parentOf(b.schoolId, b.students[0]!.id, email);
    const licenseId = await license(a.schoolId, { student: 1, parent: 1 });
    await assign(a, licenseId, { audience: "parent", userIds: [parentA] });

    expect((await features(a.schoolId, parentA)).family_plus).toMatchObject({
      active: true,
      source: "school_license",
    });
    // The same person at the other school: no seat there, so no Family+ for that child.
    expect((await features(b.schoolId, parentB)).family_plus).toMatchObject({
      active: false,
      reason: "not_included",
    });
  });

  integrationTest("an inactive school covers no one", async () => {
    const f = await school(1);
    const licenseId = await license(f.schoolId, { student: 1 });
    await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });
    await asAdmin(
      f.schoolId,
      (tx) => tx`
      INSERT INTO app.subscriptions (school_id, plan_id, status, current_period_start, current_period_end)
      SELECT ${f.schoolId}::uuid, id, 'canceled', now() - interval '30 days', now() + interval '1 day'
      FROM app.plans WHERE code = 'free'
    `,
    );

    expect((await features(f.schoolId, f.students[0]!.userId)).ai_tutor).toMatchObject({
      active: false,
      reason: "school_inactive",
    });
  });

  integrationTest(
    "a tier with includes_all_features picks up a feature it has no row for",
    async () => {
      const f = await school(0);
      const teacher = await createTeacher(db.sql, f.schoolId);
      const licenseId = await license(f.schoolId, { teacher: 1 });
      await assign(f, licenseId, { audience: "teacher", userIds: [teacher.userId] });

      expect((await features(f.schoolId, teacher.userId)).auto_grading).toMatchObject({
        active: true,
        source: "school_license",
        limit: 500,
      });
    },
  );
});

// ---------------------------------------------------------------------------------------------------
// Overlap with personal subscriptions
// ---------------------------------------------------------------------------------------------------

async function aiAddon(
  schoolId: string,
  studentId: string,
  extra: { stripe?: string; tap?: boolean; status?: string } = {},
): Promise<string> {
  const [row] = await asAdmin(
    schoolId,
    (tx) => tx<{ id: string }[]>`
    INSERT INTO app.ai_subscriptions (
      school_id, student_id, status, current_period_start, current_period_end,
      stripe_subscription_id, tap_card_id, tap_payment_agreement_id
    ) VALUES (
      ${schoolId}::uuid, ${studentId}::uuid, ${extra.status ?? "active"}::app.subscription_status,
      now() - interval '10 days', now() + interval '20 days',
      ${extra.stripe ?? null}, ${extra.tap ? "card_x" : null}, ${extra.tap ? `agr_${studentId.slice(0, 8)}` : null}
    )
    RETURNING id::text AS id
  `,
  );
  return row!.id;
}

async function overlapFor(schoolId: string, seatUserId: string) {
  return asAdmin(schoolId, async (tx) => {
    const [row] = await tx<
      {
        provider: string | null;
        overlap_days: number;
        monthly_seat_price_minor: string | null;
        credit_minor: string | null;
        renewal_action: string;
        renewal_status: string;
        renewal_error: string | null;
      }[]
    >`
      SELECT provider, overlap_days, monthly_seat_price_minor::text, credit_minor::text,
             renewal_action, renewal_status, renewal_error
      FROM app.license_seat_overlaps WHERE user_id = ${seatUserId}::uuid
    `;
    return row;
  });
}

describe("overlap with personal subscriptions", () => {
  integrationTest(
    "Stripe: credit recorded, cancelled at period end through the provider",
    async () => {
      const f = await school(1);
      const subId = await aiAddon(f.schoolId, f.students[0]!.id, {
        stripe: `sub_${crypto.randomUUID().slice(0, 8)}`,
      });
      const licenseId = await license(f.schoolId, { student: 1 });

      const { renewals } = await assign(f, licenseId, {
        audience: "student",
        userIds: [f.students[0]!.userId],
      });

      const overlap = await overlapFor(f.schoolId, f.students[0]!.userId);
      // 20 days left (rounded up from just under 20) at 3000 x 12 / 365 a day.
      expect(overlap).toMatchObject({
        provider: "stripe",
        overlap_days: 20,
        monthly_seat_price_minor: "3000",
        credit_minor: String(Math.round(20 * ((3000 * 12) / 365))),
        renewal_action: "cancel_at_period_end",
        renewal_status: "done",
      });
      expect(renewals).toEqual([expect.objectContaining({ status: "done" })]);
      expect(stripeCalls).toContain(
        (
          await asAdmin(
            f.schoolId,
            (tx) => tx<{ s: string }[]>`
        SELECT stripe_subscription_id AS s FROM app.ai_subscriptions WHERE id = ${subId}::uuid
      `,
          )
        )[0]!.s,
      );
      const [flag] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ c: boolean }[]>`
      SELECT cancel_at_period_end AS c FROM app.ai_subscriptions WHERE id = ${subId}::uuid
    `,
      );
      expect(flag!.c).toBe(true);
    },
  );

  integrationTest("Tap: renewal turned off locally, no provider call", async () => {
    const f = await school(1);
    const subId = await aiAddon(f.schoolId, f.students[0]!.id, { tap: true });
    const licenseId = await license(f.schoolId, { student: 1 });
    const before = stripeCalls.length + googleCalls.length;

    await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });

    expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toMatchObject({
      provider: "tap",
      renewal_action: "cancel_at_period_end",
      renewal_status: "done",
    });
    expect(stripeCalls.length + googleCalls.length).toBe(before);
    const [flag] = await asAdmin(
      f.schoolId,
      (tx) => tx<{ c: boolean }[]>`
      SELECT cancel_at_period_end AS c FROM app.ai_subscriptions WHERE id = ${subId}::uuid
    `,
    );
    expect(flag!.c).toBe(true);
  });

  integrationTest(
    "Google Play: cancelled through the Play API with the purchase token",
    async () => {
      const f = await school(1);
      await aiAddon(f.schoolId, f.students[0]!.id);
      const token = `gp-token-${crypto.randomUUID().slice(0, 8)}`;
      await asAdmin(
        null,
        (tx) => tx`
      INSERT INTO app.billing_events (
        provider, provider_event_id, event_type, effective_at, payload, status, attempt_count, processed_at
      ) VALUES (
        'google', ${`google:purchase:${token}`}, 'purchased', now() - interval '10 days',
        ${tx.json({ store_ref: token, metadata: { school_id: f.schoolId, student_id: f.students[0]!.id } })},
        'processed', 1, now()
      )
    `,
      );
      const licenseId = await license(f.schoolId, { student: 1 });

      await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });

      expect(googleCalls).toContain(token);
      expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toMatchObject({
        provider: "google_play",
        renewal_status: "done",
      });
    },
  );

  integrationTest(
    "App Store: the user is notified with instructions; nothing else changes",
    async () => {
      const f = await school(1);
      await asApp(
        f.schoolId,
        (tx) => tx`
      INSERT INTO app.user_subscriptions (
        school_id, user_id, plan_id, provider, status, current_period_start, current_period_end,
        provider_reference
      )
      SELECT ${f.schoolId}::uuid, ${f.students[0]!.userId}::uuid, id, 'app_store', 'active',
             now() - interval '3 days', now() + interval '27 days', 'orig-apple-1'
      FROM app.plans WHERE code = 'ai_addon'
    `,
      );
      const licenseId = await license(f.schoolId, { student: 1 });

      await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });

      expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toMatchObject({
        provider: "app_store",
        renewal_action: "notify_user",
        renewal_status: "done",
      });
      const notices = await asAdmin(
        f.schoolId,
        (tx) => tx<{ type: string; body: string }[]>`
      SELECT notification_type::text AS type, body FROM app.notifications
      WHERE user_id = ${f.students[0]!.userId}::uuid
    `,
      );
      expect([...notices]).toEqual([
        expect.objectContaining({
          type: "LICENSE_SEAT_APPLE_RENEWAL",
          body: expect.stringContaining("Subscriptions"),
        }),
      ]);
      const [sub] = await asAdmin(
        f.schoolId,
        (tx) => tx<{ auto_renew: boolean }[]>`
      SELECT auto_renew FROM app.user_subscriptions WHERE user_id = ${f.students[0]!.userId}::uuid
    `,
      );
      expect(sub!.auto_renew).toBe(true);
    },
  );

  integrationTest("a provider failure is recorded, not rolled back into the seat", async () => {
    const f = await school(1);
    const subId = await aiAddon(f.schoolId, f.students[0]!.id, { stripe: "sub_failing" });
    const licenseId = await license(f.schoolId, { student: 1 });
    stripeFails = true;
    try {
      const { result, renewals } = await assign(f, licenseId, {
        audience: "student",
        userIds: [f.students[0]!.userId],
      });
      expect(result.assigned).toHaveLength(1);
      expect(renewals).toEqual([
        expect.objectContaining({ status: "failed", error: "stripe is down" }),
      ]);
    } finally {
      stripeFails = false;
    }
    expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toMatchObject({
      renewal_status: "failed",
      renewal_error: "stripe is down",
    });
    const [flag] = await asAdmin(
      f.schoolId,
      (tx) => tx<{ c: boolean }[]>`
      SELECT cancel_at_period_end AS c FROM app.ai_subscriptions WHERE id = ${subId}::uuid
    `,
    );
    expect(flag!.c).toBe(false);
  });

  integrationTest("seats on a license awaiting payment wait for activation", async () => {
    const f = await school(1);
    const subId = await aiAddon(f.schoolId, f.students[0]!.id, { tap: true });
    const licenseId = await license(f.schoolId, { student: 1 }, { activate: false });
    await setStatus(f.schoolId, licenseId, "awaiting_payment");

    await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });
    expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toBeUndefined();

    await setStatus(f.schoolId, licenseId, "active");
    expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toMatchObject({ provider: "tap" });
    const [flag] = await asAdmin(
      f.schoolId,
      (tx) => tx<{ c: boolean }[]>`
      SELECT cancel_at_period_end AS c FROM app.ai_subscriptions WHERE id = ${subId}::uuid
    `,
    );
    expect(flag!.c).toBe(true);
  });

  integrationTest("unassigning a seat never touches the personal subscription", async () => {
    const f = await school(1);
    const subId = await aiAddon(f.schoolId, f.students[0]!.id, { tap: true });
    const licenseId = await license(f.schoolId, { student: 1 });
    const { result } = await assign(f, licenseId, {
      audience: "student",
      userIds: [f.students[0]!.userId],
    });
    const before = await asAdmin(
      f.schoolId,
      (tx) => tx`
      SELECT status, cancel_at_period_end, current_period_end, updated_at
      FROM app.ai_subscriptions WHERE id = ${subId}::uuid
    `,
    );

    await runLicenseChange(deps(), f.schoolId, f.admin, (tx) =>
      unassignSeat(tx, f.schoolId, licenseId, result.assigned[0]!.seatId, f.admin),
    );

    const after = await asAdmin(
      f.schoolId,
      (tx) => tx`
      SELECT status, cancel_at_period_end, current_period_end, updated_at
      FROM app.ai_subscriptions WHERE id = ${subId}::uuid
    `,
    );
    expect([...after]).toEqual([...before]);
    // The overlap stays on record for the invoice.
    expect(await overlapFor(f.schoolId, f.students[0]!.userId)).toBeDefined();
  });

  integrationTest("seat assignments and overlaps are audited", async () => {
    const f = await school(1);
    await aiAddon(f.schoolId, f.students[0]!.id, { tap: true });
    const licenseId = await license(f.schoolId, { student: 1 });
    await assign(f, licenseId, { audience: "student", userIds: [f.students[0]!.userId] });

    const rows = await asAdmin(
      f.schoolId,
      (tx) => tx<
        {
          target_table: string;
          action: string;
          has_old: boolean;
          has_new: boolean;
          actor: string | null;
        }[]
      >`
      SELECT target_table, action::text AS action, old_values IS NOT NULL AS has_old,
             new_values IS NOT NULL AS has_new, actor_id::text AS actor
      FROM app.audit_logs
      WHERE target_table IN ('license_seats', 'license_seat_overlaps', 'ai_subscriptions')
      ORDER BY target_table
    `,
    );
    // An insert has no old values; an update has both.
    expect([...rows]).toEqual([
      {
        target_table: "ai_subscriptions",
        action: "update",
        has_old: true,
        has_new: true,
        actor: f.adminUserId,
      },
      {
        target_table: "license_seat_overlaps",
        action: "insert",
        has_old: false,
        has_new: true,
        actor: f.adminUserId,
      },
      {
        target_table: "license_seats",
        action: "insert",
        has_old: false,
        has_new: true,
        actor: f.adminUserId,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------------------------------

describe("entitlement propagation", () => {
  integrationTest("assign and unassign bump the holder's version and emit the event", async () => {
    const f = await school(1);
    const userId = f.students[0]!.userId;
    const licenseId = await license(f.schoolId, { student: 1 });

    const { result } = await assign(f, licenseId, { audience: "student", userIds: [userId] });
    await runLicenseChange(deps(), f.schoolId, f.admin, (tx) =>
      unassignSeat(tx, f.schoolId, licenseId, result.assigned[0]!.seatId, f.admin),
    );

    const [version] = await asAdmin(
      f.schoolId,
      (tx) => tx<{ v: string }[]>`
      SELECT version::text AS v FROM app.entitlement_versions
      WHERE subject_type = 'user' AND subject_id = ${userId}::uuid
    `,
    );
    const events = await asAdmin(
      f.schoolId,
      (tx) => tx<{ v: number }[]>`
      SELECT (payload ->> 'entitlementsVersion')::int AS v FROM app.outbox_events
      WHERE event_name = 'userEntitlement.changed' AND payload ->> 'userId' = ${userId}
      ORDER BY id
    `,
    );
    expect(version!.v).toBe("3");
    expect(events.map((e) => e.v)).toEqual([2, 3]);
    expect((await features(f.schoolId, userId)).ai_tutor.active).toBe(false);
  });

  redisTest("the holder's cached entitlement is invalidated at once", async () => {
    const f = await school(1);
    const userId = f.students[0]!.userId;
    const licenseId = await license(f.schoolId, { student: 1 });
    const key = `ent:usr:${userId}`;
    await redis!.set(key, `1|{"seats":[],"subscriptions":[]}`, "EX", 300);

    const { result } = await assign(f, licenseId, { audience: "student", userIds: [userId] });
    expect(await redis!.get(key)).toBe("2|");

    await runLicenseChange(deps(), f.schoolId, f.admin, (tx) =>
      unassignSeat(tx, f.schoolId, licenseId, result.assigned[0]!.seatId, f.admin),
    );
    expect(await redis!.get(key)).toBe("3|");
  });

  integrationTest("a license-wide change moves every seat holder", async () => {
    const f = await school(2);
    const licenseId = await license(f.schoolId, { student: 2 });
    await assign(f, licenseId, { audience: "student", userIds: f.students.map((s) => s.userId) });

    await setStatus(f.schoolId, licenseId, "suspended");

    const versions = await asAdmin(
      f.schoolId,
      (tx) => tx<{ v: string }[]>`
      SELECT version::text AS v FROM app.entitlement_versions
      WHERE subject_type = 'user'
        AND subject_id IN (${f.students[0]!.userId}::uuid, ${f.students[1]!.userId}::uuid)
    `,
    );
    expect(versions.map((r) => r.v)).toEqual(["3", "3"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Routes and permissions
// ---------------------------------------------------------------------------------------------------

describe("route permissions", () => {
  let api: TestApp;

  beforeAll(async () => {
    if (!integrationEnabled) return;
    const created = createTestApp({ database: db.sql });
    await created.ready;
    api = created;
  });

  async function as(
    f: SchoolFixture,
    role: (typeof ROLES)[keyof typeof ROLES],
    method: string,
    path: string,
    body?: unknown,
    channel: (typeof AUTH_CHANNELS)[keyof typeof AUTH_CHANNELS] = AUTH_CHANNELS.WEB,
  ) {
    const user = await createUser(db.sql, f.schoolId);
    await assignRole(db.sql, f.schoolId, user.id, role);
    return authenticatedRequest(
      api,
      method,
      path,
      { schoolId: f.schoolId, userId: user.id, roles: [role], channel },
      body === undefined
        ? undefined
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          },
    );
  }

  integrationTest("license:read and license:manage: ORG_ADMIN and PRINCIPAL only", async () => {
    expect(PERMISSIONS.LICENSE_READ).toBe("license:read");
    const f = await school(1);
    await license(f.schoolId, { student: 1 });

    for (const role of [ROLES.ORG_ADMIN, ROLES.PRINCIPAL]) {
      expect((await as(f, role, "GET", "/api/school/license")).status).toBe(200);
    }
    for (const role of [ROLES.INSTRUCTOR, ROLES.STUDENT, ROLES.PARENT, ROLES.FINANCE]) {
      expect((await as(f, role, "GET", "/api/school/license")).status).toBe(403);
      expect(
        (
          await as(f, role, "POST", "/api/school/license/seats", {
            audience: "student",
            userIds: [f.students[0]!.userId],
          })
        ).status,
      ).toBe(403);
    }

    const assigned = await as(f, ROLES.PRINCIPAL, "POST", "/api/school/license/seats", {
      audience: "student",
      userIds: [f.students[0]!.userId],
    });
    expect(assigned.status).toBe(200);
    const body = (await assigned.json()) as { assigned: { seatId: string }[] };
    expect(body.assigned).toHaveLength(1);

    const overview = (await (
      await as(f, ROLES.ORG_ADMIN, "GET", "/api/school/license")
    ).json()) as {
      license: { audiences: { audience: string; purchased: number; assigned: number }[] };
      usage: { feature: string }[];
    };
    expect(overview.license.audiences.find((a) => a.audience === "student")).toMatchObject({
      purchased: 1,
      assigned: 1,
    });
    expect(overview.usage.map((u) => u.feature)).toContain("ai_tutor");

    const eligible = await as(
      f,
      ROLES.ORG_ADMIN,
      "GET",
      "/api/school/license/eligible?audience=student",
    );
    expect(((await eligible.json()) as { total: number }).total).toBe(0);

    const request = await as(f, ROLES.ORG_ADMIN, "POST", "/api/school/license/change-requests", {
      studentSeats: 50,
      note: "Two more classes joined",
    });
    expect(request.status).toBe(201);

    const freed = await as(
      f,
      ROLES.ORG_ADMIN,
      "DELETE",
      `/api/school/license/seats/${body.assigned[0]!.seatId}`,
    );
    expect(freed.status).toBe(200);
  });

  integrationTest("the license console is SUPER_ADMIN only, on the web", async () => {
    const f = await school(0);
    const path = `/api/platform/schools/${f.schoolId}/licenses`;
    const create = {
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      currencyCode: "USD",
      student: { planId: tiers.student, seats: 10 },
    };

    expect((await as(f, ROLES.ORG_ADMIN, "GET", path)).status).toBe(403);
    expect((await as(f, ROLES.ORG_ADMIN, "POST", path, create)).status).toBe(403);

    const operatorRequest = (
      method: string,
      p: string,
      body?: unknown,
      channel: (typeof AUTH_CHANNELS)[keyof typeof AUTH_CHANNELS] = AUTH_CHANNELS.WEB,
    ) =>
      authenticatedRequest(
        api,
        method,
        p,
        {
          schoolId: hq,
          userId: operator.userId,
          roles: [ROLES.SUPER_ADMIN],
          channel,
        },
        body === undefined
          ? undefined
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            },
      );

    expect((await operatorRequest("GET", path, undefined, AUTH_CHANNELS.API)).status).toBe(403);
    const created = await operatorRequest("POST", path, create);
    expect(created.status).toBe(201);
    const license = (await created.json()) as {
      id: string;
      status: string;
      allowedTransitions: string[];
    };
    expect(license.status).toBe("draft");
    expect(license.allowedTransitions).toContain("active");

    const activated = await operatorRequest("POST", `${path}/${license.id}/status`, {
      status: "active",
    });
    expect(activated.status).toBe(200);
    const listed = (await (await operatorRequest("GET", path)).json()) as {
      licenses: { status: string }[];
    };
    expect(listed.licenses.map((l) => l.status)).toEqual(["active"]);

    // A school admin's GET on the platform path stays refused even with a license in place.
    expect((await as(f, ROLES.ORG_ADMIN, "GET", `${path}/${license.id}`)).status).toBe(403);
  });
});
