/**
 * The teacher's student page: GET /api/academics/classes/{classId}/students/{studentId}/overview.
 *
 * Full HTTP path against a migrated database with RLS armed:
 *   - only a teacher of the class gets it: another class's teacher, the principal and the student
 *     get 403; a student who is not enrolled gets 404;
 *   - marks are the grading engine's live result for the class's subject, in the grade's result
 *     format; attendance counts only taken sessions of this class; homework is handed in /
 *     missing / upcoming; the subject's report-card comments are included;
 *   - school record fields come through the "teachers" audience only: a sensitive field (even one
 *     visible to parents), a staff-only field and a finance field are never in the response.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/academics/student-overview-http.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../src/modules/academics/section-service";
import {
  createSubjectConfig,
  setYearGradingStatus,
  upsertProgram,
} from "../../src/modules/grading/config-service";
import { getMarkSheet, saveMarks } from "../../src/modules/grading/marks-service";
import {
  saveStudentNotes,
  saveSubjectComments,
} from "../../src/modules/grading/report-card-service";
import {
  assignRole,
  authenticatedRequest,
  createClass,
  createFullTenant,
  createStudent,
  createTeacher,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { StudentOverview } from "../../src/modules/academics/student-overview-service";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;
const year = new Date().getFullYear();

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

interface Actor {
  schoolId: string;
  userId: string;
  roles: Role[];
  channel: "web";
}

const ids = {} as Record<string, string>;
const actors = {} as Record<"teacher" | "outsider" | "principal" | "student" | "admin", Actor>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  const created = createTestApp({ database: database.sql });
  await created.ready;
  harness = created;
  tenant = await createFullTenant(database.sql);
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

const actor = (userId: string, role: Role): Actor => ({
  schoolId: tenant.schoolId,
  userId,
  roles: [role],
  channel: "web",
});

const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(database!.sql, { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id }, fn);

async function asSystem(fn: (tx: TransactionSql) => Promise<unknown>) {
  await database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    await fn(tx);
  });
}

function call(who: Actor, method: string, path: string, body?: unknown) {
  return authenticatedRequest(harness!, method, path, who, {
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const overviewPath = (classId: string, studentId: string) =>
  `/api/academics/classes/${classId}/students/${studentId}/overview`;

async function seedAttendance(
  date: string,
  period: number,
  status: "present" | "absent" | "late" | "excused",
  sessionStatus: "submitted" | "draft" = "submitted",
) {
  await asSystem(async (tx) => {
    const [session] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id)
      VALUES (${tenant.schoolId}, ${tenant.cls.id}, ${date}::date, ${period},
              ${sessionStatus}::app.attendance_session_status, ${tenant.teachers[0]!.userId})
      RETURNING id, created_at
    `;
    await tx`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status, minutes_late,
         recorded_by_user_id)
      VALUES (${tenant.schoolId}, ${session!.id}, ${session!.created_at}, ${ids.student!},
              ${status}::app.attendance_status, ${status === "late" ? 7 : null},
              ${tenant.teachers[0]!.userId})
    `;
  });
}

async function seedAssignment(title: string, dueAt: Date, submission?: { score: number | null }) {
  await asSystem(async (tx) => {
    const teacherUser = tenant.teachers[0]!.userId;
    const [assignment] = await tx<{ id: string }[]>`
      INSERT INTO app.assignments
        (school_id, class_id, created_by_user_id, last_edited_by_user_id, title, status,
         assigned_at, due_at, max_score)
      VALUES (${tenant.schoolId}, ${tenant.cls.id}, ${teacherUser}, ${teacherUser}, ${title},
              'published', ${new Date(Date.now() - 30 * 86_400_000)}, ${dueAt}, 10)
      RETURNING id
    `;
    if (submission) {
      await tx`
        INSERT INTO app.assignment_submissions
          (school_id, assignment_id, student_id, last_edited_by_user_id, status, grade_status,
           submitted_at, score, graded_by_user_id, graded_at)
        VALUES (${tenant.schoolId}, ${assignment!.id}, ${ids.student!}, ${teacherUser},
                ${submission.score === null ? "submitted" : "graded"}::app.assignment_submission_status,
                ${submission.score === null ? "none" : "published"}::app.submission_grade_status,
                ${new Date()}, ${submission.score},
                ${submission.score === null ? null : teacherUser},
                ${submission.score === null ? null : new Date()})
      `;
    }
  });
}

async function addField(body: Record<string, unknown>): Promise<string> {
  const response = await call(actors.admin, "POST", "/api/record-templates/student/fields", {
    label_ar: "حقل",
    ...body,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describeDb("teacher's student overview", () => {
  test("setup: a section with a graded subject, attendance, homework, comments and records", async () => {
    const sql = database!.sql;
    ids.student = tenant.students[0]!.id;
    await assignRole(sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
    await assignRole(sql, tenant.schoolId, tenant.students[0]!.userId, ROLES.STUDENT);

    const outsider = await createTeacher(sql, tenant.schoolId);
    await assignRole(sql, tenant.schoolId, outsider.userId, ROLES.INSTRUCTOR);
    ids.otherClass = (
      await createClass(sql, tenant.schoolId, {
        courseId: tenant.course.id,
        academicYearId: tenant.academicYear.id,
        termId: tenant.term.id,
        leadTeacherId: outsider.id,
        roomId: tenant.room.id,
      })
    ).id;
    const principal = await createUser(sql, tenant.schoolId, {
      email: `principal-${crypto.randomUUID().slice(0, 8)}@test.local`,
    });
    await assignRole(sql, tenant.schoolId, principal.id, ROLES.PRINCIPAL);
    ids.notEnrolled = (
      await createStudent(sql, tenant.schoolId, { firstName: "Not", lastName: "Enrolled" })
    ).id;

    actors.teacher = actor(tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
    actors.outsider = actor(outsider.userId, ROLES.INSTRUCTOR);
    actors.principal = actor(principal.id, ROLES.PRINCIPAL);
    actors.student = actor(tenant.students[0]!.userId, ROLES.STUDENT);
    actors.admin = actor(tenant.users.ORG_ADMIN.id, ROLES.ORG_ADMIN);

    // Grading: grade 9 shows results out of 20; the class's subject has one final out of 100.
    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "Grade 9", sort_order: 9 });
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        mark_approval_required: false,
        result_format: "out_of",
        result_scale_max: 20,
      });
      await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: grade.id,
          sectionId: null,
          subjectId: tenant.subject.id,
        },
        {
          requirement: "mandatory",
          include_in_average: true,
          include_on_certificate: true,
          average_weight: 1,
          grading_method: "weighted",
          max_marks: 100,
          pass_percentage: 50,
          final_exam_pass_percentage: null,
          grade_scale_id: null,
          rounding_decimals: 2,
          rounding_mode: "half_up",
          missing_mark_policy: "incomplete",
          absent_policy: "incomplete",
          retake_policy: "none",
          retake_cap_percentage: null,
          teachers_can_add_assessments: false,
          teacher_assessments_require_approval: true,
          instructions: null,
          term_weights: [],
          categories: [
            {
              ref: "final",
              name: "Final",
              kind: "final_exam",
              scope: "annual",
              weight: 100,
              aggregation: "weighted_average",
              drop_lowest: 0,
              sort_order: 0,
            },
          ],
          assessments: [
            {
              category_ref: "final",
              term_id: null,
              name: "Final",
              max_marks: 100,
              weight: 1,
              is_mandatory: true,
              assessment_date: null,
              due_date: null,
              sort_order: 0,
            },
          ],
        },
      );
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "9A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.student!);
      await tx`UPDATE app.classes SET section_id = ${section.id}::uuid WHERE id = ${tenant.cls.id}::uuid`;
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });
    const sheet = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, tenant.subject.id),
    );
    await admin((tx) =>
      saveMarks(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, tenant.subject.id, [
        {
          assessment_id: sheet.assessments[0]!.id,
          student_id: ids.student!,
          attempt: 1,
          status: "graded",
          score: 85,
          remarks: null,
        },
      ]),
    );

    await seedAttendance(`${year}-02-02`, 1, "present");
    await seedAttendance(`${year}-02-03`, 1, "late");
    await seedAttendance(`${year}-02-04`, 1, "absent");
    await seedAttendance(`${year}-02-05`, 1, "absent", "draft");

    await seedAssignment("Done and graded", new Date(Date.now() - 5 * 86_400_000), { score: 9 });
    await seedAssignment("Never handed in", new Date(Date.now() - 2 * 86_400_000));
    await seedAssignment("Due next week", new Date(Date.now() + 7 * 86_400_000));

    await admin((tx) =>
      saveSubjectComments(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.section!,
        tenant.subject.id,
        tenant.term.id,
        [{ student_id: ids.student!, comment: "Strong on algebra." }],
      ),
    );
    await admin((tx) =>
      saveStudentNotes(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.section!,
        tenant.term.id,
        [{ student_id: ids.student!, teacher_comment: "A focused term." }],
      ),
    );

    const allergies = await addField({
      field_type: "long_text",
      label_en: "Allergies",
      visibility: "teachers",
    });
    const bus = await addField({
      field_type: "single_choice",
      label_en: "Bus route",
      visibility: "parent",
      options: [
        { value: "red", label_en: "Red", label_ar: "أحمر" },
        { value: "blue", label_en: "Blue", label_ar: "أزرق" },
      ],
    });
    const staffOnly = await addField({ field_type: "short_text", label_en: "Previous school" });
    const finance = await addField({
      field_type: "short_text",
      label_en: "Fee sponsor",
      visibility: "finance",
    });
    const nationalId = await addField({
      field_type: "short_text",
      label_en: "National ID number",
      sensitivity: "sensitive",
      visibility: "parent",
    });
    expect((await call(actors.admin, "POST", "/api/record-templates/student/publish")).status).toBe(
      201,
    );
    const filled = await call(actors.admin, "PUT", `/api/students/${ids.student}/records`, {
      answers: [
        { field_id: allergies, value: "Peanuts" },
        { field_id: bus, value: "red" },
        { field_id: staffOnly, value: "Al Noor Primary" },
        { field_id: finance, value: "Grandfather" },
        { field_id: nationalId, value: "P1234567-PASSPORT" },
      ],
    });
    expect(filled.status).toBe(200);
  });

  test("the class's teacher sees marks, attendance, homework, comments and teacher records", async () => {
    const response = await call(actors.teacher, "GET", overviewPath(tenant.cls.id, ids.student!));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as StudentOverview;

    expect(body.class.id).toBe(tenant.cls.id);
    expect(body.class.section_id).toBe(ids.section);
    expect(body.student.id).toBe(ids.student);

    expect(body.marks_unavailable).toBeNull();
    const marks = body.marks!;
    expect(marks.status).toBe("complete");
    expect(marks.percentage).toBe(85);
    expect(marks.result_format).toBe("out_of");
    expect(marks.result_scale_max).toBe(20);
    expect(marks.display_value).toBe(17);
    expect(marks.assessments).toHaveLength(1);
    expect(marks.assessments[0]!.score).toBe(85);

    // The draft session never counts.
    expect(body.attendance).toMatchObject({ sessions: 3, present: 1, late: 1, absent: 1 });
    expect(body.attendance.recent.map((r: { status: string }) => r.status)).toEqual([
      "absent",
      "late",
    ]);

    expect(body.homework).toMatchObject({ total: 3, handed_in: 1, missing: 1, upcoming: 1 });
    expect(
      body.homework.items.find((i: { title: string }) => i.title === "Done and graded"),
    ).toMatchObject({ status: "graded", score: 9 });

    expect(body.report_comments).toEqual({
      term_subject_comment: "Strong on algebra.",
      annual_subject_comment: null,
      term_teacher_comment: "A focused term.",
    });

    const records = body.records as { label_en: string; value_en: string; value_ar: string }[];
    expect(records.map((r) => r.label_en).sort()).toEqual(["Allergies", "Bus route"]);
    expect(records.find((r) => r.label_en === "Bus route")).toMatchObject({
      value_en: "Red",
      value_ar: "أحمر",
    });
    // Never a sensitive, staff-only or finance value -- not even masked.
    const raw = JSON.stringify(body);
    for (const secret of ["P1234567", "National ID", "Al Noor Primary", "Grandfather"]) {
      expect(raw).not.toContain(secret);
    }
  });

  test("a teacher of another class is refused", async () => {
    const response = await call(actors.outsider, "GET", overviewPath(tenant.cls.id, ids.student!));
    expect(response.status).toBe(403);
  });

  test("the principal and the student themselves are refused: this is the teaching view", async () => {
    expect(
      (await call(actors.principal, "GET", overviewPath(tenant.cls.id, ids.student!))).status,
    ).toBe(403);
    expect(
      (await call(actors.student, "GET", overviewPath(tenant.cls.id, ids.student!))).status,
    ).toBe(403);
  });

  test("a student who is not enrolled in the class is not found", async () => {
    const response = await call(
      actors.teacher,
      "GET",
      overviewPath(tenant.cls.id, ids.notEnrolled!),
    );
    expect(response.status).toBe(404);
  });

  test("the other class's teacher cannot reach this student through their own class", async () => {
    const response = await call(
      actors.outsider,
      "GET",
      overviewPath(ids.otherClass!, ids.student!),
    );
    expect(response.status).toBe(404);
  });
});
