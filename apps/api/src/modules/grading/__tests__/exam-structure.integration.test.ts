/**
 * The school's exam system (000174) against a real migrated database: School Settings picks the
 * system and its weights, new subjects get it as their template, and "apply to all subjects"
 * rebuilds the active year's subjects that have no marks while leaving the rest alone.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/exam-structure.integration.test.ts
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
import { getSchoolSettings, updateSchoolSettings } from "../../tenancy/settings/service";
import {
  createScale,
  createSubjectConfig,
  getConfigView,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import { applyExamStructure, getExamTemplate } from "../exam-structure";
import { getMarkSheet, saveMarks } from "../marks-service";

import type { TestApp, TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
const ids = {} as Record<string, string>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
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

const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id }, fn);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    throw error;
  }
  return "RESOLVED";
}

/** A subject graded by one annual exam: whatever the school set up before choosing a system. */
const oneExam = (): SubjectConfigInput => ({
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
      ref: "exam",
      name: "Exam",
      kind: "exam",
      scope: "annual",
      weight: 100,
      aggregation: "weighted_average",
      drop_lowest: 0,
      sort_order: 0,
    },
  ],
  assessments: [
    {
      category_ref: "exam",
      term_id: null,
      name: "Exam",
      max_marks: 100,
      weight: 1,
      is_mandatory: true,
      assessment_date: null,
      due_date: null,
      sort_order: 0,
    },
  ],
});

describeDb("exam structure", () => {
  test("setup: two terms, grade 10 with Mathematics and Science, one student", async () => {
    const year = new Date().getFullYear();
    await admin(async (tx) => {
      const [term2] = await tx<{ id: string }[]>`
        INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${tenant.academicYear.id}, ${`T2-${tenant.schoolSlug}`}, 'Term 2', 2,
                ${`${year}-07-01`}::date, ${`${year}-12-30`}::date, 'planned')
        RETURNING id
      `;
      ids.term2 = term2!.id;
    });
    ids.term1 = tenant.term.id;
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MATH", name: "Mathematics" })
    ).id;
    ids.science = (
      await createSubject(db.sql, tenant.schoolId, { code: "SCI", name: "Science" })
    ).id;
    const student = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Lina",
      lastName: "Test",
    });
    ids.student = student.id;
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);

    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 10",
        sort_order: 10,
      });
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Letters",
        bands: [
          { label: "A", min_percentage: 90, gpa_points: 4 },
          { label: "F", min_percentage: 0, gpa_points: 0 },
        ],
      });
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        grade_scale_id: scale.id,
        max_failed_subjects_for_supplementary: 2,
      });
      for (const key of ["math", "science"] as const) {
        const saved = await createSubjectConfig(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          {
            yearId: tenant.academicYear.id,
            gradeLevelId: grade.id,
            sectionId: null,
            // eslint-disable-next-line security/detect-object-injection -- `key` is a literal
            subjectId: ids[key]!,
          },
          oneExam(),
        );
        ids[`${key}Config`] = saved.config.id;
      }
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "10A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, student.id);
    });
  });

  test("the template follows School Settings: midterm by default, then the period system", async () => {
    const before = await admin((tx) =>
      getExamTemplate(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(before.structure).toBe("midterm");
    expect(before.categories.map((c) => c.kind)).toEqual([
      "midterm",
      "final_exam",
      "quiz",
      "homework",
    ]);

    // The settings page reads before it saves (which creates the school's settings row).
    await getSchoolSettings(db.sql, tenant.schoolId);
    const settings = await updateSchoolSettings(db.sql, tenant.schoolId, {
      exam_structure: "periods",
      exam_weights: { first_period: 20, second_period: 20, final_exam: 40, quiz: 10, homework: 10 },
    });
    expect(settings.exam_structure).toBe("periods");

    const after = await admin((tx) => getExamTemplate(tx, tenant.schoolId, tenant.academicYear.id));
    expect(after.categories.map((c) => [c.kind, c.weight])).toEqual([
      ["first_period", 20],
      ["second_period", 20],
      ["final_exam", 40],
      ["quiz", 10],
      ["homework", 10],
    ]);
    expect(after.term_weights).toEqual([
      { term_id: ids.term1, weight: 50 },
      { term_id: ids.term2, weight: 50 },
    ]);
  });

  test("apply rebuilds subjects without marks and leaves a subject with marks alone", async () => {
    await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );
    // Science already has a mark on its old exam.
    const science = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, ids.science!),
    );
    await admin((tx) =>
      saveMarks(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, ids.science!, [
        {
          assessment_id: science.assessments[0]!.id,
          student_id: ids.student!,
          attempt: 1,
          status: "graded",
          score: 80,
          remarks: null,
        },
      ]),
    );

    const teacherCall = withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: tenant.teachers[0]!.userId },
      (tx) => applyExamStructure(tx, tenant.schoolId, tenant.teachers[0]!.userId),
    );
    expect(await codeOf(teacherCall)).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);

    const result = await admin((tx) =>
      applyExamStructure(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id),
    );
    expect(result.structure).toBe("periods");
    expect(result.updated.map((row) => row.subject_name)).toEqual(["Mathematics"]);
    expect(result.skipped.map((row) => [row.subject_name, row.reason])).toEqual([
      ["Science", "has_marks"],
    ]);

    const math = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathConfig!));
    expect(math.valid).toBe(true);
    expect(math.categories.map((c) => [c.kind, c.scope, c.weight])).toEqual([
      ["first_period", "term", 20],
      ["second_period", "term", 20],
      ["final_exam", "term", 40],
      ["quiz", "term", 10],
      ["homework", "term", 10],
    ]);
    // Every term gets its own five assessments; the teacher's mark sheet shows them per term.
    const sheet = await admin((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, ids.math!));
    const perTerm = (termId: string) =>
      sheet.assessments.filter((a) => a.term_id === termId).map((a) => [a.name, a.max_marks]);
    expect(perTerm(ids.term1!)).toEqual([
      ["First period exam", 20],
      ["Second period exam", 20],
      ["Final exam", 40],
      ["Quizzes", 10],
      ["Homework", 10],
    ]);
    expect(perTerm(ids.term2!)).toHaveLength(5);

    const untouched = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.scienceConfig!));
    expect(untouched.categories.map((c) => c.kind)).toEqual(["exam"]);
  });

  test("HTTP: staff read the template; only leadership applies it", async () => {
    const http = harness!;
    const teacherAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.teachers[0]!.userId,
      roles: [ROLES.INSTRUCTOR],
    };
    const adminAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const template = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/years/${tenant.academicYear.id}/exam-template`,
      adminAuth,
    );
    expect(template.status).toBe(200);
    const body = (await template.json()) as { structure: string; assessments: unknown[] };
    expect(body.structure).toBe("periods");
    expect(body.assessments).toHaveLength(10);

    const denied = await authenticatedRequest(
      http,
      "POST",
      "/api/grading/exam-structure/apply",
      teacherAuth,
    );
    expect(denied.status).toBe(403);
    const applied = await authenticatedRequest(
      http,
      "POST",
      "/api/grading/exam-structure/apply",
      adminAuth,
    );
    expect(applied.status).toBe(200);
  });
});
