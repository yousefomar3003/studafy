/**
 * Subject coordinators (000260) end to end, against a real migrated database with RLS armed:
 * leadership assigns them, a coordinator reads every covered section's marks, mark sheets,
 * predicted grades and subject results read-only, the grade levels limit it, a coordinator of
 * another subject sees nothing, and another school reaches nothing. Later tests build on earlier
 * ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/subject-coordinators.integration.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
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
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../academics/section-service";
import { assertCoordinatesSubject, coordinatedSubjects, coordinatesSubject } from "../access";
import {
  createScale,
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import { saveMarks } from "../marks-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let otherTenant: TenantFixture;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  otherTenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  const created = createTestApp({ database: db.sql });
  await created.ready;
  harness = created;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  if (client) await client.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const as = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId }, fn);
const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.users.ORG_ADMIN.id, fn);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    return String((error as { code?: string }).code ?? error);
  }
  return "RESOLVED";
}

async function call(method: string, path: string, auth: TestAuthContext, body?: unknown) {
  const response = await authenticatedRequest(
    harness!,
    method,
    path,
    auth,
    body === undefined
      ? undefined
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  };
}

const authOf = (userId: string, role: keyof typeof ROLES, schoolId = tenant.schoolId) =>
  ({ schoolId, userId, roles: [ROLES[role]] }) as TestAuthContext;

/** A subject with one annual final exam out of 100. */
const CONFIG: SubjectConfigInput = {
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
  teachers_can_add_assessments: true,
  teacher_assessments_require_approval: false,
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
} as SubjectConfigInput;

const sheetPath = (section: string, subject: string) =>
  `/api/grading/sections/${ids[section]}/subjects/${ids[subject]}/marks`;
const predictionsPath = (section: string, subject: string) =>
  `/api/grading/sections/${ids[section]}/subjects/${ids[subject]}/predicted-grades`;
const coordinatorsPath = () => `/api/grading/years/${tenant.academicYear.id}/subject-coordinators`;

async function finalAssessment(subject: string, grade: string): Promise<string> {
  const [row] = await db.sql<{ id: string }[]>`
    SELECT assessment.id FROM app.subject_config_assessments AS assessment
    JOIN app.subject_configs AS config ON config.id = assessment.subject_config_id
    WHERE config.subject_id = ${ids[subject]!}::uuid AND config.grade_level_id = ${ids[grade]!}::uuid
      AND config.section_id IS NULL
  `;
  return row!.id;
}

describeDb("subject coordinators", () => {
  test("setup: grades 10 and 11, math in both, science in 10, a student per section", async () => {
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MTH", name: "Math" })).id;
    ids.science = (
      await createSubject(db.sql, tenant.schoolId, { code: "SCI", name: "Science" })
    ).id;
    const teacherA = tenant.teachers[0]!;
    const teacherB = await createTeacher(db.sql, tenant.schoolId);
    const coordinator = await createTeacher(db.sql, tenant.schoolId);
    const scienceCoordinator = await createTeacher(db.sql, tenant.schoolId);
    for (const teacher of [teacherA, teacherB, coordinator, scienceCoordinator]) {
      await assignRole(db.sql, tenant.schoolId, teacher.userId, ROLES.INSTRUCTOR);
    }
    ids.teacherA = teacherA.userId;
    ids.teacherB = teacherB.userId;
    ids.coordinator = coordinator.userId;
    ids.scienceCoordinator = scienceCoordinator.userId;
    ids.s10a = tenant.students[0]!.id;
    ids.s10b = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Badr", lastName: "B" })
    ).id;
    ids.s11a = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Cala", lastName: "C" })
    ).id;

    await admin(async (tx) => {
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Percent",
        bands: [
          { label: "A", min_percentage: 80, gpa_points: null },
          { label: "B", min_percentage: 60, gpa_points: null },
          { label: "F", min_percentage: 0, gpa_points: null },
        ],
      });
      for (const [key, name, order] of [
        ["g10", "Grade 10", 10],
        ["g11", "Grade 11", 11],
      ] as const) {
        const grade = await createGradeLevel(tx, tenant.schoolId, { name, sort_order: order });
        ids[key] = grade.id;
        await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
          grade_scale_id: scale.id,
          mark_approval_required: false,
          predicted_grades_enabled: true,
        });
      }
      const configure = (grade: string, subject: string) =>
        createSubjectConfig(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          {
            yearId: tenant.academicYear.id,
            gradeLevelId: ids[grade]!,
            sectionId: null,
            subjectId: ids[subject]!,
          },
          CONFIG,
        );
      await configure("g10", "math");
      await configure("g11", "math");
      await configure("g10", "science");
      for (const [key, grade, student, teacher] of [
        ["sec10a", "g10", "s10a", teacherA.id],
        ["sec10b", "g10", "s10b", teacherB.id],
        ["sec11a", "g11", "s11a", teacherA.id],
      ] as const) {
        const section = await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: ids[grade]!,
          name: key.slice(3).toUpperCase(),
        });
        ids[key] = section.id;
        await placeStudentInSection(tx, tenant.schoolId, section.id, ids[student]!);
        await createTeacherAssignment(tx, tenant.schoolId, {
          section_id: section.id,
          subject_id: ids.math!,
          teacher_id: teacher,
        });
      }
      await createTeacherAssignment(tx, tenant.schoolId, {
        section_id: ids.sec10b!,
        subject_id: ids.science!,
        teacher_id: teacherB.id,
      });
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });

    // Each section's teacher records its math final; 10B's teacher records science too.
    ids.math10 = await finalAssessment("math", "g10");
    ids.math11 = await finalAssessment("math", "g11");
    ids.science10 = await finalAssessment("science", "g10");
    const mark = (assessment: string, student: string, score: number) => ({
      assessment_id: ids[assessment]!,
      student_id: ids[student]!,
      attempt: 1 as const,
      status: "graded" as const,
      score,
      remarks: null,
    });
    await as(ids.teacherA!, (tx) =>
      saveMarks(tx, tenant.schoolId, ids.teacherA!, ids.sec10a!, ids.math!, [
        mark("math10", "s10a", 90),
      ]),
    );
    await as(ids.teacherB!, (tx) =>
      saveMarks(tx, tenant.schoolId, ids.teacherB!, ids.sec10b!, ids.math!, [
        mark("math10", "s10b", 70),
      ]),
    );
    await as(ids.teacherB!, (tx) =>
      saveMarks(tx, tenant.schoolId, ids.teacherB!, ids.sec10b!, ids.science!, [
        mark("science10", "s10b", 40),
      ]),
    );
    await as(ids.teacherA!, (tx) =>
      saveMarks(tx, tenant.schoolId, ids.teacherA!, ids.sec11a!, ids.math!, [
        mark("math11", "s11a", 55),
      ]),
    );
  });

  test("before any assignment, a teacher of neither section reads nothing", async () => {
    const auth = authOf(ids.coordinator!, "INSTRUCTOR");
    expect((await call("GET", sheetPath("sec10b", "math"), auth)).status).toBe(403);
    const marks = await as(ids.coordinator!, (tx) => tx`SELECT id FROM app.student_marks`);
    expect(marks.length).toBe(0);
    const overview = await call("GET", "/api/grading/my-coordinated-subjects", auth);
    expect(overview.status).toBe(200);
    expect(overview.body).toEqual({ academic_year_id: tenant.academicYear.id, subjects: [] });
  });

  test("leadership assigns coordinators; repeats, non-staff and teachers are refused", async () => {
    const leader = authOf(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
    const created = await call("POST", coordinatorsPath(), leader, {
      subject_id: ids.math,
      user_id: ids.coordinator,
      grade_level_ids: [ids.g10, ids.g10],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      academic_year_id: tenant.academicYear.id,
      subject_id: ids.math,
      subject_name: "Math",
      user_id: ids.coordinator,
      grade_levels: [{ id: ids.g10, name: "Grade 10" }],
    });
    ids.mathCoordinator = created.body.id as string;

    const science = await call("POST", coordinatorsPath(), leader, {
      subject_id: ids.science,
      user_id: ids.scienceCoordinator,
      grade_level_ids: [],
    });
    expect(science.status).toBe(201);
    expect(science.body.grade_levels).toEqual([]);

    const repeat = await call("POST", coordinatorsPath(), leader, {
      subject_id: ids.math,
      user_id: ids.coordinator,
      grade_level_ids: [],
    });
    expect(repeat.status).toBe(409);
    expect((repeat.body.error as { code: string } | undefined)?.code ?? repeat.body.code).toBe(
      ERROR_CODES.SUBJECT_COORDINATOR_DUPLICATE,
    );

    // A student is not staff; an unknown grade level is not the school's.
    const studentUser = tenant.users.STUDENT.id;
    expect(
      (
        await call("POST", coordinatorsPath(), leader, {
          subject_id: ids.math,
          user_id: studentUser,
          grade_level_ids: [],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", coordinatorsPath(), leader, {
          subject_id: ids.math,
          user_id: ids.teacherA,
          grade_level_ids: [otherTenant.schoolId],
        })
      ).status,
    ).toBe(404);

    // Teachers read the list (configuration) but cannot assign.
    const teacher = authOf(ids.teacherA!, "INSTRUCTOR");
    expect(
      (
        await call("POST", coordinatorsPath(), teacher, {
          subject_id: ids.math,
          user_id: ids.teacherA,
          grade_level_ids: [],
        })
      ).status,
    ).toBe(403);
    const list = await call("GET", coordinatorsPath(), leader);
    expect(list.status).toBe(200);
    expect(
      (list.body.coordinators as { subject_name: string }[]).map((row) => row.subject_name),
    ).toEqual(["Math", "Science"]);

    const audit = await db.sql<{ action: string }[]>`
      SELECT action FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'subject_coordinators'
    `;
    expect(audit.length).toBe(2);
  });

  test("the helpers batch 2 relies on", async () => {
    const year = tenant.academicYear.id;
    const subjects = await as(ids.coordinator!, (tx) =>
      coordinatedSubjects(tx, ids.coordinator!, year),
    );
    expect(subjects).toEqual([
      {
        coordinator_id: ids.mathCoordinator!,
        subject_id: ids.math!,
        subject_code: "MTH",
        subject_name: "Math",
        grade_level_ids: [ids.g10!],
      },
    ]);
    expect(await as(ids.coordinator!, (tx) => coordinatesSubject(tx, ids.math!, year))).toBe(true);
    expect(
      await as(ids.coordinator!, (tx) => coordinatesSubject(tx, ids.math!, year, ids.sec10b!)),
    ).toBe(true);
    // Grade 11 is not covered; science is not theirs.
    expect(
      await as(ids.coordinator!, (tx) => coordinatesSubject(tx, ids.math!, year, ids.sec11a!)),
    ).toBe(false);
    expect(await as(ids.coordinator!, (tx) => coordinatesSubject(tx, ids.science!, year))).toBe(
      false,
    );
    expect(
      await codeOf(as(ids.coordinator!, (tx) => assertCoordinatesSubject(tx, ids.science!, year))),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect(
      await as(ids.coordinator!, (tx) => assertCoordinatesSubject(tx, ids.math!, year)),
    ).toEqual({ leadership: false });
    expect(await admin((tx) => assertCoordinatesSubject(tx, ids.science!, year))).toEqual({
      leadership: true,
    });
    expect(
      await codeOf(
        as(ids.teacherA!, (tx) => assertCoordinatesSubject(tx, ids.math!, year, ids.sec10a!)),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
  });

  test("a coordinator reads every covered section's mark sheet, read-only", async () => {
    const auth = authOf(ids.coordinator!, "INSTRUCTOR");
    for (const [section, student, score] of [
      ["sec10a", "s10a", 90],
      ["sec10b", "s10b", 70],
    ] as const) {
      const sheet = await call("GET", sheetPath(section, "math"), auth);
      expect(sheet.status).toBe(200);
      expect(sheet.body).toMatchObject({
        access: "coordinator",
        can_edit_marks: false,
        can_add_assessments: false,
      });
      const students = sheet.body.students as {
        student_id: string;
        marks: { score: number | null }[];
      }[];
      expect(students.map((s) => s.student_id)).toEqual([ids[student]]);
      expect(students[0]!.marks.map((m) => m.score)).toEqual([score]);
    }
    // The teacher's own view is unchanged.
    const own = await call("GET", sheetPath("sec10b", "math"), authOf(ids.teacherB!, "INSTRUCTOR"));
    expect(own.body).toMatchObject({ access: "teacher", can_edit_marks: true });

    // Writing stays with the teachers and leadership.
    const put = await call("PUT", sheetPath("sec10b", "math"), auth, {
      entries: [
        {
          assessment_id: ids.math10,
          student_id: ids.s10b,
          attempt: 1,
          status: "graded",
          score: 10,
          remarks: null,
        },
      ],
    });
    expect(put.status).toBe(403);
    expect(
      (
        await call(
          "POST",
          `/api/grading/sections/${ids.sec10b}/subjects/${ids.math}/mark-sheets/submit`,
          auth,
          { term_id: null },
        )
      ).status,
    ).toBe(403);

    // Grade 11 is outside the assignment; science is another subject.
    expect((await call("GET", sheetPath("sec11a", "math"), auth)).status).toBe(403);
    expect((await call("GET", sheetPath("sec10b", "science"), auth)).status).toBe(403);

    // RLS: exactly the covered sections' math marks, and only their students.
    const marks = await as(
      ids.coordinator!,
      (tx) =>
        tx<{ student_id: string; assessment_id: string }[]>`
        SELECT student_id, assessment_id FROM app.student_marks ORDER BY score
      `,
    );
    expect(marks.map((m) => [m.student_id, m.assessment_id])).toEqual([
      [ids.s10b, ids.math10],
      [ids.s10a, ids.math10],
    ]);
    const students = await as(
      ids.coordinator!,
      (tx) => tx<{ id: string }[]>`SELECT id FROM app.students`,
    );
    expect(new Set(students.map((s) => s.id))).toEqual(new Set([ids.s10a, ids.s10b]));
  });

  test("a coordinator reads predicted grades but cannot set them", async () => {
    await as(
      ids.teacherB!,
      (tx) =>
        tx`
        INSERT INTO app.student_predicted_grades
          (school_id, academic_year_id, student_id, subject_id, grade_label, entered_by_user_id)
        VALUES
          (${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${ids.s10b!}::uuid,
           ${ids.math!}::uuid, 'B', ${ids.teacherB!}::uuid),
          (${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${ids.s10b!}::uuid,
           ${ids.science!}::uuid, 'F', ${ids.teacherB!}::uuid)
      `,
    );
    const auth = authOf(ids.coordinator!, "INSTRUCTOR");
    const view = await call("GET", predictionsPath("sec10b", "math"), auth);
    expect(view.status).toBe(200);
    expect(view.body.editable).toBe(false);
    expect(
      (view.body.students as { grade_label: string | null }[]).map((s) => s.grade_label),
    ).toEqual(["B"]);
    expect(
      (
        await call("PUT", predictionsPath("sec10b", "math"), auth, {
          term_id: null,
          grades: [{ student_id: ids.s10b, grade_label: "A" }],
        })
      ).status,
    ).toBe(403);
    // RLS: the math prediction only, never science's.
    const rows = await as(
      ids.coordinator!,
      (tx) => tx<{ subject_id: string }[]>`SELECT subject_id FROM app.student_predicted_grades`,
    );
    expect(rows.map((row) => row.subject_id)).toEqual([ids.math]);
  });

  test("a coordinator reads the subject's finalized results, not other subjects' or overall", async () => {
    // Finalized results written directly: finalizing for real is beside the point here.
    await db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
      const [finalization] = await tx<{ id: string }[]>`
        INSERT INTO app.result_finalizations (school_id, academic_year_id, section_id, finalized_by_user_id)
        VALUES (${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${ids.sec10b!}::uuid,
                ${tenant.users.ORG_ADMIN.id}::uuid)
        RETURNING id
      `;
      ids.finalization = finalization!.id;
      for (const [subject, percentage, passed] of [
        ["math", 70, true],
        ["science", 40, false],
      ] as const) {
        await tx`
          INSERT INTO app.student_subject_results
            (school_id, finalization_id, student_id, subject_id, status, percentage, marks_obtained,
             max_marks, passed, include_in_average, include_on_certificate, config_snapshot, breakdown)
          VALUES (${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids.s10b!}::uuid,
                  ${ids[subject]!}::uuid, 'complete', ${percentage}, ${percentage}, 100, ${passed},
                  true, true, '{}'::jsonb, '{}'::jsonb)
        `;
      }
      await tx`
        INSERT INTO app.student_overall_results
          (school_id, finalization_id, student_id, status, average_percentage, academic_status)
        VALUES (${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids.s10b!}::uuid,
                'complete', 55, 'promoted')
      `;
    });
    const subjectRows = await as(
      ids.coordinator!,
      (tx) => tx<{ subject_id: string }[]>`SELECT subject_id FROM app.student_subject_results`,
    );
    expect(subjectRows.map((row) => row.subject_id)).toEqual([ids.math]);
    const overall = await as(
      ids.coordinator!,
      (tx) => tx`SELECT id FROM app.student_overall_results`,
    );
    expect(overall.length).toBe(0);
  });

  test("the coordinator's overview: sections, teachers, sheet status and averages", async () => {
    const overview = await call(
      "GET",
      "/api/grading/my-coordinated-subjects",
      authOf(ids.coordinator!, "INSTRUCTOR"),
    );
    expect(overview.status).toBe(200);
    const subjects = overview.body.subjects as {
      subject_id: string;
      grade_level_ids: string[];
      sections: Record<string, unknown>[];
    }[];
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({ subject_id: ids.math, grade_level_ids: [ids.g10] });
    expect(subjects[0]!.sections.map((section) => section.section_id)).toEqual([
      ids.sec10a,
      ids.sec10b,
    ]);
    const [a, b] = subjects[0]!.sections;
    expect(a).toMatchObject({
      grade_level_name: "Grade 10",
      student_count: 1,
      average_percentage: 90,
      complete_count: 1,
      sheets: [{ term_id: null, term_name: null, status: "draft" }],
      results: [],
    });
    expect((a!.teacher_names as string[]).length).toBe(1);
    expect(b).toMatchObject({
      average_percentage: 70,
      results: [{ term_id: null, average_percentage: 70, student_count: 1 }],
    });

    // The science coordinator (every grade) sees science's sections only: 10A and 10B.
    const science = await call(
      "GET",
      "/api/grading/my-coordinated-subjects",
      authOf(ids.scienceCoordinator!, "INSTRUCTOR"),
    );
    const scienceSubjects = science.body.subjects as {
      subject_id: string;
      sections: { section_id: string; average_percentage: number | null }[];
    }[];
    expect(scienceSubjects.map((subject) => subject.subject_id)).toEqual([ids.science]);
    expect(scienceSubjects[0]!.sections.map((s) => [s.section_id, s.average_percentage])).toEqual([
      [ids.sec10a, null],
      [ids.sec10b, 40],
    ]);
  });

  test("a coordinator of another subject sees nothing of this one", async () => {
    const auth = authOf(ids.scienceCoordinator!, "INSTRUCTOR");
    expect((await call("GET", sheetPath("sec10b", "math"), auth)).status).toBe(403);
    expect((await call("GET", predictionsPath("sec10b", "math"), auth)).status).toBe(403);
    const marks = await as(
      ids.scienceCoordinator!,
      (tx) => tx<{ assessment_id: string }[]>`SELECT assessment_id FROM app.student_marks`,
    );
    expect(marks.map((m) => m.assessment_id)).toEqual([ids.science10]);
    const results = await as(
      ids.scienceCoordinator!,
      (tx) => tx<{ subject_id: string }[]>`SELECT subject_id FROM app.student_subject_results`,
    );
    expect(results.map((row) => row.subject_id)).toEqual([ids.science]);
    const predictions = await as(
      ids.scienceCoordinator!,
      (tx) => tx<{ subject_id: string }[]>`SELECT subject_id FROM app.student_predicted_grades`,
    );
    expect(predictions.map((row) => row.subject_id)).toEqual([ids.science]);
  });

  test("widening to every grade reaches grade 11; removing the assignment ends it", async () => {
    const leader = authOf(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
    const auth = authOf(ids.coordinator!, "INSTRUCTOR");
    const widened = await call(
      "PATCH",
      `/api/grading/subject-coordinators/${ids.mathCoordinator}`,
      leader,
      { grade_level_ids: [] },
    );
    expect(widened.status).toBe(200);
    expect(widened.body.grade_levels).toEqual([]);
    expect((await call("GET", sheetPath("sec11a", "math"), auth)).status).toBe(200);

    const removed = await call(
      "DELETE",
      `/api/grading/subject-coordinators/${ids.mathCoordinator}`,
      leader,
    );
    expect(removed.status).toBe(204);
    expect((await call("GET", sheetPath("sec10b", "math"), auth)).status).toBe(403);
    const marks = await as(ids.coordinator!, (tx) => tx`SELECT id FROM app.student_marks`);
    expect(marks.length).toBe(0);
    const [left] = await db.sql<{ count: string }[]>`
      SELECT count(*) FROM app.subject_coordinator_grade_levels
      WHERE school_id = ${tenant.schoolId}::uuid
    `;
    expect(left?.count).toBe("0");
  });

  test("another school reaches none of this school's coordinators", async () => {
    const foreign = authOf(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant.schoolId);
    const leader = authOf(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
    const created = await call("POST", coordinatorsPath(), leader, {
      subject_id: ids.math,
      user_id: ids.coordinator,
      grade_level_ids: [],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    expect((await call("GET", coordinatorsPath(), foreign)).status).toBe(404);
    expect(
      (
        await call("PATCH", `/api/grading/subject-coordinators/${id}`, foreign, {
          grade_level_ids: [],
        })
      ).status,
    ).toBe(404);
    expect((await call("DELETE", `/api/grading/subject-coordinators/${id}`, foreign)).status).toBe(
      404,
    );
    // Nor can it assign this school's subject or staff in its own year.
    expect(
      (
        await call(
          "POST",
          `/api/grading/years/${otherTenant.academicYear.id}/subject-coordinators`,
          foreign,
          { subject_id: ids.math, user_id: ids.coordinator, grade_level_ids: [] },
        )
      ).status,
    ).toBe(404);
    // The other school's tables hold none of these rows, even read as its owner role.
    const rows = await withTenantTx(
      client!,
      { schoolId: otherTenant.schoolId, userId: otherTenant.users.ORG_ADMIN.id },
      (tx) => tx`SELECT id FROM app.subject_coordinators`,
    );
    expect(rows.length).toBe(0);
    // A coordinator in this school is nobody in the other one.
    const elsewhere = await withTenantTx(
      client!,
      { schoolId: otherTenant.schoolId, userId: ids.coordinator! },
      (tx) => tx<{ allowed: boolean }[]>`
        SELECT app.coordinates_subject(${ids.math!}::uuid, ${tenant.academicYear.id}::uuid) AS allowed
      `,
    );
    expect(elsewhere[0]!.allowed).toBe(false);
  });
});
