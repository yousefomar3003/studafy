/**
 * Parent child-timetable HTTP tests.
 *
 * Exercises GET /api/reports/children/{studentId}/timetable against a seeded tenant: the approved
 * version of the current term narrowed to the child's active enrollments, the school's teaching
 * week, the "no approved version yet" shape, and the same PARENT-role + parent_child_links gate as
 * the breakdown route.
 *
 * Requires a live PostgreSQL instance and is gated on TEST_DATABASE_URL like every other
 * integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/reports/child-timetable.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authenticatedRequest,
  createClass,
  createCourse,
  createEnrollment,
  createFullTenant,
  createRoom,
  createStudent,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StudentRecord, TenantFixture, TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

interface TimetableResponse {
  student_id: string;
  term_id: string | null;
  timetable_version_id: string | null;
  settings: { school_days: number[]; periods_per_day: number };
  slots: {
    id: string;
    weekday: number;
    period: number;
    class: { id: string; code: string };
    course: { id: string; code: string; name: string } | null;
    teacher: { id: string; name: string } | null;
    room: { id: string; name: string } | null;
  }[];
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let fixture: TenantFixture | undefined;
let noVersionFixture: TenantFixture | undefined;
let unlinkedStudent: StudentRecord | undefined;
let versionId: string | undefined;
let otherClassId: string | undefined;

async function asAdmin<T>(schoolId: string, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await run(tx);
  });
  return result as T;
}

async function linkChild(tenant: TenantFixture, studentId: string): Promise<void> {
  await asAdmin(tenant.schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Timetable test family', ${tenant.users.PARENT.id}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (
        ${tenant.schoolId}::uuid, ${family!.id}::uuid, ${tenant.users.PARENT.id}::uuid,
        ${studentId}::uuid, 'mother'
      )
    `;
  });
}

/**
 * One approved version for the fixture term with slots for the child's class (out of order, to
 * prove sorting) plus a slot for a class the child is not enrolled in, and a draft version whose
 * slots must never leak into the response.
 */
async function seedTimetable(): Promise<void> {
  const tenant = fixture!;
  const otherCourse = await createCourse(database!.sql, tenant.schoolId, tenant.subject.id);
  const otherRoom = await createRoom(database!.sql, tenant.schoolId);
  const otherClass = await createClass(database!.sql, tenant.schoolId, {
    courseId: otherCourse.id,
    academicYearId: tenant.academicYear.id,
    termId: tenant.term.id,
    leadTeacherId: tenant.teachers[0]!.id,
    roomId: otherRoom.id,
  });
  otherClassId = otherClass.id;

  await asAdmin(tenant.schoolId, async (tx) => {
    // Versions must be born draft (enforce_timetable_version_transition); this one is walked
    // through pending to approved once its slots are in.
    const [approved] = await tx<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
      VALUES (
        ${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${tenant.term.id}::uuid,
        'Approved schedule', 'draft'
      )
      RETURNING id
    `;
    versionId = approved!.id;
    const [draft] = await tx<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
      VALUES (
        ${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${tenant.term.id}::uuid,
        'Draft schedule', 'draft'
      )
      RETURNING id
    `;

    const slots: {
      version: string;
      classId: string;
      roomId: string;
      weekday: number;
      period: number;
    }[] = [
      { version: versionId, classId: tenant.cls.id, roomId: tenant.room.id, weekday: 3, period: 2 },
      { version: versionId, classId: tenant.cls.id, roomId: tenant.room.id, weekday: 1, period: 4 },
      { version: versionId, classId: tenant.cls.id, roomId: tenant.room.id, weekday: 1, period: 1 },
      { version: versionId, classId: otherClass.id, roomId: otherRoom.id, weekday: 2, period: 1 },
      { version: draft!.id, classId: tenant.cls.id, roomId: tenant.room.id, weekday: 5, period: 5 },
    ];
    for (const slot of slots) {
      await tx`
        INSERT INTO app.timetable_slots
          (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
        VALUES (
          ${tenant.schoolId}::uuid, ${slot.version}::uuid, ${slot.classId}::uuid,
          ${tenant.teachers[0]!.id}::uuid, ${slot.roomId}::uuid, ${slot.weekday}, ${slot.period}
        )
      `;
    }

    await tx`
      UPDATE app.timetable_versions
      SET status = 'pending', submitted_by_user_id = ${tenant.users.ORG_ADMIN.id}::uuid
      WHERE id = ${versionId}::uuid
    `;
    await tx`
      UPDATE app.timetable_versions
      SET status = 'approved', approved_by_user_id = ${tenant.users.ORG_ADMIN.id}::uuid
      WHERE id = ${versionId}::uuid
    `;

    await tx`
      INSERT INTO app.school_settings (school_id, school_days, periods_per_day)
      VALUES (${tenant.schoolId}::uuid, '{1,2,3,4,5}'::smallint[], 6)
      ON CONFLICT (school_id)
      DO UPDATE SET school_days = EXCLUDED.school_days, periods_per_day = EXCLUDED.periods_per_day
    `;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  fixture = await createFullTenant(database.sql);
  noVersionFixture = await createFullTenant(database.sql);

  unlinkedStudent = await createStudent(database.sql, fixture.schoolId, {
    firstName: "Unrelated",
    lastName: "TestStudent",
  });
  await createEnrollment(database.sql, fixture.schoolId, fixture.cls.id, unlinkedStudent.id);

  await linkChild(fixture, fixture.students[0]!.id);
  await linkChild(noVersionFixture, noVersionFixture.students[0]!.id);
  await seedTimetable();

  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function asParent(tenant: TenantFixture) {
  return { schoolId: tenant.schoolId, userId: tenant.users.PARENT.id, roles: [ROLES.PARENT] };
}

describeDb("parent child timetable HTTP API", () => {
  test("returns the current term's approved slots for the child's classes, sorted", async () => {
    const tenant = fixture!;
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/${tenant.students[0]!.id}/timetable`,
      asParent(tenant),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as TimetableResponse;

    expect(body.student_id).toBe(tenant.students[0]!.id);
    expect(body.term_id).toBe(tenant.term.id);
    expect(body.timetable_version_id).toBe(versionId!);
    expect(body.settings).toEqual({ school_days: [1, 2, 3, 4, 5], periods_per_day: 6 });

    expect(body.slots.map((slot) => [slot.weekday, slot.period])).toEqual([
      [1, 1],
      [1, 4],
      [3, 2],
    ]);
    expect(body.slots.some((slot) => slot.class.id === otherClassId)).toBe(false);
    expect(body.slots[0]).toMatchObject({
      class: { id: tenant.cls.id, code: tenant.cls.code },
      course: {
        id: tenant.course.id,
        code: tenant.course.code,
        name: `Course ${tenant.course.code}`,
      },
      teacher: {
        id: tenant.teachers[0]!.id,
        name: `teacher@primary.test-${tenant.schoolSlug}.local`,
      },
      room: { id: tenant.room.id, name: `Room ${tenant.room.code}` },
    });
  });

  test("drops slots for classes the child is no longer actively enrolled in", async () => {
    const tenant = fixture!;
    await asAdmin(tenant.schoolId, async (tx) => {
      await tx`
        UPDATE app.enrollments SET status = 'withdrawn', withdrawn_at = now()
        WHERE school_id = ${tenant.schoolId}::uuid
          AND class_id = ${tenant.cls.id}::uuid
          AND student_id = ${tenant.students[0]!.id}::uuid
      `;
    });
    try {
      const response = await authenticatedRequest(
        harness!,
        "GET",
        `/api/reports/children/${tenant.students[0]!.id}/timetable`,
        asParent(tenant),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as TimetableResponse;
      expect(body.timetable_version_id).toBe(versionId!);
      expect(body.slots).toEqual([]);
    } finally {
      await asAdmin(tenant.schoolId, async (tx) => {
        await tx`
          UPDATE app.enrollments SET status = 'active', withdrawn_at = NULL
          WHERE school_id = ${tenant.schoolId}::uuid
            AND class_id = ${tenant.cls.id}::uuid
            AND student_id = ${tenant.students[0]!.id}::uuid
        `;
      });
    }
  });

  test("returns null ids and no slots when the current term has no approved version", async () => {
    const tenant = noVersionFixture!;
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/${tenant.students[0]!.id}/timetable`,
      asParent(tenant),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as TimetableResponse;
    expect(body).toEqual({
      student_id: tenant.students[0]!.id,
      term_id: tenant.term.id,
      timetable_version_id: null,
      // No school_settings row: the migration's column defaults.
      settings: { school_days: [7, 1, 2, 3, 4], periods_per_day: 8 },
      slots: [],
    });
  });

  test("denies a staff role that holds GRADE_READ but is not a parent", async () => {
    const tenant = fixture!;
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/${tenant.students[0]!.id}/timetable`,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id, roles: [ROLES.ORG_ADMIN] },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.ACCESS_DENIED);
  });

  test("denies a timetable for a child not linked to the calling parent", async () => {
    const tenant = fixture!;
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/${unlinkedStudent!.id}/timetable`,
      asParent(tenant),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.ACCESS_DENIED);
  });

  test("rejects a malformed studentId", async () => {
    const tenant = fixture!;
    const response = await authenticatedRequest(
      harness!,
      "GET",
      "/api/reports/children/not-a-uuid/timetable",
      asParent(tenant),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});
