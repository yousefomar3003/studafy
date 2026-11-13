// eslint-disable-next-line import-x/no-unresolved
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createAcademicYear,
  createClass,
  createCourse,
  createEnrollment,
  createRoom,
  createSchool,
  createStudent,
  createSubject,
  createTeacher,
  createTerm,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  type TestDatabase,
} from "../../../../tests/harness";
import { getGradebookByClassId } from "../config/gradebook-config-service";
import { createAssessment, submitSubmission } from "../grade-entry-service";

import type { Sql, TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
});

afterAll(async () => {
  if (db?.cleanup) await db.cleanup();
});

async function asUser<T>(
  schoolId: string,
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await db.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    result = await fn(tx);
  });
  return result as T;
}

interface AuthoringTenant {
  schoolId: string;
  teacherUserId: string;
  classId: string;
  studentIds: string[];
}

async function seedTenant(sql: Sql, studentCount = 3): Promise<AuthoringTenant> {
  const school = await createSchool(sql);
  const teacher = await createTeacher(sql, school.id);
  const year = await createAcademicYear(sql, school.id);
  const term = await createTerm(sql, school.id, year.id);
  const subject = await createSubject(sql, school.id);
  const course = await createCourse(sql, school.id, subject.id);
  const room = await createRoom(sql, school.id);
  const cls = await createClass(sql, school.id, {
    courseId: course.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacher.id,
    roomId: room.id,
  });

  const studentIds: string[] = [];
  for (let i = 0; i < studentCount; i++) {
    const student = await createStudent(sql, school.id);
    await createEnrollment(sql, school.id, cls.id, student.id);
    studentIds.push(student.id);
  }

  return { schoolId: school.id, teacherUserId: teacher.userId, classId: cls.id, studentIds };
}

describeDb("grade entry — gradebook resolution", () => {
  test("getGradebookByClassId creates once, then returns the same row", async () => {
    const t = await seedTenant(db.sql, 1);

    const first = await asUser(t.schoolId, t.teacherUserId, (tx) =>
      getGradebookByClassId(tx, t.schoolId, t.classId),
    );
    const second = await asUser(t.schoolId, t.teacherUserId, (tx) =>
      getGradebookByClassId(tx, t.schoolId, t.classId),
    );

    expect(first.id).toBe(second.id);
    expect(first.class_id).toBe(t.classId);
    expect(first.status).toBe("draft");
  });
});

describeDb("grade entry — createAssessment", () => {
  test("seeds one ungraded row per enrolled student's draft submission", async () => {
    const t = await seedTenant(db.sql, 3);

    const grid = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.classId);
      return createAssessment(tx, t.schoolId, gradebook.id, t.classId, {
        label: "Midterm",
        maxScore: 50,
        weight: 2,
      });
    });

    expect(grid).toHaveLength(3);
    for (const submission of grid) {
      expect(submission.status).toBe("draft");
      expect(submission.grades).toHaveLength(1);
      expect(submission.grades[0]!.label).toBe("Midterm");
      expect(Number(submission.grades[0]!.max_score)).toBe(50);
      expect(Number(submission.grades[0]!.weight)).toBe(2);
      expect(submission.grades[0]!.score).toBeNull();
    }
  });

  test("is idempotent per (student, label)", async () => {
    const t = await seedTenant(db.sql, 2);

    const grid = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.classId);
      await createAssessment(tx, t.schoolId, gradebook.id, t.classId, {
        label: "Quiz 1",
        maxScore: 10,
        weight: 1,
      });
      return createAssessment(tx, t.schoolId, gradebook.id, t.classId, {
        label: "Quiz 1",
        maxScore: 10,
        weight: 1,
      });
    });

    for (const submission of grid) {
      expect(submission.grades.filter((g) => g.label === "Quiz 1")).toHaveLength(1);
    }
  });

  test("skips students whose submission is no longer a draft", async () => {
    const t = await seedTenant(db.sql, 2);

    const grid = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.classId);
      const seeded = await createAssessment(tx, t.schoolId, gradebook.id, t.classId, {
        label: "Homework 1",
        maxScore: 20,
        weight: 1,
      });
      // Lock the first student's submission.
      const locked = seeded[0]!;
      await submitSubmission(
        tx,
        t.schoolId,
        gradebook.id,
        locked.id,
        locked.updated_at.toISOString(),
        t.teacherUserId,
      );
      return createAssessment(tx, t.schoolId, gradebook.id, t.classId, {
        label: "Homework 2",
        maxScore: 20,
        weight: 1,
      });
    });

    const submitted = grid.find((s) => s.status === "submitted")!;
    const stillDraft = grid.find((s) => s.status === "draft")!;
    expect(submitted.grades.map((g) => g.label)).toEqual(["Homework 1"]);
    expect(stillDraft.grades.map((g) => g.label).sort()).toEqual(["Homework 1", "Homework 2"]);
  });

  test("rejects a non-positive max_score", async () => {
    const t = await seedTenant(db.sql, 1);

    const error = await asUser(t.schoolId, t.teacherUserId, async (tx) => {
      const gradebook = await getGradebookByClassId(tx, t.schoolId, t.classId);
      try {
        await createAssessment(tx, t.schoolId, gradebook.id, t.classId, {
          label: "Bad",
          maxScore: 0,
          weight: 1,
        });
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught : new Error(String(caught));
      }
    });

    expect(error?.message).toContain("max_score");
  });
});
