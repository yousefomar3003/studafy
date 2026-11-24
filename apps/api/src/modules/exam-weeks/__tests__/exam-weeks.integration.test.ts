/**
 * Exam weeks (000265) against a real migrated database with RLS armed.
 *
 * Grade 10 this year: 10A (Amal, Badr) and 10B (Carim, Dina). Dina is exempt from Physics.
 * Rooms: Hall (exam capacity 3, everyday 40) and Room 1 (capacity 2).
 *
 *   Math     grade 10, 10A + 10B, 09:00-11:00, Hall then Room 1
 *   Physics  grade 10, 10A + 10B, 10:00-12:00, Hall (shared with Math) -> Amal and Badr have two
 *            exams at once; Hall goes over capacity.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/exam-weeks/__tests__/exam-weeks.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  authenticatedRequest,
  createFullTenant,
  createStudent,
  createSubject,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { createGradeLevel, createSection } from "../../academics/section-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type {
  ExamClashView,
  ExamPeriodView,
  ExamSlotSeatingView,
  ExamSlotView,
  InvigilationDutyView,
  StudentExamTimetableView,
} from "../service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;
let otherTenant: TenantFixture;

const ids = {} as Record<string, string>;
const YEAR = new Date().getFullYear();
const day = (d: number) => `${YEAR}-12-${String(d).padStart(2, "0")}`;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  otherTenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  const created = createTestApp({ database: db.sql });
  await created.ready;
  http = created;
}, 120_000);

afterAll(async () => {
  http?.keyStore.destroy();
  if (client) await client.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const auth = (userId: string, role: keyof typeof ROLES, fixture = tenant): TestAuthContext => ({
  schoolId: fixture.schoolId,
  userId,
  roles: [ROLES[role]],
});
const adminAuth = () => auth(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
const otherAdminAuth = () => auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant);
const amalAuth = () => auth(ids.amalUser!, "STUDENT");
const carimAuth = () => auth(ids.carimUser!, "STUDENT");
const parentAuth = () => auth(ids.parent!, "PARENT");
const otherParentAuth = () => auth(ids.otherParent!, "PARENT");
const teacherAuth = () => auth(tenant.teachers[0]!.userId, "INSTRUCTOR");
const secondTeacherAuth = () => auth(ids.teacher2User!, "INSTRUCTOR");

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  as: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await authenticatedRequest(
    http,
    method,
    path,
    as,
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const PERIODS = "/api/academics/exam-periods";
const period = (id = ids.period!) => `${PERIODS}/${id}`;
const slot = (id: string) => `/api/academics/exam-slots/${id}`;
const timetable = (studentId: string) => `/api/academics/students/${studentId}/exam-timetable`;
const DUTIES = "/api/academics/me/invigilation-duties";

function periodBody(overrides: Record<string, unknown> = {}) {
  return {
    academic_year_id: tenant.academicYear.id,
    name: "Term 1 finals",
    kind: "final",
    starts_on: day(7),
    ends_on: day(14),
    grade_level_ids: [ids.grade10],
    ...overrides,
  };
}

function mathBody(overrides: Record<string, unknown> = {}) {
  return {
    subject_id: ids.math,
    grade_level_id: ids.grade10,
    section_ids: [ids.sectionA, ids.sectionB],
    exam_date: day(8),
    starts_at: "09:00",
    ends_at: "11:00",
    room_ids: [ids.hall, ids.room1],
    ...overrides,
  };
}

describeDb("exam weeks", () => {
  test("setup: grade 10, two sections, four students, subjects, a parent and a second teacher", async () => {
    ids.amal = tenant.students[0]!.id;
    ids.amalUser = tenant.students[0]!.userId;
    for (const [key, name] of [
      ["badr", "Badr"],
      ["carim", "Carim"],
      ["dina", "Dina"],
    ] as const) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[key] = student.id;
      ids[`${key}User`] = student.userId;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MATH10", name: "Math" })).id;
    ids.physics = (
      await createSubject(db.sql, tenant.schoolId, { code: "PHY10", name: "Physics" })
    ).id;

    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Amal's parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const otherParent = await createUser(db.sql, tenant.schoolId, { displayName: "Dina's parent" });
    await assignRole(db.sql, tenant.schoolId, otherParent.id, ROLES.PARENT);
    for (const [parentId, studentId, name] of [
      [parent.id, ids.amal!, "Amal family"],
      [otherParent.id, ids.dina!, "Dina family"],
    ] as const) {
      const [family] = await db.sql<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${tenant.schoolId}::uuid, ${name}, ${parentId}::uuid)
        RETURNING id
      `;
      await db.sql`
        INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parentId}::uuid, ${studentId}::uuid, 'mother')
      `;
    }
    ids.parent = parent.id;
    ids.otherParent = otherParent.id;

    const teacher2 = await createTeacher(db.sql, tenant.schoolId);
    await assignRole(db.sql, tenant.schoolId, teacher2.userId, ROLES.INSTRUCTOR);
    ids.teacher2 = teacher2.id;
    ids.teacher2User = teacher2.userId;

    await withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
      async (tx) => {
        ids.grade10 = (
          await createGradeLevel(tx, tenant.schoolId, { name: "Grade 10", sort_order: 10 })
        ).id;
        ids.grade11 = (
          await createGradeLevel(tx, tenant.schoolId, { name: "Grade 11", sort_order: 11 })
        ).id;
        for (const [key, grade, name] of [
          ["sectionA", "grade10", "10A"],
          ["sectionB", "grade10", "10B"],
          ["section11", "grade11", "11A"],
        ] as const) {
          ids[key] = (
            await createSection(tx, tenant.schoolId, {
              academic_year_id: tenant.academicYear.id,
              grade_level_id: ids[grade]!,
              name,
            })
          ).id;
        }
      },
    );
    for (const [student, section] of [
      ["amal", "sectionA"],
      ["badr", "sectionA"],
      ["carim", "sectionB"],
      ["dina", "sectionB"],
    ] as const) {
      await db.sql`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES (${tenant.schoolId}::uuid, ${ids[student]!}::uuid, ${tenant.academicYear.id}::uuid,
                ${ids[section]!}::uuid)
      `;
    }
    await db.sql`
      INSERT INTO app.student_subject_enrollments (
        school_id, academic_year_id, student_id, subject_id, status, reason
      )
      VALUES (${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${ids.dina!}::uuid,
              ${ids.physics!}::uuid, 'exempt', 'Medical')
    `;
    await db.sql`
      INSERT INTO app.school_settings (school_id, timezone)
      VALUES (${tenant.schoolId}::uuid, 'Asia/Amman')
      ON CONFLICT (school_id) DO UPDATE SET timezone = 'Asia/Amman'
    `;
  });

  test("leadership adds rooms with an exam capacity; others cannot", async () => {
    const hall = await call<{ id: string; exam_capacity: number; capacity: number }>(
      "POST",
      "/api/academics/rooms",
      adminAuth(),
      { code: "HALL", name: "Main hall", building: "Block A", capacity: 40, exam_capacity: 2 },
    );
    expect(hall.status).toBe(201);
    expect(hall.body).toMatchObject({ capacity: 40, exam_capacity: 2, is_active: true });
    ids.hall = hall.body.id;
    const room1 = await call<{ id: string }>("POST", "/api/academics/rooms", adminAuth(), {
      code: "R1",
      name: "Room 1",
      building: "Block A",
      floor: "1",
      capacity: 2,
    });
    expect(room1.status).toBe(201);
    ids.room1 = room1.body.id;

    const duplicate = await call("POST", "/api/academics/rooms", adminAuth(), {
      code: "HALL",
      name: "Again",
      building: "Block A",
    });
    expect(duplicate.status).toBe(409);
    const asTeacher = await call("POST", "/api/academics/rooms", teacherAuth(), {
      code: "T1",
      name: "Teacher's",
      building: "Block A",
    });
    expect(asTeacher.status).toBe(403);

    const edited = await call<{ exam_capacity: number }>(
      "PATCH",
      `/api/academics/rooms/${ids.hall}`,
      adminAuth(),
      { exam_capacity: 3 },
    );
    expect(edited.status).toBe(200);
    expect(edited.body.exam_capacity).toBe(3);
    const otherSchool = await call("PATCH", `/api/academics/rooms/${ids.hall}`, otherAdminAuth(), {
      exam_capacity: 9,
    });
    expect(otherSchool.status).toBe(404);

    const listed = await call<{ rooms: { id: string; exam_capacity: number | null }[] }>(
      "GET",
      "/api/academics/rooms?limit=100",
      adminAuth(),
    );
    expect(listed.body.rooms.find((room) => room.id === ids.hall)?.exam_capacity).toBe(3);
  });

  test("leadership adds an exam period; it is checked", async () => {
    const created = await call<ExamPeriodView>("POST", PERIODS, adminAuth(), periodBody());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Term 1 finals",
      kind: "final",
      status: "draft",
      published_at: null,
      starts_on: day(7),
      ends_on: day(14),
      grade_levels: [{ id: ids.grade10, name: "Grade 10" }],
      slots: [],
    });
    ids.period = created.body.id;

    expect((await call("POST", PERIODS, adminAuth(), periodBody())).status).toBe(409);
    expect(
      (
        await call(
          "POST",
          PERIODS,
          adminAuth(),
          periodBody({ name: "Late", ends_on: `${YEAR + 1}-01-05` }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await call("POST", PERIODS, adminAuth(), periodBody({ name: "Backwards", ends_on: day(1) })))
        .status,
    ).toBe(400);
    for (const as of [teacherAuth(), amalAuth(), parentAuth()]) {
      expect((await call("POST", PERIODS, as, periodBody({ name: "Nope" }))).status).toBe(403);
      expect((await call("GET", PERIODS, as)).status).toBe(403);
    }

    const listed = await call<{ periods: { id: string }[] }>(
      "GET",
      `${PERIODS}?academic_year_id=${tenant.academicYear.id}`,
      adminAuth(),
    );
    expect(listed.body.periods.map((p) => p.id)).toEqual([ids.period]);
  });

  test("exams go on the timetable; who sits each is worked out", async () => {
    const math = await call<ExamSlotView>("POST", `${period()}/slots`, adminAuth(), mathBody());
    expect(math.status).toBe(201);
    expect(math.body).toMatchObject({
      subject: { id: ids.math, code: "MATH10", name: "Math" },
      grade_level: { id: ids.grade10, name: "Grade 10" },
      sections: [
        { id: ids.sectionA, name: "10A" },
        { id: ids.sectionB, name: "10B" },
      ],
      exam_date: day(8),
      starts_at: "09:00",
      ends_at: "11:00",
      candidates: 4,
      seated: 0,
    });
    expect(math.body.rooms.map((room) => [room.id, room.capacity])).toEqual([
      [ids.hall, 3],
      [ids.room1, 2],
    ]);
    ids.mathSlot = math.body.id;

    const physics = await call<ExamSlotView>(
      "POST",
      `${period()}/slots`,
      adminAuth(),
      mathBody({
        subject_id: ids.physics,
        starts_at: "10:00",
        ends_at: "12:00",
        room_ids: [ids.hall],
      }),
    );
    expect(physics.status).toBe(201);
    // Dina is exempt from Physics.
    expect(physics.body.candidates).toBe(3);
    ids.physicsSlot = physics.body.id;
  });

  test("an exam is refused outside the period, for another grade's section, or ending first", async () => {
    const bad = [
      mathBody({ exam_date: day(20) }),
      mathBody({ section_ids: [ids.section11] }),
      mathBody({ grade_level_id: ids.grade11, section_ids: [ids.section11] }),
      mathBody({ starts_at: "11:00", ends_at: "09:00" }),
      mathBody({ room_ids: [otherTenant.room.id] }),
      mathBody({ assessment_id: crypto.randomUUID() }),
    ];
    for (const body of bad) {
      expect((await call("POST", `${period()}/slots`, adminAuth(), body)).status).toBe(400);
    }
    expect(
      (await call("POST", `${period()}/slots`, adminAuth(), mathBody({ starts_at: "9am" }))).status,
    ).toBe(400);
  });

  test("seating by section fills the rooms in order; regenerating keeps every seat", async () => {
    const seated = await call<ExamSlotSeatingView & { kept: number }>(
      "POST",
      `${slot(ids.mathSlot!)}/seating`,
      adminAuth(),
      { strategy: "by_section" },
    );
    expect(seated.status).toBe(200);
    expect(
      seated.body.seats.map((seat) => [seat.student_id, seat.room_id, seat.seat_number]),
    ).toEqual([
      // "Badr Test" before "Primary TestStudent" (Amal): by last name.
      [ids.badr, ids.hall, 1],
      [ids.amal, ids.hall, 2],
      [ids.carim, ids.hall, 3],
      [ids.dina, ids.room1, 1],
    ]);
    expect(seated.body.unseated).toEqual([]);
    expect(seated.body.seats[1]).toMatchObject({
      first_name: "Primary",
      section: { id: ids.sectionA, name: "10A" },
    });

    const again = await call<ExamSlotSeatingView & { kept: number }>(
      "POST",
      `${slot(ids.mathSlot!)}/seating`,
      adminAuth(),
      { strategy: "mixed" },
    );
    expect(again.body.kept).toBe(4);
    expect(again.body.seats).toEqual(seated.body.seats);

    const mixed = await call<ExamSlotSeatingView & { kept: number }>(
      "POST",
      `${slot(ids.mathSlot!)}/seating`,
      adminAuth(),
      { strategy: "mixed", keep_existing: false },
    );
    expect(mixed.body.kept).toBe(0);
    // One from 10A, one from 10B in turn.
    expect(mixed.body.seats.map((seat) => seat.section.name)).toEqual(["10A", "10B", "10A", "10B"]);
  });

  test("a shared room's seats are kept apart; whoever does not fit is left unseated", async () => {
    const physics = await call<ExamSlotSeatingView & { kept: number }>(
      "POST",
      `${slot(ids.physicsSlot!)}/seating`,
      adminAuth(),
      { strategy: "alphabetical" },
    );
    expect(physics.status).toBe(200);
    // Math already uses Hall seats 1-3 at the same time: nothing is left in the hall.
    expect(physics.body.seats).toEqual([]);
    expect(physics.body.unseated).toHaveLength(3);
  });

  test("a seat is moved by hand, or swapped with the student sitting there", async () => {
    const before = await call<{ slots: ExamSlotSeatingView[] }>(
      "GET",
      `${period()}/seating`,
      adminAuth(),
    );
    const math = before.body.slots.find((s) => s.slot_id === ids.mathSlot)!;
    const inRoom1 = math.seats.find((seat) => seat.room_id === ids.room1)!;
    const inHall = math.seats.find((seat) => seat.room_id === ids.hall)!;

    const moved = await call<ExamSlotSeatingView>(
      "PUT",
      `${slot(ids.mathSlot!)}/seats/${inRoom1.student_id}`,
      adminAuth(),
      { room_id: ids.room1, seat_number: 2 },
    );
    expect(moved.status).toBe(200);
    expect(moved.body.seats.find((s) => s.student_id === inRoom1.student_id)?.seat_number).toBe(2);

    const swapped = await call<ExamSlotSeatingView>(
      "PUT",
      `${slot(ids.mathSlot!)}/seats/${inRoom1.student_id}`,
      adminAuth(),
      { room_id: ids.hall, seat_number: inHall.seat_number },
    );
    expect(swapped.status).toBe(200);
    const after = new Map(
      swapped.body.seats.map((s) => [s.student_id, [s.room_id, s.seat_number]]),
    );
    expect(after.get(inRoom1.student_id)).toEqual([ids.hall, inHall.seat_number]);
    expect(after.get(inHall.student_id)).toEqual([ids.room1, 2]);

    const seatOf = (id: string) => `${slot(ids.mathSlot!)}/seats/${id}`;
    expect(
      (
        await call("PUT", seatOf(inHall.student_id), adminAuth(), {
          room_id: ids.room1,
          seat_number: 3,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", seatOf(ids.amal!), adminAuth(), {
          room_id: tenant.room.id,
          seat_number: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", `${slot(ids.physicsSlot!)}/seats/${ids.amal}`, adminAuth(), {
          room_id: ids.hall,
          seat_number: 1,
        })
      ).status,
    ).toBe(404);
  });

  test("invigilators are set per room; clashes are reported", async () => {
    const math = await call<ExamSlotView>(
      "PUT",
      `${slot(ids.mathSlot!)}/invigilators`,
      adminAuth(),
      {
        rooms: [
          { room_id: ids.hall, teacher_ids: [tenant.teachers[0]!.id] },
          { room_id: ids.room1, teacher_ids: [ids.teacher2] },
        ],
      },
    );
    expect(math.status).toBe(200);
    expect(math.body.rooms.map((room) => room.invigilators.map((t) => t.id))).toEqual([
      [tenant.teachers[0]!.id],
      [ids.teacher2],
    ]);
    // Physics also uses Room 1 now, watched by the hall's teacher at the same time as Math.
    const physics = await call<ExamSlotView>(
      "PUT",
      slot(ids.physicsSlot!),
      adminAuth(),
      mathBody({
        subject_id: ids.physics,
        starts_at: "10:00",
        ends_at: "12:00",
        room_ids: [ids.hall, ids.room1],
      }),
    );
    expect(physics.status).toBe(200);
    expect(
      (
        await call("PUT", `${slot(ids.physicsSlot!)}/invigilators`, adminAuth(), {
          rooms: [{ room_id: ids.room1, teacher_ids: [tenant.teachers[0]!.id] }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("PUT", `${slot(ids.physicsSlot!)}/invigilators`, adminAuth(), {
          rooms: [{ room_id: tenant.room.id, teacher_ids: [ids.teacher2] }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PUT", `${slot(ids.physicsSlot!)}/invigilators`, adminAuth(), {
          rooms: [{ room_id: ids.room1, teacher_ids: [otherTenant.teachers[0]!.id] }],
        })
      ).status,
    ).toBe(400);

    const clashes = await call<{ clashes: ExamClashView[] }>(
      "GET",
      `${period()}/clashes`,
      adminAuth(),
    );
    expect(clashes.status).toBe(200);
    const byType = new Map(clashes.body.clashes.map((clash) => [clash.type, clash]));
    expect(byType.get("teacher_double_booked")).toMatchObject({
      severity: "error",
      teacher: { id: tenant.teachers[0]!.id },
      room_ids: [ids.hall, ids.room1].sort(),
    });
    const students = byType.get("student_double_booked")!;
    expect(students.severity).toBe("error");
    // Dina is exempt from Physics; the other three sit both.
    expect(students.students.map((s) => s.id).sort()).toEqual(
      [ids.amal!, ids.badr!, ids.carim!].sort(),
    );
    expect(students.count).toBe(3);
    expect(byType.get("unseated_students")).toMatchObject({ severity: "warning", count: 3 });
  });

  test("a draft period is invisible to students, parents and invigilators", async () => {
    const own = await call<StudentExamTimetableView>("GET", timetable(ids.amal!), amalAuth());
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ student_id: ids.amal, timezone: "Asia/Amman", periods: [] });
    const duties = await call<{ duties: InvigilationDutyView[] }>("GET", DUTIES, teacherAuth());
    expect(duties.body.duties).toEqual([]);
  });

  test("published: a student sees their exams with room and seat, in the school's timezone", async () => {
    const published = await call<ExamPeriodView>(
      "PUT",
      period(),
      adminAuth(),
      periodBody({ status: "published" }),
    );
    expect(published.status).toBe(200);
    expect(published.body.status).toBe("published");
    expect(published.body.published_at).not.toBeNull();

    const seating = await call<{ slots: ExamSlotSeatingView[] }>(
      "GET",
      `${period()}/seating`,
      adminAuth(),
    );
    const amalSeat = seating.body.slots
      .find((s) => s.slot_id === ids.mathSlot)!
      .seats.find((seat) => seat.student_id === ids.amal)!;

    const own = await call<StudentExamTimetableView>("GET", timetable(ids.amal!), amalAuth());
    expect(own.status).toBe(200);
    expect(own.body.timezone).toBe("Asia/Amman");
    expect(own.body.periods).toHaveLength(1);
    const [finals] = own.body.periods;
    expect(finals).toMatchObject({ id: ids.period, name: "Term 1 finals", kind: "final" });
    expect(finals!.slots.map((s) => s.subject.name)).toEqual(["Math", "Physics"]);
    expect(finals!.slots[0]).toMatchObject({
      exam_date: day(8),
      starts_at: "09:00",
      ends_at: "11:00",
      room: { id: amalSeat.room_id },
      seat_number: amalSeat.seat_number,
    });
    // Not seated in Physics yet.
    expect(finals!.slots[1]).toMatchObject({ room: null, seat_number: null });

    // Dina is exempt from Physics: only Math.
    const dina = await call<StudentExamTimetableView>(
      "GET",
      timetable(ids.dina!),
      otherParentAuth(),
    );
    expect(dina.status).toBe(200);
    expect(dina.body.periods[0]!.slots.map((s) => s.subject.name)).toEqual(["Math"]);
  });

  test("a parent sees only their own child's exam timetable", async () => {
    const child = await call<StudentExamTimetableView>("GET", timetable(ids.amal!), parentAuth());
    expect(child.status).toBe(200);
    expect(child.body.periods[0]!.slots).toHaveLength(2);

    expect((await call("GET", timetable(ids.carim!), parentAuth())).status).toBe(403);
    expect((await call("GET", timetable(ids.amal!), otherParentAuth())).status).toBe(403);
    expect((await call("GET", timetable(ids.amal!), carimAuth())).status).toBe(403);
  });

  test("teachers see their own invigilation duties", async () => {
    const first = await call<{ timezone: string; duties: InvigilationDutyView[] }>(
      "GET",
      DUTIES,
      teacherAuth(),
    );
    expect(first.status).toBe(200);
    expect(first.body.timezone).toBe("Asia/Amman");
    expect(first.body.duties.map((d) => [d.subject.name, d.room.id, d.starts_at])).toEqual([
      ["Math", ids.hall, "09:00"],
      ["Physics", ids.room1, "10:00"],
    ]);
    expect(first.body.duties[0]).toMatchObject({
      period: { id: ids.period, name: "Term 1 finals" },
      grade_level: { name: "Grade 10" },
      exam_date: day(8),
      ends_at: "11:00",
    });

    const second = await call<{ duties: InvigilationDutyView[] }>(
      "GET",
      DUTIES,
      secondTeacherAuth(),
    );
    expect(second.body.duties.map((d) => [d.subject.name, d.room.id])).toEqual([
      ["Math", ids.room1],
    ]);
    const student = await call<{ duties: InvigilationDutyView[] }>("GET", DUTIES, amalAuth());
    expect(student.status).toBe(200);
    expect(student.body.duties).toEqual([]);
  });

  test("another school sees nothing and changes nothing", async () => {
    const other = otherAdminAuth();
    expect((await call("GET", period(), other)).status).toBe(404);
    expect((await call("GET", `${period()}/seating`, other)).status).toBe(404);
    expect((await call("GET", `${period()}/clashes`, other)).status).toBe(404);
    expect((await call("PUT", period(), other, periodBody())).status).toBe(404);
    expect((await call("DELETE", period(), other)).status).toBe(404);
    expect((await call("PUT", slot(ids.mathSlot!), other, mathBody())).status).toBe(404);
    expect((await call("DELETE", slot(ids.mathSlot!), other)).status).toBe(404);
    expect(
      (await call("POST", `${slot(ids.mathSlot!)}/seating`, other, { strategy: "mixed" })).status,
    ).toBe(404);
    expect(
      (await call("PUT", `${slot(ids.mathSlot!)}/invigilators`, other, { rooms: [] })).status,
    ).toBe(404);
    const listed = await call<{ periods: unknown[] }>("GET", PERIODS, other);
    expect(listed.body.periods).toEqual([]);
    expect([403, 404]).toContain((await call("GET", timetable(ids.amal!), other)).status);
    const duties = await call<{ duties: unknown[] }>(
      "GET",
      DUTIES,
      auth(otherTenant.teachers[0]!.userId, "INSTRUCTOR", otherTenant),
    );
    expect(duties.body.duties).toEqual([]);
  });

  test("the period cannot shrink past its exams; deleting an exam or the period cascades", async () => {
    const shrink = await call("PUT", period(), adminAuth(), periodBody({ ends_on: day(7) }));
    expect(shrink.status).toBe(409);

    expect((await call("DELETE", slot(ids.physicsSlot!), adminAuth())).status).toBe(204);
    const after = await call<ExamPeriodView>("GET", period(), adminAuth());
    expect(after.body.slots.map((s) => s.id)).toEqual([ids.mathSlot]);
    expect(after.body.slot_count).toBe(1);

    const audit = await db.sql<{ action: string; target_table: string }[]>`
      SELECT action::text, target_table FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table LIKE 'exam_period%'
      ORDER BY created_at
    `;
    expect(new Set(audit.map((row) => row.target_table))).toEqual(
      new Set([
        "exam_periods",
        "exam_period_slots",
        "exam_period_seats",
        "exam_period_invigilators",
      ]),
    );

    expect((await call("DELETE", period(), adminAuth())).status).toBe(204);
    expect((await call("GET", period(), adminAuth())).status).toBe(404);
    const [left] = await db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.exam_period_seats
      WHERE school_id = ${tenant.schoolId}::uuid
    `;
    expect(left!.count).toBe(0);
  });
});
