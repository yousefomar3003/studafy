/**
 * Attendance officer HTTP tests (ATTENDANCE_OFFICER, migrations 000132-000133).
 *
 * Full HTTP path -- JWT auth, permission gates and a real tenant transaction with RLS armed -- for
 * the attendance office: an officer takes, reads, submits and corrects a register for a class they
 * do not teach, while the school-wide visibility they are given stops at rosters and attendance.
 * Also pins two fixes that landed with the role: batch recording validates against active
 * enrolments (it used to query a column app.students does not have), and opening or changing a
 * session needs attendance:record:create.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/attendance/attendance-officer-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createMaterial,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
}

interface World {
  schoolId: string;
  classId: string;
  studentId: string;
  officer: Actor;
  teacher: Actor;
  student: Actor;
}

async function buildWorld(): Promise<World> {
  const sql = database!.sql;
  const fixture = await createFullTenant(sql);
  const schoolId = fixture.schoolId;

  const officerUser = await createUser(sql, schoolId, {
    email: `attendance-${crypto.randomUUID().slice(0, 8)}@test.local`,
  });
  await assignRole(sql, schoolId, officerUser.id, ROLES.ATTENDANCE_OFFICER);

  // The fixture's lead teacher has a profile but no role; seeing their class needs INSTRUCTOR.
  const teacher = fixture.teachers[0]!;
  await assignRole(sql, schoolId, teacher.userId, ROLES.INSTRUCTOR);

  await createMaterial(sql, schoolId, {
    classId: fixture.cls.id,
    uploadedByUserId: teacher.userId,
  });

  return {
    schoolId,
    classId: fixture.cls.id,
    studentId: fixture.students[0]!.id,
    officer: { schoolId, userId: officerUser.id, roles: [ROLES.ATTENDANCE_OFFICER] },
    teacher: { schoolId, userId: teacher.userId, roles: [ROLES.INSTRUCTOR] },
    student: { schoolId, userId: fixture.users.STUDENT.id, roles: [ROLES.STUDENT] },
  };
}

function request(
  actor: Actor,
  method: string,
  path: string,
  body?: unknown,
  channel: "web" | "mobile" = "web",
) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { channel, ...actor },
    body === undefined
      ? undefined
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
}

const TODAY = new Date().toISOString().slice(0, 10);

async function openSession(actor: Actor, classId: string): Promise<string> {
  const res = await request(actor, "POST", "/api/attendance/sessions", {
    class_id: classId,
    session_date: TODAY,
  });
  expect([200, 201]).toContain(res.status);
  return ((await res.json()) as { id: string }).id;
}

/** Row counts the given user sees with RLS armed, straight from the database. */
async function visibleCounts(actor: Actor) {
  let counts: Record<string, number> = {};
  await database!.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${actor.schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${actor.userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const [row] = await tx<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::int FROM app.classes) AS classes,
        (SELECT count(*)::int FROM app.students) AS students,
        (SELECT count(*)::int FROM app.enrollments) AS enrollments,
        (SELECT count(*)::int FROM app.materials) AS materials,
        (SELECT count(*)::int FROM app.gradebooks) AS gradebooks
    `;
    counts = row!;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeDb("attendance officer", () => {
  test("takes, reads, submits and corrects a register for a class they do not teach", async () => {
    const world = await buildWorld();
    const sessionId = await openSession(world.officer, world.classId);

    const batch = await request(world.officer, "POST", "/api/attendance/records/batch", {
      attendance_session_id: sessionId,
      records: [{ student_id: world.studentId, status: "absent" }],
    });
    expect(batch.status).toBe(201);

    const read = await request(
      world.officer,
      "GET",
      `/api/attendance/sessions/${sessionId}/records`,
    );
    expect(read.status).toBe(200);
    const { records } = (await read.json()) as {
      records: { id: string; student_id: string; status: string }[];
    };
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ student_id: world.studentId, status: "absent" });

    const submit = await request(world.officer, "PATCH", `/api/attendance/sessions/${sessionId}`, {
      status: "submitted",
    });
    expect(submit.status).toBe(200);

    const correct = await request(
      world.officer,
      "PATCH",
      `/api/attendance/records/${records[0]!.id}`,
      {
        status: "excused",
        reason: "Doctor's note received",
      },
    );
    expect(correct.status).toBe(200);
  });

  test("sees every roster and its attendance, but no class content", async () => {
    const world = await buildWorld();
    const counts = await visibleCounts(world.officer);

    expect(counts.classes).toBeGreaterThan(0);
    expect(counts.students).toBeGreaterThan(0);
    expect(counts.enrollments).toBeGreaterThan(0);
    expect(counts.materials).toBe(0);
    expect(counts.gradebooks).toBe(0);
  });

  test("is refused the principal-only and grade surfaces", async () => {
    const world = await buildWorld();

    const approvals = await request(world.officer, "GET", "/api/approvals/queue");
    expect(approvals.status).toBe(403);
  });
});

describeDb("attendance taking", () => {
  test("the class teacher opens, records and submits their own register", async () => {
    const world = await buildWorld();

    const sessionId = await openSession(world.teacher, world.classId);

    const batch = await request(world.teacher, "POST", "/api/attendance/records/batch", {
      attendance_session_id: sessionId,
      records: [{ student_id: world.studentId, status: "present" }],
    });
    expect(batch.status).toBe(201);

    const submit = await request(world.teacher, "PATCH", `/api/attendance/sessions/${sessionId}`, {
      status: "submitted",
    });
    expect(submit.status).toBe(200);
  });

  test("a teacher who does not teach the class cannot open or record its register", async () => {
    const world = await buildWorld();
    const outsider = await createUser(database!.sql, world.schoolId);
    await assignRole(database!.sql, world.schoolId, outsider.id, ROLES.INSTRUCTOR);
    const actor = { schoolId: world.schoolId, userId: outsider.id, roles: [ROLES.INSTRUCTOR] };

    // Row scope hides the class and its sessions, so both read as not found.
    const open = await request(actor, "POST", "/api/attendance/sessions", {
      class_id: world.classId,
      session_date: TODAY,
    });
    expect(open.status).toBe(404);

    const sessionId = await openSession(world.officer, world.classId);
    const batch = await request(actor, "POST", "/api/attendance/records/batch", {
      attendance_session_id: sessionId,
      records: [{ student_id: world.studentId, status: "present" }],
    });
    expect(batch.status).toBe(404);
  });

  test("a student cannot open or change a session", async () => {
    const world = await buildWorld();

    const open = await request(world.student, "POST", "/api/attendance/sessions", {
      class_id: world.classId,
      session_date: TODAY,
    });
    expect(open.status).toBe(403);

    const sessionId = await openSession(world.officer, world.classId);
    const cancel = await request(world.student, "PATCH", `/api/attendance/sessions/${sessionId}`, {
      status: "cancelled",
    });
    expect(cancel.status).toBe(403);
  });
});

describeDb("a student's attendance records", () => {
  async function recordPresent(world: World): Promise<void> {
    const sessionId = await openSession(world.officer, world.classId);
    const batch = await request(world.officer, "POST", "/api/attendance/records/batch", {
      attendance_session_id: sessionId,
      records: [{ student_id: world.studentId, status: "late", minutes_late: 5 }],
    });
    expect(batch.status).toBe(201);
  }

  function recordsPath(world: World, start = TODAY, end = TODAY): string {
    return `/api/attendance/students/${world.studentId}/records?start_date=${start}&end_date=${end}`;
  }

  test("the officer and the class teacher see the record with its session and class", async () => {
    const world = await buildWorld();
    await recordPresent(world);

    for (const actor of [world.officer, world.teacher]) {
      const res = await request(actor, "GET", recordsPath(world));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        student_id: string;
        records: { session_date: string; class_id: string; status: string; minutes_late: number }[];
      };
      expect(body.student_id).toBe(world.studentId);
      expect(body.records).toHaveLength(1);
      expect(body.records[0]).toMatchObject({
        session_date: TODAY,
        class_id: world.classId,
        status: "late",
        minutes_late: 5,
      });
    }
  });

  test("a teacher who does not teach the class sees nothing", async () => {
    const world = await buildWorld();
    await recordPresent(world);
    const outsider = await createUser(database!.sql, world.schoolId);
    await assignRole(database!.sql, world.schoolId, outsider.id, ROLES.INSTRUCTOR);

    const res = await request(
      { schoolId: world.schoolId, userId: outsider.id, roles: [ROLES.INSTRUCTOR] },
      "GET",
      recordsPath(world),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { records: unknown[] }).records).toHaveLength(0);
  });

  test("a student is refused, and a reversed date range is rejected", async () => {
    const world = await buildWorld();

    expect((await request(world.student, "GET", recordsPath(world))).status).toBe(403);
    expect(
      (await request(world.officer, "GET", recordsPath(world, "2026-02-01", "2026-01-01"))).status,
    ).toBe(400);
  });
});

describeDb("attendance class roster", () => {
  test("gives the officer and the class teacher names on a mobile session", async () => {
    const world = await buildWorld();

    for (const actor of [world.officer, world.teacher]) {
      const res = await request(
        actor,
        "GET",
        `/api/attendance/classes/${world.classId}/roster`,
        undefined,
        "mobile",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        class_id: string;
        students: { id: string; name: string }[];
      };
      expect(body.class_id).toBe(world.classId);
      expect(body.students).toEqual([{ id: world.studentId, name: "Primary TestStudent" }]);
      expect(Object.keys(body.students[0]!).sort()).toEqual(["id", "name"]);
    }
  });

  test("is refused to a student", async () => {
    const world = await buildWorld();
    const res = await request(
      world.student,
      "GET",
      `/api/attendance/classes/${world.classId}/roster`,
      undefined,
      "mobile",
    );
    expect(res.status).toBe(403);
  });
});
