/**
 * Exam scheduling service tests.
 *
 * Integration tests that require a live PostgreSQL instance. Each test creates its own
 * school and academic data via the test harness factories, then exercises the service
 * functions directly within a tenant transaction.
 *
 * Set TEST_DATABASE_URL to run these:
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academics/__tests__/exam-service
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeAll, afterAll } from "bun:test";

import {
  createTestDatabase,
  migrateDatabase,
  createSchool,
  createTeacher,
  createRoom,
  createAcademicYear,
  createTerm,
  createSubject,
  createCourse,
  createClass,
  integrationEnabled,
  type TestDatabase,
} from "../../../../tests/harness";
import {
  listExams,
  getExamById,
  createExam,
  updateExam,
  deleteExam,
  checkTimetableConflicts,
} from "../exam-service";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Skip when no database is available
// ---------------------------------------------------------------------------

const describeDb = integrationEnabled ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('role', 'studafy_app', true)`;
    result = await fn(tx);
  });
  return result as T;
}

/** Build an ISO-8601 datetime string for the given weekday in the current week. */
function weekdayDate(weekday: number, hour = 9): string {
  const now = new Date();
  // ISODOW: 1=Mon .. 7=Sun. JS getDay(): 0=Sun .. 6=Sat.
  const jsDay = weekday <= 6 ? weekday : 0;
  const currentJsDay = now.getDay();
  const diff = jsDay - currentJsDay;
  const target = new Date(now);
  target.setDate(target.getDate() + diff);
  target.setHours(hour, 0, 0, 0);
  return target.toISOString();
}

// ---------------------------------------------------------------------------
// Exam service
// ---------------------------------------------------------------------------

describeDb("exam service", () => {
  test("createExam inserts a row and returns it with empty warnings", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    const startsAt = weekdayDate(1, 9);
    const endsAt = weekdayDate(1, 11);

    const result = await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Midterm Mathematics",
        description: "Chapters 1-5",
        starts_at: startsAt,
        ends_at: endsAt,
        max_score: 100,
        room_id: room.id,
        weight: 2,
      }),
    );

    expect(result.exam).toBeDefined();
    expect(result.exam.title).toBe("Midterm Mathematics");
    expect(result.exam.description).toBe("Chapters 1-5");
    expect(result.exam.status).toBe("draft");
    expect(result.exam.class_id).toBe(cls.id);
    expect(result.exam.room_id).toBe(room.id);
    expect(result.exam.weight).toBe(2);
    expect(result.exam.max_score).toBe(100);
    expect(result.warnings).toEqual([]);
  });

  test("createExam rejects non-existent class", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);

    await expect(
      withTx((tx) =>
        createExam(tx, school.id, teacher.userId, {
          class_id: "00000000-0000-0000-0000-000000000000",
          title: "Bad Class Exam",
          starts_at: weekdayDate(1, 9),
          ends_at: weekdayDate(1, 11),
          max_score: 100,
        }),
      ),
    ).rejects.toThrow("Class not found");
  });

  test("createExam rejects non-existent room", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const room = await createRoom(db.sql, school.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    await expect(
      withTx((tx) =>
        createExam(tx, school.id, teacher.userId, {
          class_id: cls.id,
          title: "Bad Room Exam",
          starts_at: weekdayDate(1, 9),
          ends_at: weekdayDate(1, 11),
          max_score: 100,
          room_id: "00000000-0000-0000-0000-000000000000",
        }),
      ),
    ).rejects.toThrow("Room not found");
  });

  test("getExamById returns undefined for non-existent ID", async () => {
    const school = await createSchool(db.sql);
    const result = await withTx((tx) =>
      getExamById(tx, school.id, "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeUndefined();
  });

  test("listExams returns paginated results for a class", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Exam 1",
        starts_at: weekdayDate(1, 9),
        ends_at: weekdayDate(1, 11),
        max_score: 100,
      }),
    );
    await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Exam 2",
        starts_at: weekdayDate(2, 9),
        ends_at: weekdayDate(2, 11),
        max_score: 50,
      }),
    );

    const { rows, total } = await withTx((tx) =>
      listExams(tx, school.id, { class_id: cls.id, limit: 1, offset: 0 }),
    );
    expect(total).toBe(2);
    expect(rows.length).toBe(1);
  });

  test("listExams filters by status", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Draft Exam",
        starts_at: weekdayDate(1, 9),
        ends_at: weekdayDate(1, 11),
        max_score: 100,
        status: "draft",
      }),
    );
    await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Scheduled Exam",
        starts_at: weekdayDate(2, 9),
        ends_at: weekdayDate(2, 11),
        max_score: 100,
        status: "scheduled",
      }),
    );

    const { total } = await withTx((tx) =>
      listExams(tx, school.id, { class_id: cls.id, status: "draft", limit: 10, offset: 0 }),
    );
    expect(total).toBe(1);
  });

  test("updateExam modifies fields and returns updated row", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    const created = await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Original Title",
        starts_at: weekdayDate(1, 9),
        ends_at: weekdayDate(1, 11),
        max_score: 100,
      }),
    );

    const result = await withTx((tx) =>
      updateExam(tx, school.id, created.exam.id, teacher.userId, {
        title: "Updated Title",
        weight: 3,
      }),
    );

    expect(result.exam.title).toBe("Updated Title");
    expect(result.exam.weight).toBe(3);
  });

  test("updateExam rejects invalid status transition", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    const created = await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Draft Exam",
        starts_at: weekdayDate(1, 9),
        ends_at: weekdayDate(1, 11),
        max_score: 100,
        status: "draft",
      }),
    );

    await expect(
      withTx((tx) =>
        updateExam(tx, school.id, created.exam.id, teacher.userId, {
          status: "closed",
        }),
      ),
    ).rejects.toThrow();
  });

  test("deleteExam removes a draft exam", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    const created = await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "To Delete",
        starts_at: weekdayDate(1, 9),
        ends_at: weekdayDate(1, 11),
        max_score: 100,
      }),
    );

    await withTx((tx) => deleteExam(tx, school.id, created.exam.id));
    const result = await withTx((tx) => getExamById(tx, school.id, created.exam.id));
    expect(result).toBeUndefined();
  });

  test("deleteExam rejects non-existent exam", async () => {
    const school = await createSchool(db.sql);

    await expect(
      withTx((tx) => deleteExam(tx, school.id, "00000000-0000-0000-0000-000000000000")),
    ).rejects.toThrow();
  });

  test("deleteExam rejects open exam", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    const created = await withTx((tx) =>
      createExam(tx, school.id, teacher.userId, {
        class_id: cls.id,
        title: "Open Exam",
        starts_at: weekdayDate(1, 9),
        ends_at: weekdayDate(1, 11),
        max_score: 100,
        status: "draft",
      }),
    );

    // Transition draft -> scheduled -> open
    const updated = await withTx((tx) =>
      updateExam(tx, school.id, created.exam.id, teacher.userId, {
        status: "scheduled",
      }),
    );
    await withTx((tx) =>
      updateExam(tx, school.id, updated.exam.id, teacher.userId, {
        status: "open",
      }),
    );

    await expect(withTx((tx) => deleteExam(tx, school.id, created.exam.id))).rejects.toThrow(
      "Only draft or scheduled exams can be deleted",
    );
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describeDb("timetable conflict detection", () => {
  test("returns class_slot warning when exam falls on same weekday as approved timetable slot", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    // Create a draft timetable version, add a slot, then approve it.
    const [version] = await db.sql<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
      VALUES (${school.id}, ${year.id}, ${term.id}, 'Test Timetable', 'draft')
      RETURNING id
    `;

    await db.sql`
      INSERT INTO app.timetable_slots
        (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
      VALUES (${school.id}, ${version!.id}, ${cls.id}, ${teacher.id}, ${room.id}, 1::smallint, 2::smallint)
    `;

    // Approve the version (bypass trigger by going direct as admin)
    await db.sql`
      UPDATE app.timetable_versions
      SET status = 'approved',
          submitted_at = CURRENT_TIMESTAMP,
          submitted_by_user_id = ${teacher.userId},
          approved_at = CURRENT_TIMESTAMP,
          approved_by_user_id = ${teacher.userId}
      WHERE id = ${version!.id} AND school_id = ${school.id}
    `;

    // Check conflicts for a Monday exam (weekday=1)
    const mondayDate = weekdayDate(1, 9);
    const warnings = await withTx((tx) =>
      checkTimetableConflicts(tx, school.id, cls.id, null, new Date(mondayDate)),
    );

    expect(warnings.length).toBe(1);
    expect(warnings[0]!.conflict_type).toBe("class_slot");
    expect(warnings[0]!.entity_id).toBe(cls.id);
    expect(warnings[0]!.weekday).toBe(1);
  });

  test("returns room warning when exam room is booked for a different class on same weekday", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);

    // Create two classes using different rooms
    const cls1 = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
      code: "CLS-1",
    });
    const room2 = await createRoom(db.sql, school.id, { code: "RM-2" });
    const cls2 = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room2.id,
      code: "CLS-2",
    });

    // Create timetable with class2 using room1 on Monday (room conflict scenario)
    const [version] = await db.sql<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name, status)
      VALUES (${school.id}, ${year.id}, ${term.id}, 'TT', 'draft')
      RETURNING id
    `;

    await db.sql`
      INSERT INTO app.timetable_slots
        (school_id, timetable_version_id, class_id, teacher_id, room_id, weekday, period)
      VALUES (${school.id}, ${version!.id}, ${cls2.id}, ${teacher.id}, ${room.id}, 1::smallint, 3::smallint)
    `;

    await db.sql`
      UPDATE app.timetable_versions
      SET status = 'approved',
          submitted_at = CURRENT_TIMESTAMP,
          submitted_by_user_id = ${teacher.userId},
          approved_at = CURRENT_TIMESTAMP,
          approved_by_user_id = ${teacher.userId}
      WHERE id = ${version!.id} AND school_id = ${school.id}
    `;

    // Exam for cls1 in room1 on Monday — cls2 also uses room1 on Monday
    const mondayDate = weekdayDate(1, 9);
    const warnings = await withTx((tx) =>
      checkTimetableConflicts(tx, school.id, cls1.id, room.id, new Date(mondayDate)),
    );

    // Should have class_slot warning (cls1 has a slot?) + room warning (room1 used by cls2)
    // cls1 does NOT have a slot in this timetable, so only room warning
    const roomWarnings = warnings.filter((w) => w.conflict_type === "room");
    expect(roomWarnings.length).toBe(1);
    expect(roomWarnings[0]!.entity_id).toBe(room.id);
  });

  test("returns empty warnings when no approved timetable exists", async () => {
    const school = await createSchool(db.sql);
    const teacher = await createTeacher(db.sql, school.id);
    const room = await createRoom(db.sql, school.id);
    const year = await createAcademicYear(db.sql, school.id);
    const term = await createTerm(db.sql, school.id, year.id);
    const subject = await createSubject(db.sql, school.id);
    const course = await createCourse(db.sql, school.id, subject.id);
    const cls = await createClass(db.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });

    const mondayDate = weekdayDate(1, 9);
    const warnings = await withTx((tx) =>
      checkTimetableConflicts(tx, school.id, cls.id, null, new Date(mondayDate)),
    );

    expect(warnings).toEqual([]);
  });
});
