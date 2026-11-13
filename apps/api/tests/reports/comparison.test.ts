/**
 * Child comparison report HTTP tests (ST-177).
 *
 * Exercises the two parent-facing report endpoints against a seeded tenant with two linked
 * children: grade snapshots/trends (from app.student_term_summaries), attendance totals (from the
 * shared attendance-reporting package), and per-child assignment completion. Attendance timestamps
 * are pinned to a partition that always exists (the fixed 2026-06..2027-01 range created by
 * 000012) while session dates stay inside the fixture term window, so the suite is deterministic
 * regardless of when it runs.
 *
 * Requires a live PostgreSQL instance and is gated on TEST_DATABASE_URL like every other
 * integration suite.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/reports/comparison.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  assignRole,
  authenticatedRequest,
  createEnrollment,
  createFullTenant,
  createStudent,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StudentRecord, TenantFixture, TestApp, TestDatabase } from "../harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

const PRIMARY_ATTENDANCE = {
  total_records: 3,
  present_count: 1,
  absent_count: 1,
  late_count: 1,
  excused_count: 0,
  present_percent: 33.33,
  absent_percent: 33.33,
  late_percent: 33.33,
  excused_percent: 0,
};

const SECONDARY_ATTENDANCE = {
  total_records: 3,
  present_count: 2,
  absent_count: 1,
  late_count: 0,
  excused_count: 0,
  present_percent: 66.67,
  absent_percent: 33.33,
  late_percent: 0,
  excused_percent: 0,
};

const PRIMARY_GRADE = { term_average_percentage: 85, term_gpa: 3.75, total_credits: 3 };
const SECONDARY_GRADE = { term_average_percentage: 70, term_gpa: 2.5, total_credits: 3 };

const PRIMARY_ASSIGNMENTS = {
  total: 3,
  submitted: 3,
  on_time: 2,
  late: 1,
  completion_percent: 100,
};
const SECONDARY_ASSIGNMENTS = {
  total: 3,
  submitted: 2,
  on_time: 2,
  late: 0,
  completion_percent: 66.67,
};

interface AttendanceMetrics {
  total_records: number;
  present_count: number;
  absent_count: number;
  late_count: number;
  excused_count: number;
  present_percent: number;
  absent_percent: number;
  late_percent: number;
  excused_percent: number;
}

interface ComparisonItem {
  student_id: string;
  student_name: string;
  admission_number: string;
  grade: { term_average_percentage: number | null; term_gpa: number | null; total_credits: number };
  grade_trend: {
    term_id: string;
    term_name: string;
    term_average_percentage: number | null;
    term_gpa: number | null;
  }[];
  attendance: AttendanceMetrics;
  assignments: {
    total: number;
    submitted: number;
    on_time: number;
    late: number;
    completion_percent: number;
  };
}

interface ComparisonResponse {
  generated_at: string;
  period: { term_id: string; start_date: string; end_date: string };
  children: ComparisonItem[];
}

interface BreakdownResponse {
  generated_at: string;
  period: { term_id: string; start_date: string; end_date: string };
  student: { student_id: string; student_name: string; admission_number: string };
  grade_trend: ComparisonItem["grade_trend"];
  grade: {
    grades: {
      label: string;
      score: number | null;
      max_score: number;
      weight: number;
      percentage: number | null;
      grade_label: string | null;
      gpa_points: number | null;
    }[];
    term_summary: {
      term_average_percentage: number | null;
      term_gpa: number | null;
      total_credits: number;
      calculated_at: string | null;
    };
  };
  attendance: {
    totals: AttendanceMetrics;
    trends: (AttendanceMetrics & { bucket_start: string })[];
  };
  assignments: ComparisonItem["assignments"];
}

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let fixture: TenantFixture | undefined;
let secondStudent: StudentRecord | undefined;
let unlinkedStudent: StudentRecord | undefined;
const year = new Date().getUTCFullYear();

async function asAdmin<T>(schoolId: string, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    result = await run(tx);
  });
  return result as T;
}

async function linkChildren(children: readonly { id: string }[]): Promise<void> {
  await asAdmin(fixture!.schoolId, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (
        ${fixture!.schoolId}::uuid,
        'Comparison test family',
        ${fixture!.users.PARENT.id}::uuid
      )
      RETURNING id
    `;
    for (const child of children) {
      await tx`
        INSERT INTO app.parent_child_links
          (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (
          ${fixture!.schoolId}::uuid,
          ${family!.id}::uuid,
          ${fixture!.users.PARENT.id}::uuid,
          ${child.id}::uuid,
          'father'
        )
      `;
    }
  });
}

async function seedGrades(): Promise<void> {
  const teacherUserId = fixture!.teachers[0]!.userId;
  const adminUserId = fixture!.users.ORG_ADMIN.id;

  await asAdmin(fixture!.schoolId, async (tx) => {
    const children = [
      {
        studentId: fixture!.students[0]!.id,
        gpa: 3.75,
        average: 85,
        grades: [
          { label: "Midterm", score: 85, maxScore: 100, weight: 1 },
          { label: "Homework", score: 18, maxScore: 20, weight: 0.5 },
        ],
      },
      {
        studentId: secondStudent!.id,
        gpa: 2.5,
        average: 70,
        grades: [
          { label: "Midterm", score: 70, maxScore: 100, weight: 1 },
          { label: "Homework", score: 14, maxScore: 20, weight: 0.5 },
        ],
      },
    ];

    const [gradebook] = await tx<{ id: string }[]>`
      INSERT INTO app.gradebooks (school_id, class_id, status)
      VALUES (${fixture!.schoolId}::uuid, ${fixture!.cls.id}::uuid, 'active')
      RETURNING id
    `;

    for (const child of children) {
      const [submission] = await tx<{ id: string }[]>`
        INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id)
        VALUES (${fixture!.schoolId}::uuid, ${gradebook!.id}::uuid, ${child.studentId}::uuid)
        RETURNING id
      `;
      await tx`
        UPDATE app.grade_submissions
        SET status = 'submitted', submitted_by_user_id = ${teacherUserId}::uuid
        WHERE id = ${submission!.id}::uuid
      `;
      await tx`
        UPDATE app.grade_submissions
        SET status = 'approved', decided_by_user_id = ${adminUserId}::uuid
        WHERE id = ${submission!.id}::uuid
      `;
      await tx`
        UPDATE app.grade_submissions
        SET status = 'published'
        WHERE id = ${submission!.id}::uuid
      `;
      for (const grade of child.grades) {
        await tx`
          INSERT INTO app.grades
            (school_id, grade_submission_id, label, score, max_score, weight)
          VALUES (
            ${fixture!.schoolId}::uuid,
            ${submission!.id}::uuid,
            ${grade.label},
            ${grade.score}::numeric,
            ${grade.maxScore}::numeric,
            ${grade.weight}::numeric
          )
        `;
      }
      await tx`
        SELECT app.upsert_student_term_summary(
          ${fixture!.schoolId}::uuid,
          ${child.studentId}::uuid,
          ${fixture!.term.id}::uuid,
          ${fixture!.academicYear.id}::uuid,
          ${child.gpa}::numeric,
          ${child.average}::numeric,
          3::numeric
        )
      `;
    }
  });
}

async function seedAttendance(): Promise<void> {
  const teacherUserId = fixture!.teachers[0]!.userId;

  const sessions: {
    sessionDate: string;
    pinnedCreatedAt: string;
    sessionStatus: "submitted" | "locked";
    records: {
      studentId: string;
      status: "present" | "absent" | "late";
      minutesLate?: number;
    }[];
  }[] = [
    {
      sessionDate: `${year}-01-06`,
      pinnedCreatedAt: "2026-06-15 08:00:00+00",
      sessionStatus: "submitted",
      records: [
        { studentId: fixture!.students[0]!.id, status: "present" },
        { studentId: secondStudent!.id, status: "absent" },
      ],
    },
    {
      sessionDate: `${year}-01-07`,
      pinnedCreatedAt: "2026-06-16 08:00:00+00",
      sessionStatus: "locked",
      records: [
        { studentId: fixture!.students[0]!.id, status: "late", minutesLate: 5 },
        { studentId: secondStudent!.id, status: "present" },
      ],
    },
    {
      sessionDate: `${year}-01-08`,
      pinnedCreatedAt: "2026-06-17 08:00:00+00",
      sessionStatus: "submitted",
      records: [
        { studentId: fixture!.students[0]!.id, status: "absent" },
        { studentId: secondStudent!.id, status: "present" },
      ],
    },
  ];

  await asAdmin(fixture!.schoolId, async (tx) => {
    for (const session of sessions) {
      const [row] = await tx<{ id: string; created_at: Date }[]>`
        INSERT INTO app.attendance_sessions
          (school_id, class_id, session_date, status, taken_by_user_id, created_at, updated_at)
        VALUES (
          ${fixture!.schoolId}::uuid,
          ${fixture!.cls.id}::uuid,
          ${session.sessionDate}::date,
          ${session.sessionStatus}::app.attendance_session_status,
          ${teacherUserId}::uuid,
          ${session.pinnedCreatedAt}::timestamptz(3),
          ${session.pinnedCreatedAt}::timestamptz(3)
        )
        RETURNING id, created_at
      `;
      for (const record of session.records) {
        await tx`
          INSERT INTO app.attendance_records
            (school_id, attendance_session_id, session_created_at, student_id, status,
             minutes_late, recorded_by_user_id, created_at, updated_at)
          VALUES (
            ${fixture!.schoolId}::uuid,
            ${row!.id}::uuid,
            ${row!.created_at},
            ${record.studentId}::uuid,
            ${record.status}::app.attendance_status,
            ${record.minutesLate ?? null},
            ${teacherUserId}::uuid,
            ${row!.created_at},
            ${row!.created_at}
          )
        `;
      }
    }
  });
}

async function seedAssignments(): Promise<void> {
  const teacherUserId = fixture!.teachers[0]!.userId;
  const primary = fixture!.students[0]!;
  const primaryUserId = primary.userId;
  const second = secondStudent!;
  const secondUserId = second.userId;

  await asAdmin(fixture!.schoolId, async (tx) => {
    const insertAssignment = async (title: string): Promise<string> => {
      const [assignment] = await tx<{ id: string }[]>`
        INSERT INTO app.assignments
          (school_id, class_id, created_by_user_id, last_edited_by_user_id,
           title, status, available_from, assigned_at, due_at, max_score)
        VALUES (
          ${fixture!.schoolId}::uuid,
          ${fixture!.cls.id}::uuid,
          ${teacherUserId}::uuid,
          ${teacherUserId}::uuid,
          ${title},
          'published'::app.assignment_status,
          '2026-06-01 09:00:00+00'::timestamptz,
          '2026-06-02 09:00:00+00'::timestamptz,
          '2026-06-30 17:00:00+00'::timestamptz,
          100::numeric
        )
        RETURNING id
      `;
      return assignment!.id;
    };

    const termPaper = await insertAssignment("Term Paper");
    await tx`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at, is_late)
      VALUES
        (${fixture!.schoolId}::uuid, ${termPaper}::uuid, ${primary.id}::uuid, ${primaryUserId}::uuid, 'submitted'::app.assignment_submission_status, '2026-06-10 10:00:00+00'::timestamptz, false),
        (${fixture!.schoolId}::uuid, ${termPaper}::uuid, ${second.id}::uuid, ${secondUserId}::uuid, 'submitted'::app.assignment_submission_status, '2026-06-10 10:00:00+00'::timestamptz, false)
    `;

    const project = await insertAssignment("Group Project");
    await tx`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at, is_late)
      VALUES (
        ${fixture!.schoolId}::uuid, ${project}::uuid, ${primary.id}::uuid, ${primaryUserId}::uuid,
        'submitted'::app.assignment_submission_status, '2026-06-20 10:00:00+00'::timestamptz, true
      )
    `;

    const homework = await insertAssignment("Homework Set");
    await tx`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at,
         is_late, grade_status, graded_at, graded_by_user_id, score)
      VALUES (
        ${fixture!.schoolId}::uuid, ${homework}::uuid, ${primary.id}::uuid, ${primaryUserId}::uuid,
        'graded'::app.assignment_submission_status, '2026-06-12 10:00:00+00'::timestamptz, false,
        'published'::app.submission_grade_status, '2026-06-15 10:00:00+00'::timestamptz,
        ${teacherUserId}::uuid, 92::numeric
      )
    `;
    await tx`
      INSERT INTO app.assignment_submissions
        (school_id, assignment_id, student_id, last_edited_by_user_id, status, submitted_at, is_late)
      VALUES (
        ${fixture!.schoolId}::uuid, ${homework}::uuid, ${second.id}::uuid, ${secondUserId}::uuid,
        'submitted'::app.assignment_submission_status, '2026-06-12 10:00:00+00'::timestamptz, false
      )
    `;
  });
}

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  fixture = await createFullTenant(database.sql);

  secondStudent = await createStudent(database.sql, fixture.schoolId, {
    firstName: "Secondary",
    lastName: "TestStudent",
  });
  await createEnrollment(database.sql, fixture.schoolId, fixture.cls.id, secondStudent.id);
  unlinkedStudent = await createStudent(database.sql, fixture.schoolId, {
    firstName: "Unrelated",
    lastName: "TestStudent",
  });

  await linkChildren([fixture.students[0], secondStudent]);
  await seedGrades();
  await seedAttendance();
  await seedAssignments();

  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

function childById(children: ComparisonItem[], studentId: string): ComparisonItem {
  const child = children.find((entry) => entry.student_id === studentId);
  expect(child, `child ${studentId} present in response`).toBeDefined();
  return child!;
}

describeDb("parent child comparison report HTTP API", () => {
  test("comparison returns grade, attendance, and assignment metrics for every linked child", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/comparison?term_id=${fixture!.term.id}`,
      {
        schoolId: fixture!.schoolId,
        userId: fixture!.users.PARENT.id,
        roles: [ROLES.PARENT],
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ComparisonResponse;

    expect(body.period).toEqual({
      term_id: fixture!.term.id,
      start_date: `${year}-01-01`,
      end_date: `${year}-06-30`,
    });
    expect(body.children).toHaveLength(2);

    const primary = childById(body.children, fixture!.students[0]!.id);
    expect(primary.student_name).toBe("Primary TestStudent");
    expect(primary.admission_number).toBe(fixture!.students[0]!.admissionNumber);
    expect(primary.grade).toEqual(PRIMARY_GRADE);
    expect(primary.grade_trend).toEqual([
      {
        term_id: fixture!.term.id,
        term_name: `Term T1-${fixture!.schoolSlug}`,
        term_average_percentage: 85,
        term_gpa: 3.75,
      },
    ]);
    expect(primary.attendance).toEqual(PRIMARY_ATTENDANCE);
    expect(primary.assignments).toEqual(PRIMARY_ASSIGNMENTS);

    const secondary = childById(body.children, secondStudent!.id);
    expect(secondary.student_name).toBe("Secondary TestStudent");
    expect(secondary.grade).toEqual(SECONDARY_GRADE);
    expect(secondary.grade_trend).toEqual([
      {
        term_id: fixture!.term.id,
        term_name: `Term T1-${fixture!.schoolSlug}`,
        term_average_percentage: 70,
        term_gpa: 2.5,
      },
    ]);
    expect(secondary.attendance).toEqual(SECONDARY_ATTENDANCE);
    expect(secondary.assignments).toEqual(SECONDARY_ASSIGNMENTS);
  });

  test("breakdown returns published grades, trend, attendance, and completion for a linked child", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/${fixture!.students[0]!.id}/breakdown?term_id=${fixture!.term.id}`,
      {
        schoolId: fixture!.schoolId,
        userId: fixture!.users.PARENT.id,
        roles: [ROLES.PARENT],
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as BreakdownResponse;

    expect(body.student).toEqual({
      student_id: fixture!.students[0]!.id,
      student_name: "Primary TestStudent",
      admission_number: fixture!.students[0]!.admissionNumber,
    });
    expect(body.grade_trend).toHaveLength(1);
    expect(body.grade_trend[0]!.term_average_percentage).toBe(85);
    expect(body.grade_trend[0]!.term_gpa).toBe(3.75);

    expect(body.grade.grades.map((grade) => grade.label)).toEqual(["Homework", "Midterm"]);
    expect(body.grade.grades.map((grade) => grade.percentage)).toEqual([90, 85]);
    expect(body.grade.grades.map((grade) => grade.grade_label)).toEqual(["A", "B"]);
    expect(body.grade.grades.map((grade) => grade.gpa_points)).toEqual([4, 3]);
    expect(body.grade.term_summary).toMatchObject({
      term_average_percentage: 85,
      term_gpa: 3.75,
      total_credits: 3,
    });
    expect(typeof body.grade.term_summary.calculated_at).toBe("string");

    expect(body.attendance.totals).toEqual(PRIMARY_ATTENDANCE);
    expect(body.attendance.trends.length).toBeGreaterThanOrEqual(1);
    expect(body.attendance.trends[0]).toMatchObject(PRIMARY_ATTENDANCE);
    expect(body.assignments).toEqual(PRIMARY_ASSIGNMENTS);
  });

  test("a parent with no linked children gets an empty comparison", async () => {
    const parentless = await createUser(database!.sql, fixture!.schoolId, {
      displayName: "Childless Parent",
    });
    await assignRole(database!.sql, fixture!.schoolId, parentless.id, ROLES.PARENT);

    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/comparison?term_id=${fixture!.term.id}`,
      {
        schoolId: fixture!.schoolId,
        userId: parentless.id,
        roles: [ROLES.PARENT],
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ComparisonResponse;
    expect(body.children).toEqual([]);
  });

  test("denies a staff role that holds GRADE_READ but is not a parent", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/comparison?term_id=${fixture!.term.id}`,
      {
        schoolId: fixture!.schoolId,
        userId: fixture!.users.ORG_ADMIN.id,
        roles: [ROLES.ORG_ADMIN],
      },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.ACCESS_DENIED);
  });

  test("denies a breakdown for a child not linked to the calling parent", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/${unlinkedStudent!.id}/breakdown?term_id=${fixture!.term.id}`,
      {
        schoolId: fixture!.schoolId,
        userId: fixture!.users.PARENT.id,
        roles: [ROLES.PARENT],
      },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.ACCESS_DENIED);
  });

  test("returns 404 for an unknown term", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      `/api/reports/children/comparison?term_id=${crypto.randomUUID()}`,
      {
        schoolId: fixture!.schoolId,
        userId: fixture!.users.PARENT.id,
        roles: [ROLES.PARENT],
      },
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe(
      ERROR_CODES.ATTENDANCE_REPORT_RESOURCE_NOT_FOUND,
    );
  });

  test("rejects a malformed term_id", async () => {
    const response = await authenticatedRequest(
      harness!,
      "GET",
      "/api/reports/children/comparison?term_id=not-a-uuid",
      {
        schoolId: fixture!.schoolId,
        userId: fixture!.users.PARENT.id,
        roles: [ROLES.PARENT],
      },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});
