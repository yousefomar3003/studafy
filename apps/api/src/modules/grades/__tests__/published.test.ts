import { EventEmitter } from "node:events";

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
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
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
  type TestApp,
  type TestDatabase,
} from "../../../../tests/harness";
import { cacheKey } from "../../../cache";
import { createLogger } from "../../../logger";
import { closeRedis, createRedisClient } from "../../../redis";
import {
  getPublishedGradeCache,
  publishedGradeCacheKey,
  setPublishedGradeCacheIfCurrent,
} from "../published/cache";
import { refreshStudentTermSummary } from "../published/service";
import { startGradePublishedSubscriber } from "../subscribers/grade-published.subscriber";

import type { RedisClient } from "../../../redis";
import type { Sql, TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;
const redisIntegrationTest = test.skipIf(!process.env.REDIS_URL);

interface Fixture {
  schoolId: string;
  studentId: string;
  studentUserId: string;
  siblingId: string;
  parentUserId: string;
  adminUserId: string;
  termId: string;
  otherSchoolId: string;
  otherSchoolStudentUserId: string;
}

// Every status a submission can hold without being released. `approved` is the sharpest probe of the
// four: the scores are final and an administrator has already signed off, so only the unpublished
// status itself stands between them and the student. Each gets its own class/course so a leak shows
// up in total_credits as well as in the row list.
const UNPUBLISHED_STATUSES = ["draft", "submitted", "approved", "rejected"] as const;

const unpublishedLabel = (status: (typeof UNPUBLISHED_STATUSES)[number]): string =>
  `Private ${status}`;

let database: TestDatabase;
let testApp: (TestApp & { ready: Promise<void> }) | null = null;
let fixture: Fixture;

async function asAdmin<T>(
  sql: Sql,
  schoolId: string,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    result = await run(tx);
  });
  return result as T;
}

async function createPublishedSubmission(options: {
  schoolId: string;
  classId: string;
  studentId: string;
  submittedBy: string;
  decidedBy: string;
  schemeId: string;
  grades: { label: string; score: number | null; maxScore: number; weight: number }[];
  status?: "draft" | "submitted" | "approved" | "rejected" | "published";
}): Promise<{ gradebookId: string; submissionId: string }> {
  const target = options.status ?? "published";
  return asAdmin(database.sql, options.schoolId, async (tx) => {
    const [gradebook] = await tx<{ id: string }[]>`
      INSERT INTO app.gradebooks (school_id, class_id, status, grading_scheme_id)
      VALUES (
        ${options.schoolId}::uuid,
        ${options.classId}::uuid,
        'active',
        ${options.schemeId}::uuid
      )
      RETURNING id
    `;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id)
      VALUES (${options.schoolId}::uuid, ${gradebook!.id}::uuid, ${options.studentId}::uuid)
      RETURNING id
    `;

    for (const grade of options.grades) {
      await tx`
        INSERT INTO app.grades
          (school_id, grade_submission_id, label, score, max_score, weight)
        VALUES (
          ${options.schoolId}::uuid,
          ${submission!.id}::uuid,
          ${grade.label},
          ${grade.score}::numeric,
          ${grade.maxScore}::numeric,
          ${grade.weight}::numeric
        )
      `;
    }

    if (target !== "draft") {
      await tx`
        UPDATE app.grade_submissions
        SET status = 'submitted', submitted_by_user_id = ${options.submittedBy}::uuid
        WHERE id = ${submission!.id}::uuid
      `;
    }
    if (target === "approved" || target === "published") {
      await tx`
        UPDATE app.grade_submissions
        SET status = 'approved', decided_by_user_id = ${options.decidedBy}::uuid
        WHERE id = ${submission!.id}::uuid
      `;
    }
    if (target === "rejected") {
      await tx`
        UPDATE app.grade_submissions
        SET status = 'rejected',
            decided_by_user_id = ${options.decidedBy}::uuid,
            rejection_reason = 'Not final'
        WHERE id = ${submission!.id}::uuid
      `;
    }
    if (target === "published") {
      await tx`
        UPDATE app.grade_submissions
        SET status = 'published'
        WHERE id = ${submission!.id}::uuid
      `;
      await refreshStudentTermSummary(tx, options.schoolId, options.studentId, gradebook!.id);
    }

    return { gradebookId: gradebook!.id, submissionId: submission!.id };
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);

  const school = await createSchool(database.sql);
  const admin = await createUser(database.sql, school.id);
  await assignRole(database.sql, school.id, admin.id, ROLES.ORG_ADMIN);
  const teacher = await createTeacher(database.sql, school.id);
  const student = await createStudent(database.sql, school.id);
  const sibling = await createStudent(database.sql, school.id);
  const parent = await createUser(database.sql, school.id);
  await assignRole(database.sql, school.id, parent.id, ROLES.PARENT);

  const year = await createAcademicYear(database.sql, school.id);
  const term = await createTerm(database.sql, school.id, year.id);
  const subject = await createSubject(database.sql, school.id);
  const room = await createRoom(database.sql, school.id);
  const courseA = await createCourse(database.sql, school.id, subject.id, {
    name: "Weighted Mathematics",
    creditHours: 3,
  });
  const courseB = await createCourse(database.sql, school.id, subject.id, {
    name: "General Science",
    creditHours: 1,
  });
  const classA = await createClass(database.sql, school.id, {
    courseId: courseA.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacher.id,
    roomId: room.id,
  });
  const classB = await createClass(database.sql, school.id, {
    courseId: courseB.id,
    academicYearId: year.id,
    termId: term.id,
    leadTeacherId: teacher.id,
    roomId: room.id,
  });

  await createEnrollment(database.sql, school.id, classA.id, student.id);
  await createEnrollment(database.sql, school.id, classB.id, student.id);

  const unpublishedClasses: { status: (typeof UNPUBLISHED_STATUSES)[number]; classId: string }[] =
    [];
  for (const status of UNPUBLISHED_STATUSES) {
    const course = await createCourse(database.sql, school.id, subject.id, {
      name: `Unpublished ${status}`,
    });
    const unpublishedClass = await createClass(database.sql, school.id, {
      courseId: course.id,
      academicYearId: year.id,
      termId: term.id,
      leadTeacherId: teacher.id,
      roomId: room.id,
    });
    await createEnrollment(database.sql, school.id, unpublishedClass.id, student.id);
    unpublishedClasses.push({ status, classId: unpublishedClass.id });
  }

  const schemeId = await asAdmin(database.sql, school.id, async (tx) => {
    const [scheme] = await tx<{ id: string }[]>`
      INSERT INTO app.grading_schemes
        (school_id, term_id, academic_year_id, version, name, scheme_type, created_by_user_id)
      VALUES (
        ${school.id}::uuid,
        ${term.id}::uuid,
        ${year.id}::uuid,
        1,
        'Four point scale',
        'gpa',
        ${admin.id}::uuid
      )
      RETURNING id
    `;
    const boundaries = [
      ["A", 90, 4],
      ["B", 80, 3],
      ["C", 70, 2],
      ["D", 60, 1],
      ["F", 0, 0],
    ] as const;
    for (const [position, boundary] of boundaries.entries()) {
      await tx`
        INSERT INTO app.grading_scheme_boundaries
          (school_id, grading_scheme_id, position, label, min_percentage, max_percentage, gpa_points)
        VALUES (
          ${school.id}::uuid,
          ${scheme!.id}::uuid,
          ${position},
          ${boundary[0]},
          ${boundary[1]},
          100,
          ${boundary[2]}
        )
      `;
    }
    await tx`
      INSERT INTO app.parent_child_links
        (school_id, parent_user_id, student_id, relationship)
      VALUES (${school.id}::uuid, ${parent.id}::uuid, ${student.id}::uuid, 'guardian')
    `;
    return scheme!.id;
  });

  await createPublishedSubmission({
    schoolId: school.id,
    classId: classA.id,
    studentId: student.id,
    submittedBy: teacher.userId,
    decidedBy: admin.id,
    schemeId,
    grades: [
      { label: "Quiz", score: 80, maxScore: 100, weight: 1 },
      { label: "Final", score: 100, maxScore: 100, weight: 3 },
      { label: "Unscored", score: null, maxScore: 100, weight: 10 },
    ],
  });
  await createPublishedSubmission({
    schoolId: school.id,
    classId: classB.id,
    studentId: student.id,
    submittedBy: teacher.userId,
    decidedBy: admin.id,
    schemeId,
    grades: [{ label: "Lab", score: 70, maxScore: 100, weight: 1 }],
  });
  for (const { status, classId } of unpublishedClasses) {
    await createPublishedSubmission({
      schoolId: school.id,
      classId,
      studentId: student.id,
      submittedBy: teacher.userId,
      decidedBy: admin.id,
      schemeId,
      grades: [{ label: unpublishedLabel(status), score: 99, maxScore: 100, weight: 1 }],
      status,
    });
  }

  // A second tenant with its own student, so the cross-tenant probe asks a real question: can a
  // school-B token read a school-A student that genuinely exists?
  const otherSchool = await createSchool(database.sql);
  const otherStudent = await createStudent(database.sql, otherSchool.id);

  fixture = {
    schoolId: school.id,
    studentId: student.id,
    studentUserId: student.userId,
    siblingId: sibling.id,
    parentUserId: parent.id,
    adminUserId: admin.id,
    termId: term.id,
    otherSchoolId: otherSchool.id,
    otherSchoolStudentUserId: otherStudent.userId,
  };

  testApp = createTestApp({ database: database.sql });
  await testApp.ready;
});

afterAll(async () => {
  testApp?.keyStore.destroy();
  await database?.cleanup();
});

describeDb("published grades read API", () => {
  test("returns only published scored rows with weighted term and GPA summaries", async () => {
    const response = await authenticatedRequest(
      testApp!,
      "GET",
      `/api/grades/published/students/${fixture.studentId}/terms/${fixture.termId}`,
      {
        schoolId: fixture.schoolId,
        userId: fixture.studentUserId,
        roles: [ROLES.STUDENT],
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grades: { label: string; grade_label: string; percentage: number }[];
      term_summary: {
        term_average_percentage: number;
        term_gpa: number;
        total_credits: number;
      };
      cumulative_summary: { cumulative_gpa: number; total_credits: number };
    };
    expect(body.grades.map((grade) => grade.label).sort()).toEqual(["Final", "Lab", "Quiz"]);
    expect(body.grades.find((grade) => grade.label === "Quiz")?.grade_label).toBe("B");
    expect(body.term_summary).toMatchObject({
      term_average_percentage: 88.75,
      term_gpa: 3.5,
      total_credits: 4,
    });
    expect(body.cumulative_summary).toMatchObject({
      cumulative_gpa: 3.5,
      total_credits: 4,
    });
  });

  test("hides every unpublished submission status from the student's own read", async () => {
    const response = await authenticatedRequest(
      testApp!,
      "GET",
      `/api/grades/published/students/${fixture.studentId}/terms/${fixture.termId}`,
      {
        schoolId: fixture.schoolId,
        userId: fixture.studentUserId,
        roles: [ROLES.STUDENT],
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      grades: { label: string }[];
      term_summary: { total_credits: number; term_average_percentage: number };
    };

    const labels = body.grades.map((grade) => grade.label);
    for (const status of UNPUBLISHED_STATUSES) {
      expect(labels).not.toContain(unpublishedLabel(status));
    }

    // The aggregates must exclude unpublished work too, not just the row list. Each unpublished
    // course carries the default 1 credit, so leaking any of the four would push total_credits past
    // the published 3 + 1 and drag the average toward the hidden 99%.
    expect(body.term_summary.total_credits).toBe(4);
    expect(body.term_summary.term_average_percentage).toBe(88.75);
  });

  test("denies a cross-tenant read of a student that exists in another school", async () => {
    const response = await authenticatedRequest(
      testApp!,
      "GET",
      `/api/grades/published/students/${fixture.studentId}/terms/${fixture.termId}`,
      {
        schoolId: fixture.otherSchoolId,
        userId: fixture.otherSchoolStudentUserId,
        roles: [ROLES.STUDENT],
      },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ACCESS_DENIED");
  });

  test("allows a linked parent and denies unrelated or staff probes with ACCESS_DENIED", async () => {
    const path = `/api/grades/published/students/${fixture.studentId}/terms/${fixture.termId}`;
    const linked = await authenticatedRequest(testApp!, "GET", path, {
      schoolId: fixture.schoolId,
      userId: fixture.parentUserId,
      roles: [ROLES.PARENT],
    });
    expect(linked.status).toBe(200);

    const unlinked = await authenticatedRequest(
      testApp!,
      "GET",
      `/api/grades/published/students/${fixture.siblingId}/terms/${fixture.termId}`,
      {
        schoolId: fixture.schoolId,
        userId: fixture.parentUserId,
        roles: [ROLES.PARENT],
      },
    );
    expect(unlinked.status).toBe(403);
    expect(((await unlinked.json()) as { code: string }).code).toBe("ACCESS_DENIED");

    const staff = await authenticatedRequest(testApp!, "GET", path, {
      schoolId: fixture.schoolId,
      userId: fixture.adminUserId,
      roles: [ROLES.ORG_ADMIN],
    });
    expect(staff.status).toBe(403);
    expect(((await staff.json()) as { code: string }).code).toBe("ACCESS_DENIED");
  });
});

test("grades.published subscriber invalidates the event's tenant and student", async () => {
  class FakeSubscriber extends EventEmitter {
    patterns: string[] = [];

    async psubscribe(pattern: string): Promise<number> {
      this.patterns.push(pattern);
      return 1;
    }

    async punsubscribe(): Promise<number> {
      return 0;
    }

    async quit(): Promise<"OK"> {
      return "OK";
    }
  }

  const subscriber = new FakeSubscriber();
  const evalCalls: unknown[][] = [];
  const redis = {
    duplicate: () => subscriber,
    eval: async (...args: unknown[]) => {
      evalCalls.push(args);
      return 2;
    },
  } as unknown as RedisClient;
  const handle = await startGradePublishedSubscriber({
    redis,
    logger: createLogger({ destination: () => undefined }),
  });

  const startedAt = performance.now();
  subscriber.emit(
    "pmessage",
    "events:*:grades.published",
    "events:11111111-1111-4111-8111-111111111111:grades.published",
    JSON.stringify({
      submissionId: "22222222-2222-4222-8222-222222222222",
      gradebookId: "33333333-3333-4333-8333-333333333333",
      studentId: "44444444-4444-4444-8444-444444444444",
      approvedByUserId: "55555555-5555-4555-8555-555555555555",
    }),
  );

  while (evalCalls.length === 0 && performance.now() - startedAt < 5_000) {
    await Bun.sleep(5);
  }

  expect(performance.now() - startedAt).toBeLessThan(5_000);
  expect(evalCalls).toHaveLength(1);
  expect(String(evalCalls[0]![2])).toContain(
    "sch:11111111-1111-4111-8111-111111111111:grades:published:" +
      "44444444-4444-4444-8444-444444444444:terms",
  );
  await handle.close();
});

redisIntegrationTest(
  "real Redis invalidation removes every affected term within five seconds and preserves others",
  async () => {
    const logger = createLogger({ destination: () => undefined });
    const redis = createRedisClient({ url: process.env.REDIS_URL!, logger });
    const schoolId = crypto.randomUUID();
    const studentId = crypto.randomUUID();
    const otherStudentId = crypto.randomUUID();
    const termA = crypto.randomUUID();
    const termB = crypto.randomUUID();
    const makeSnapshot = (owner: string, termId: string) => ({
      student_id: owner,
      term_id: termId,
      grades: [],
      term_summary: {
        term_average_percentage: null,
        term_gpa: null,
        total_credits: 0,
        calculated_at: null,
      },
      cumulative_summary: {
        cumulative_gpa: null,
        total_credits: 0,
        through_term_id: termId,
      },
    });

    const subscriber = await startGradePublishedSubscriber({ redis, logger });
    try {
      await setPublishedGradeCacheIfCurrent(
        redis,
        schoolId,
        studentId,
        termA,
        "0",
        makeSnapshot(studentId, termA),
      );
      await setPublishedGradeCacheIfCurrent(
        redis,
        schoolId,
        studentId,
        termB,
        "0",
        makeSnapshot(studentId, termB),
      );
      await setPublishedGradeCacheIfCurrent(
        redis,
        schoolId,
        otherStudentId,
        termA,
        "0",
        makeSnapshot(otherStudentId, termA),
      );

      const startedAt = performance.now();
      await redis.publish(
        `events:${schoolId}:grades.published`,
        JSON.stringify({
          submissionId: crypto.randomUUID(),
          gradebookId: crypto.randomUUID(),
          studentId,
          approvedByUserId: crypto.randomUUID(),
        }),
      );

      while (
        (await getPublishedGradeCache(redis, schoolId, studentId, termA)) !== null &&
        performance.now() - startedAt < 5_000
      ) {
        await Bun.sleep(10);
      }

      expect(performance.now() - startedAt).toBeLessThan(5_000);
      expect(await getPublishedGradeCache(redis, schoolId, studentId, termA)).toBeNull();
      expect(await getPublishedGradeCache(redis, schoolId, studentId, termB)).toBeNull();
      expect(await getPublishedGradeCache(redis, schoolId, otherStudentId, termA)).not.toBeNull();
    } finally {
      await subscriber.close();
      await redis.del(
        publishedGradeCacheKey(schoolId, otherStudentId, termA),
        cacheKey(schoolId, "grades", "published", otherStudentId, "terms"),
        cacheKey(schoolId, "grades", "published", otherStudentId, "revision"),
        cacheKey(schoolId, "grades", "published", studentId, "revision"),
      );
      await closeRedis(redis);
    }
  },
  10_000,
);
