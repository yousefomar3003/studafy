/**
 * Academic grading (000160) end to end, against a real migrated database with RLS armed.
 *
 * One school year is walked through in order: grade defaults, sections inheriting them, section
 * overrides, publication, teacher mark entry, approval, finalization, certificates, correction and
 * reissue, then copying the year. Every number asserted below is worked out by hand in the comment
 * beside it. Later tests build on earlier ones, so the file runs as one ordered story.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/grading.integration.test.ts
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
import {
  issueCertificates,
  certificateReadiness,
  getCertificate,
  reissueCertificate,
} from "../certificate-service";
import {
  acknowledgeGradeRevision,
  collectPublishIssues,
  createScale,
  createSectionOverride,
  createSubjectConfig,
  createTeacherAssignment,
  deleteSubjectConfig,
  getConfigImpact,
  getConfigView,
  listSectionSubjects,
  setYearGradingStatus,
  updateSubjectConfig,
  upsertProgram,
} from "../config-service";
import { copyYearConfiguration } from "../copy-year-service";
import {
  addSectionAssessment,
  decideMarkSheet,
  getMarkSheet,
  listMarkSheets,
  saveMarks,
  submitMarkSheet,
} from "../marks-service";
import { getGradingOverview } from "../overview-service";
import {
  computeSection,
  correctFinalization,
  finalizeSection,
  readFinalizationResults,
} from "../results-service";

import type { TestApp, TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { MarkEntryInput } from "../marks-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let other: TenantFixture;

const ids = {} as Record<string, string>;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  other = await createFullTenant(db.sql);
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

const as = <T>(
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
  schoolId = tenant.schoolId,
) => withTenantTx(client!, { schoolId, userId }, fn);
const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.users.ORG_ADMIN.id, fn);
const teacher = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.teachers[0]!.userId, fn);

/** The error code a rejected call carries. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    return String((error as { code?: string }).code ?? error);
  }
  return "RESOLVED";
}

function baseInput(overrides: Partial<SubjectConfigInput> = {}): SubjectConfigInput {
  return {
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
    categories: [],
    assessments: [],
    ...overrides,
  };
}

const category = (
  ref: string,
  weight: number | null,
  extra: Partial<SubjectConfigInput["categories"][number]> = {},
) => ({
  ref,
  name: ref,
  kind: "other" as const,
  scope: "annual" as const,
  weight,
  aggregation: "weighted_average" as const,
  drop_lowest: 0,
  sort_order: 0,
  ...extra,
});

const assessment = (
  name: string,
  categoryRef: string,
  maxMarks: number,
  extra: Partial<SubjectConfigInput["assessments"][number]> = {},
) => ({
  category_ref: categoryRef,
  term_id: null,
  name,
  max_marks: maxMarks,
  weight: 1,
  is_mandatory: true,
  assessment_date: null,
  due_date: null,
  sort_order: 0,
  ...extra,
});

/** The spec's Mathematics: homework 10%, quizzes 10%, midterm 20%, final 60%. */
const mathInput = () =>
  baseInput({
    categories: [
      category("homework", 10, { kind: "homework" }),
      category("quizzes", 10, { kind: "quiz" }),
      category("midterm", 20, { kind: "midterm" }),
      category("final", 60, { kind: "final_exam" }),
    ],
    assessments: [
      assessment("HW1", "homework", 10),
      assessment("HW2", "homework", 10),
      assessment("Quiz 1", "quizzes", 20),
      assessment("Quiz 2", "quizzes", 20),
      assessment("Midterm", "midterm", 50),
      assessment("Final", "final", 100),
    ],
  });

/** Two semesters at 40% each, each 60% exams + 40% homework, plus an annual final at 20%. */
const scienceInput = () =>
  baseInput({
    term_weights: [
      { term_id: ids.term1!, weight: 40 },
      { term_id: ids.term2!, weight: 40 },
    ],
    categories: [
      category("exams", 60, { scope: "term", kind: "exam" }),
      category("homework", 40, { scope: "term", kind: "homework" }),
      category("final", 20, { scope: "annual", kind: "final_exam" }),
    ],
    assessments: [
      assessment("Exam S1", "exams", 50, { term_id: ids.term1! }),
      assessment("Homework S1", "homework", 10, { term_id: ids.term1! }),
      assessment("Exam S2", "exams", 50, { term_id: ids.term2! }),
      assessment("Homework S2", "homework", 10, { term_id: ids.term2! }),
      assessment("Annual final", "final", 100),
    ],
  });

/** Total points: 30 + 30 + 40. */
const arabicInput = () =>
  baseInput({
    grading_method: "total_points",
    categories: [category("tests", null), category("final", null, { kind: "final_exam" })],
    assessments: [
      assessment("Test 1", "tests", 30),
      assessment("Test 2", "tests", 30),
      assessment("Final", "final", 40),
    ],
  });

async function sheet(sectionId: string, subjectId: string) {
  return admin((tx) => getMarkSheet(tx, tenant.schoolId, sectionId, subjectId));
}

async function assessmentIds(
  sectionId: string,
  subjectId: string,
): Promise<Record<string, string>> {
  const view = await sheet(sectionId, subjectId);
  return Object.fromEntries(view.assessments.map((a) => [a.name, a.id]));
}

function marks(
  studentId: string,
  byName: Record<string, string>,
  scores: Record<string, number | null>,
): MarkEntryInput[] {
  return Object.entries(scores).map(([name, score]) => ({
    assessment_id: byName[name]!,
    student_id: studentId,
    attempt: 1,
    status: score === null ? "absent" : "graded",
    score,
    remarks: null,
  }));
}

describeDb("academic grading", () => {
  test("setup: a second term, three subjects, students and a teacher with the INSTRUCTOR role", async () => {
    const [term2] = await admin(
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${tenant.academicYear.id}, ${`T2-${tenant.schoolSlug}`}, 'Semester 2', 2,
                ${`${new Date().getFullYear()}-07-01`}::date, ${`${new Date().getFullYear()}-12-30`}::date, 'planned')
        RETURNING id
      `,
    );
    ids.term1 = tenant.term.id;
    ids.term2 = term2!.id;
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MATH", name: "Mathematics" })
    ).id;
    ids.science = (
      await createSubject(db.sql, tenant.schoolId, { code: "SCI", name: "Science" })
    ).id;
    ids.arabic = (await createSubject(db.sql, tenant.schoolId, { code: "AR", name: "Arabic" })).id;
    ids.history = (
      await createSubject(db.sql, tenant.schoolId, { code: "HIS", name: "History" })
    ).id;
    for (const [key, name] of [
      ["s1", "Amal"],
      ["s2", "Badr"],
      ["s3", "Dana"],
    ] as const) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[key] = student.id;
      ids[`${key}User`] = student.userId;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
    const outsider = await createTeacher(db.sql, tenant.schoolId);
    await assignRole(db.sql, tenant.schoolId, outsider.userId, ROLES.INSTRUCTOR);
    ids.outsiderUser = outsider.userId;
  });

  test("1-2, 8: grade 8 gets three subjects configured once, each with its own structure", async () => {
    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "Grade 8", sort_order: 8 });
      ids.grade8 = grade.id;
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Letters",
        bands: [
          { label: "A", min_percentage: 90, gpa_points: 4 },
          { label: "B", min_percentage: 80, gpa_points: 3 },
          { label: "C", min_percentage: 70, gpa_points: 2 },
          { label: "D", min_percentage: 50, gpa_points: 1 },
          { label: "F", min_percentage: 0, gpa_points: 0 },
        ],
      });
      ids.scale = scale.id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        grade_scale_id: scale.id,
        max_failed_subjects_for_supplementary: 2,
      });
      const target = (subjectId: string) => ({
        yearId: tenant.academicYear.id,
        gradeLevelId: grade.id,
        sectionId: null,
        subjectId,
      });
      const userId = tenant.users.ORG_ADMIN.id;
      const math = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        target(ids.math!),
        mathInput(),
      );
      const science = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        target(ids.science!),
        scienceInput(),
      );
      const arabic = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        target(ids.arabic!),
        arabicInput(),
      );
      ids.mathConfig = math.config.id;
      ids.scienceConfig = science.config.id;
      ids.arabicConfig = arabic.config.id;
      expect(math.config.valid).toBe(true);
      expect(math.config.weight_summary).toEqual({
        termCategoryTotal: 0,
        annualTotal: 100,
        valid: true,
      });
      expect(science.config.weight_summary).toEqual({
        termCategoryTotal: 100,
        annualTotal: 100,
        valid: true,
      });
      expect(arabic.config.grading_method).toBe("total_points");
      expect(arabic.config.valid).toBe(true);

      // A duplicate subject assignment is refused.
      expect(
        await codeOf(
          createSubjectConfig(tx, tenant.schoolId, userId, target(ids.math!), mathInput()),
        ),
      ).toBe(ERROR_CODES.SUBJECT_CONFIG_DUPLICATE);
    });
  });

  test("3: sections created afterwards inherit every grade subject", async () => {
    await admin(async (tx) => {
      for (const name of ["8A", "8B", "8C"]) {
        const section = await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: ids.grade8!,
          name,
        });
        ids[name] = section.id;
      }
      const { subjects } = await listSectionSubjects(tx, tenant.schoolId, ids["8A"]!);
      expect(subjects.map((s) => [s.subject_name, s.source])).toEqual([
        ["Arabic", "inherited"],
        ["Mathematics", "inherited"],
        ["Science", "inherited"],
      ]);
      await placeStudentInSection(tx, tenant.schoolId, ids["8A"]!, ids.s1!);
      await placeStudentInSection(tx, tenant.schoolId, ids["8A"]!, ids.s2!);
      await placeStudentInSection(tx, tenant.schoolId, ids["8B"]!, ids.s3!);
    });
  });

  test("7: weights are validated; a draft keeps an unfinished subject, publication refuses it", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const broken = await admin((tx) =>
      createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids.grade8!,
          sectionId: null,
          subjectId: ids.history!,
        },
        baseInput({
          categories: [category("essays", 30), category("final", 60, { kind: "final_exam" })],
          assessments: [assessment("Essay", "essays", 20), assessment("Final", "final", 100)],
        }),
      ),
    );
    expect(broken.config.valid).toBe(false);
    expect(broken.config.weight_summary.annualTotal).toBe(90);
    expect(broken.config.issues.map((issue) => issue.code)).toContain("ANNUAL_WEIGHT_TOTAL");

    const issues = await admin((tx) =>
      collectPublishIssues(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(
      issues.some((issue) => issue.severity === "error" && issue.code === "ANNUAL_WEIGHT_TOTAL"),
    ).toBe(true);
    expect(
      await codeOf(
        admin((tx) => setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active")),
      ),
    ).toBe(ERROR_CODES.ACADEMIC_CONFIG_INVALID);

    await admin((tx) => deleteSubjectConfig(tx, tenant.schoolId, broken.config.id));
    const published = await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );
    expect(published.status).toBe("active");
    // Missing teachers are warnings, not blockers.
    expect(published.issues.some((issue) => issue.code === "MISSING_TEACHER")).toBe(true);

    // Once live, an invalid save is rejected outright.
    const invalid = mathInput();
    invalid.categories[0]!.weight = 15;
    expect(
      await codeOf(
        admin((tx) =>
          updateSubjectConfig(tx, tenant.schoolId, userId, ids.mathConfig!, invalid, {
            confirmImpact: true,
          }),
        ),
      ),
    ).toBe(ERROR_CODES.ACADEMIC_CONFIG_INVALID);
  });

  test("4: sections can override, exclude, or add one assessment, and say so explicitly", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const override = await admin((tx) =>
      createSectionOverride(tx, tenant.schoolId, userId, ids["8B"]!, ids.math!, "customize"),
    );
    ids.mathOverride8B = override.config.id;
    expect(override.config.section_id).toBe(ids["8B"]);
    expect(override.config.based_on_revision).toBe(1);

    // 8B: homework 20, quizzes 10, midterm 20, final 50.
    const view = await admin((tx) => getConfigView(tx, tenant.schoolId, override.config.id));
    const edited = mathInput();
    edited.categories = view.categories.map((c) => ({
      ref: c.id,
      name: c.name,
      kind: c.kind,
      scope: c.scope,
      weight: c.name === "homework" ? 20 : c.name === "final" ? 50 : c.weight,
      aggregation: c.aggregation,
      drop_lowest: c.drop_lowest,
      sort_order: c.sort_order,
    }));
    edited.assessments = view.assessments.map((a) => ({
      id: a.id,
      category_ref: a.category_id,
      term_id: a.term_id,
      name: a.name,
      max_marks: a.max_marks,
      weight: a.weight,
      is_mandatory: a.is_mandatory,
      assessment_date: null,
      due_date: null,
      sort_order: a.sort_order,
    }));
    await admin((tx) =>
      updateSubjectConfig(tx, tenant.schoolId, userId, override.config.id, edited, {
        confirmImpact: false,
      }),
    );

    await admin((tx) =>
      createSectionOverride(tx, tenant.schoolId, userId, ids["8C"]!, ids.arabic!, "exclude"),
    );
    const scienceCategories = (
      await admin((tx) => getConfigView(tx, tenant.schoolId, ids.scienceConfig!))
    ).categories;
    await admin((tx) =>
      addSectionAssessment(tx, tenant.schoolId, userId, ids["8C"]!, ids.science!, {
        category_id: scienceCategories.find((c) => c.name === "final")!.id,
        term_id: null,
        name: "Lab practical",
        max_marks: 20,
        weight: 1,
        is_mandatory: true,
        assessment_date: null,
        due_date: null,
      }),
    );

    const sources = async (section: string) =>
      Object.fromEntries(
        (await admin((tx) => listSectionSubjects(tx, tenant.schoolId, ids[section]!))).subjects.map(
          (s) => [s.subject_name, s.source],
        ),
      );
    expect(await sources("8A")).toEqual({
      Arabic: "inherited",
      Mathematics: "inherited",
      Science: "inherited",
    });
    expect(await sources("8B")).toEqual({
      Arabic: "inherited",
      Mathematics: "override",
      Science: "inherited",
    });
    expect(await sources("8C")).toEqual({
      Arabic: "excluded",
      Mathematics: "inherited",
      Science: "inherited",
    });

    // The practical belongs to 8C only.
    expect((await sheet(ids["8C"]!, ids.science!)).assessments.map((a) => a.name)).toContain(
      "Lab practical",
    );
    expect((await sheet(ids["8A"]!, ids.science!)).assessments.map((a) => a.name)).not.toContain(
      "Lab practical",
    );
  });

  test("14: teachers grade only what they are assigned to", async () => {
    await admin(async (tx) => {
      for (const subject of [ids.math!, ids.science!, ids.arabic!]) {
        await createTeacherAssignment(tx, tenant.schoolId, {
          section_id: ids["8A"]!,
          subject_id: subject,
          teacher_id: tenant.teachers[0]!.id,
        });
      }
    });
    const own = await teacher((tx) => getMarkSheet(tx, tenant.schoolId, ids["8A"]!, ids.math!));
    expect(own.students.map((s) => s.first_name).sort()).toEqual(["Amal", "Badr"]);
    expect(
      await codeOf(teacher((tx) => getMarkSheet(tx, tenant.schoolId, ids["8B"]!, ids.math!))),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    const byName = await assessmentIds(ids["8A"]!, ids.math!);
    expect(
      await codeOf(
        as(ids.outsiderUser!, (tx) =>
          saveMarks(
            tx,
            tenant.schoolId,
            ids.outsiderUser!,
            ids["8A"]!,
            ids.math!,
            marks(ids.s1!, byName, { HW1: 5 }),
          ),
        ),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
  });

  test("9, 10, 11: marks, weighted, term and annual grades, and incomplete results", async () => {
    const user = tenant.teachers[0]!.userId;
    const math = await assessmentIds(ids["8A"]!, ids.math!);
    const science = await assessmentIds(ids["8A"]!, ids.science!);
    const arabic = await assessmentIds(ids["8A"]!, ids.arabic!);
    await teacher(async (tx) => {
      // Amal: homework 90, quizzes 80, midterm 80, final 75 -> 9 + 8 + 16 + 45 = 78
      await saveMarks(tx, tenant.schoolId, user, ids["8A"]!, ids.math!, [
        ...marks(ids.s1!, math, {
          HW1: 8,
          HW2: 10,
          "Quiz 1": 14,
          "Quiz 2": 18,
          Midterm: 40,
          Final: 75,
        }),
        // Badr has no final yet.
        ...marks(ids.s2!, math, { HW1: 8, HW2: 10, "Quiz 1": 14, "Quiz 2": 18, Midterm: 40 }),
      ]);
      // Amal: S1 = 80 x .6 + 100 x .4 = 88; S2 = 70 x .6 + 50 x .4 = 62; final 90
      //       annual = 88 x .4 + 62 x .4 + 90 x .2 = 78
      // Badr: every assessment at 50% -> 50
      await saveMarks(tx, tenant.schoolId, user, ids["8A"]!, ids.science!, [
        ...marks(ids.s1!, science, {
          "Exam S1": 40,
          "Homework S1": 10,
          "Exam S2": 35,
          "Homework S2": 5,
          "Annual final": 90,
        }),
        ...marks(ids.s2!, science, {
          "Exam S1": 25,
          "Homework S1": 5,
          "Exam S2": 25,
          "Homework S2": 5,
          "Annual final": 50,
        }),
      ]);
      // Amal: (24 + 27 + 30) / 100 = 81; Badr: (15 + 15 + 20) / 100 = 50
      await saveMarks(tx, tenant.schoolId, user, ids["8A"]!, ids.arabic!, [
        ...marks(ids.s1!, arabic, { "Test 1": 24, "Test 2": 27, Final: 30 }),
        ...marks(ids.s2!, arabic, { "Test 1": 15, "Test 2": 15, Final: 20 }),
      ]);
    });

    const mathSheet = await sheet(ids["8A"]!, ids.math!);
    const amal = mathSheet.students.find((s) => s.student_id === ids.s1)!;
    expect(amal.preview).toMatchObject({
      status: "complete",
      percentage: 78,
      grade_label: "C",
      passed: true,
    });
    const badr = mathSheet.students.find((s) => s.student_id === ids.s2)!;
    // Incomplete is never a final grade; the preview over what is marked is (9 + 8 + 16) / 40 = 82.5.
    expect(badr.preview).toMatchObject({
      status: "incomplete",
      percentage: null,
      passed: null,
      provisional_percentage: 82.5,
    });
    expect(badr.preview!.missing_assessment_ids).toEqual([math.Final]);

    const scienceSheet = await sheet(ids["8A"]!, ids.science!);
    const amalScience = scienceSheet.students.find((s) => s.student_id === ids.s1)!.preview!;
    expect(amalScience.percentage).toBe(78);
    expect(amalScience.terms.map((t) => t.percentage)).toEqual([88, 62]);
    const arabicSheet = await sheet(ids["8A"]!, ids.arabic!);
    expect(arabicSheet.students.find((s) => s.student_id === ids.s1)!.preview!.percentage).toBe(81);

    const preview = await admin((tx) => computeSection(tx, tenant.schoolId, ids["8A"]!, null));
    const amalOverall = preview.students.find((s) => s.student.id === ids.s1)!.overall;
    // (78 + 78 + 81) / 3 = 79, totals 237 / 300
    expect(amalOverall).toMatchObject({
      status: "complete",
      averagePercentage: 79,
      totalObtained: 237,
      totalMax: 300,
      gradeLabel: "C",
      academicStatus: "promoted",
    });
    expect(preview.students.find((s) => s.student.id === ids.s2)!.overall.status).toBe(
      "incomplete",
    );

    // Out-of-range and exempt-free validation.
    expect(
      await codeOf(
        teacher((tx) =>
          saveMarks(
            tx,
            tenant.schoolId,
            user,
            ids["8A"]!,
            ids.math!,
            marks(ids.s1!, math, { HW1: 11 }),
          ),
        ),
      ),
    ).toBe(ERROR_CODES.MARK_SCORE_OUT_OF_RANGE);
  });

  test("5: changing a grade default needs confirmation, spares overrides and flags them", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const view = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathConfig!));
    const changed = {
      ...mathInput(),
      pass_percentage: 60,
      categories: view.categories.map((c) => ({ ...c, ref: c.id })),
      assessments: view.assessments.map((a) => ({ ...a, category_ref: a.category_id })),
    };
    expect(
      await codeOf(
        admin((tx) =>
          updateSubjectConfig(tx, tenant.schoolId, userId, ids.mathConfig!, changed, {
            confirmImpact: false,
          }),
        ),
      ),
    ).toBe(ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED);

    const impact = await admin((tx) => getConfigImpact(tx, tenant.schoolId, ids.mathConfig!));
    expect(impact.inheriting_sections.map((s) => [s.name, s.mark_count])).toEqual([
      ["8A", 11],
      ["8C", 0],
    ]);
    expect(impact.overriding_sections.map((s) => s.name)).toEqual(["8B"]);

    const saved = await admin((tx) =>
      updateSubjectConfig(tx, tenant.schoolId, userId, ids.mathConfig!, changed, {
        confirmImpact: true,
      }),
    );
    expect(saved.config.revision).toBe(2);
    expect(saved.affected_section_ids.sort()).toEqual([ids["8A"]!, ids["8C"]!].sort());

    // 8B kept its own rules and is now flagged as behind the default.
    const override = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathOverride8B!));
    expect(override.pass_percentage).toBe(50);
    expect(override.categories.find((c) => c.name === "homework")!.weight).toBe(20);
    const before = await admin((tx) => listSectionSubjects(tx, tenant.schoolId, ids["8B"]!));
    expect(before.subjects.find((s) => s.subject_id === ids.math)!.outdated).toBe(true);
    await admin((tx) => acknowledgeGradeRevision(tx, tenant.schoolId, ids.mathOverride8B!));
    const after = await admin((tx) => listSectionSubjects(tx, tenant.schoolId, ids["8B"]!));
    expect(after.subjects.find((s) => s.subject_id === ids.math)!.outdated).toBe(false);
  });

  test("approval: incomplete sheets cannot be submitted, submitted ones lock, approval unlocks finalization", async () => {
    const user = tenant.teachers[0]!.userId;
    const math = await assessmentIds(ids["8A"]!, ids.math!);
    expect(
      await codeOf(
        teacher((tx) => submitMarkSheet(tx, tenant.schoolId, user, ids["8A"]!, ids.math!, null)),
      ),
    ).toBe(ERROR_CODES.RESULTS_INCOMPLETE);

    // Badr: final 45 -> 9 + 8 + 16 + 27 = 60, exactly the new pass mark.
    await teacher((tx) =>
      saveMarks(
        tx,
        tenant.schoolId,
        user,
        ids["8A"]!,
        ids.math!,
        marks(ids.s2!, math, { Final: 45 }),
      ),
    );

    await teacher(async (tx) => {
      await submitMarkSheet(tx, tenant.schoolId, user, ids["8A"]!, ids.math!, null);
      await submitMarkSheet(tx, tenant.schoolId, user, ids["8A"]!, ids.science!, ids.term1!);
      await submitMarkSheet(tx, tenant.schoolId, user, ids["8A"]!, ids.science!, ids.term2!);
      await submitMarkSheet(tx, tenant.schoolId, user, ids["8A"]!, ids.science!, null);
      await submitMarkSheet(tx, tenant.schoolId, user, ids["8A"]!, ids.arabic!, null);
    });
    expect(
      await codeOf(
        teacher((tx) =>
          saveMarks(
            tx,
            tenant.schoolId,
            user,
            ids["8A"]!,
            ids.math!,
            marks(ids.s2!, math, { Final: 50 }),
          ),
        ),
      ),
    ).toBe(ERROR_CODES.MARKS_LOCKED);

    // A teacher cannot approve their own sheet.
    const queue = await admin((tx) =>
      listMarkSheets(tx, tenant.schoolId, { yearId: tenant.academicYear.id, status: "submitted" }),
    );
    expect(queue).toHaveLength(5);
    expect(
      await codeOf(
        teacher((tx) => decideMarkSheet(tx, tenant.schoolId, user, queue[0]!.id, "approve", null)),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);

    expect(
      await codeOf(
        admin((tx) =>
          finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids["8A"]!, null, {
            allowIncomplete: false,
          }),
        ),
      ),
    ).toBe(ERROR_CODES.RESULTS_INCOMPLETE);
    await admin(async (tx) => {
      for (const row of queue)
        await decideMarkSheet(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          row.id,
          "approve",
          null,
        );
    });
  });

  test("finalize: results are stored as immutable snapshots", async () => {
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids["8A"]!, null, {
        allowIncomplete: false,
      }),
    );
    ids.final8A = finalization.id;
    expect(finalization.version).toBe(1);
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, finalization.id),
    );
    const amal = results.find((r) => r.student_id === ids.s1)!;
    expect(amal).toMatchObject({
      status: "complete",
      average_percentage: 79,
      total_obtained: 237,
      total_max: 300,
      grade_label: "C",
      academic_status: "promoted",
    });
    expect(
      amal.subjects.map((s) => [s.subject_name, s.percentage, s.grade_label, s.passed]),
    ).toEqual([
      ["Arabic", 81, "B", true],
      ["Mathematics", 78, "C", true],
      ["Science", 78, "C", true],
    ]);
    const badr = results.find((r) => r.student_id === ids.s2)!;
    // Math 60 (pass mark 60), Science 50, Arabic 50 -> 53.33, D, promoted
    expect(badr).toMatchObject({
      status: "complete",
      average_percentage: 53.33,
      grade_label: "D",
      academic_status: "promoted",
    });

    expect(
      await codeOf(
        admin((tx) =>
          finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids["8A"]!, null, {
            allowIncomplete: false,
          }),
        ),
      ),
    ).toBe(ERROR_CODES.RESULTS_ALREADY_FINALIZED);
  });

  test("10: a term report covers only the subjects graded in that term", async () => {
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids["8A"]!, ids.term1!, {
        allowIncomplete: false,
      }),
    );
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, finalization.id),
    );
    const amal = results.find((r) => r.student_id === ids.s1)!;
    // Only Science has Semester 1 assessments: 80 x .6 + 100 x .4 = 88
    expect(amal.subjects.map((s) => [s.subject_name, s.percentage])).toEqual([["Science", 88]]);
    expect(amal).toMatchObject({
      status: "complete",
      average_percentage: 88,
      academic_status: "promoted",
    });
  });

  test("13: later configuration edits never change finalized results; finalized marks are locked", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const view = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathConfig!));
    await admin((tx) =>
      updateSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        ids.mathConfig!,
        {
          ...mathInput(),
          pass_percentage: 80,
          categories: view.categories.map((c) => ({
            ...c,
            ref: c.id,
            weight: c.name === "final" ? 40 : c.name === "midterm" ? 40 : c.weight,
          })),
          assessments: view.assessments.map((a) => ({ ...a, category_ref: a.category_id })),
        },
        { confirmImpact: true },
      ),
    );
    const stored = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, ids.final8A!, { studentId: ids.s1! }),
    );
    const math = stored[0]!.subjects.find((s) => s.subject_name === "Mathematics")!;
    expect(math).toMatchObject({ percentage: 78, passed: true });

    // Even an administrator cannot change a finalized mark outside the correction workflow.
    const byName = await assessmentIds(ids["8A"]!, ids.math!);
    const blocked = await codeOf(
      admin(
        (tx) =>
          tx`UPDATE app.student_marks SET score = 99 WHERE assessment_id = ${byName.Final!} AND student_id = ${ids.s1!}`,
      ),
    );
    expect(blocked).toBe("23514");
    // And nobody can rewrite stored results.
    const rewrite = await codeOf(
      admin(
        (tx) =>
          tx`UPDATE app.student_subject_results SET percentage = 100 WHERE finalization_id = ${ids.final8A!}`,
      ),
    );
    expect(rewrite).toBe("42501");

    // Put the default back so the rest of the story reads naturally.
    const reset = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathConfig!));
    await admin((tx) =>
      updateSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        ids.mathConfig!,
        {
          ...mathInput(),
          pass_percentage: 60,
          categories: reset.categories.map((c) => ({
            ...c,
            ref: c.id,
            weight: (
              { homework: 10, quizzes: 10, midterm: 20, final: 60 } as Record<string, number>
            )[c.name]!,
          })),
          assessments: reset.assessments.map((a) => ({ ...a, category_ref: a.category_id })),
        },
        { confirmImpact: true },
      ),
    );
  });

  test("15: certificates carry the finalized results exactly", async () => {
    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.final8A!, undefined),
    );
    expect(issued.issued).toHaveLength(2);
    const certificates = await Promise.all(
      issued.issued.map((id) => admin((tx) => getCertificate(tx, tenant.schoolId, id))),
    );
    const amal = certificates.find((c) => c.student_id === ids.s1)!;
    ids.amalCertificate = amal.id;
    expect(amal.kind).toBe("annual_certificate");
    expect(amal.content.overall).toMatchObject({
      average_percentage: 79,
      total_obtained: 237,
      total_max: 300,
      academic_status: "promoted",
    });
    expect(amal.content.subjects.map((s) => [s.name, s.marks_obtained, s.max_marks])).toEqual([
      ["Arabic", 81, 100],
      ["Mathematics", 78, 100],
      ["Science", 78, 100],
    ]);
    expect(amal.content.section_name).toBe("8A");
    expect(amal.content_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Issuing again issues nothing new.
    const again = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.final8A!, undefined),
    );
    expect(again.issued).toHaveLength(0);
  });

  test("17: a correction recomputes with the rules results were finalized under, then the certificate is reissued", async () => {
    const byName = await assessmentIds(ids["8A"]!, ids.math!);
    // Amal's final was 95, not 75: 9 + 8 + 16 + 57 = 90 -> A
    const corrected = await admin((tx) =>
      correctFinalization(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.final8A!, {
        reason: "Final exam paper re-marked",
        marks: [
          {
            assessment_id: byName.Final!,
            student_id: ids.s1!,
            attempt: 1,
            status: "graded",
            score: 95,
          },
        ],
        allow_incomplete: false,
      }),
    );
    expect(corrected.version).toBe(2);
    expect(corrected.supersedes_id).toBe(ids.final8A);
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, corrected.id, { studentId: ids.s1! }),
    );
    expect(results[0]!.subjects.find((s) => s.subject_name === "Mathematics")).toMatchObject({
      percentage: 90,
      grade_label: "A",
    });
    // (81 + 90 + 78) / 3 = 83
    expect(results[0]!.average_percentage).toBe(83);
    // The first version is still there, unchanged.
    const original = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, ids.final8A!, { studentId: ids.s1! }),
    );
    expect(original[0]!.average_percentage).toBe(79);

    const readiness = await admin((tx) => certificateReadiness(tx, tenant.schoolId, corrected.id));
    expect(readiness.find((r) => r.student_id === ids.s1)!.state).toBe("needs_reissue");
    const old = await admin((tx) => getCertificate(tx, tenant.schoolId, ids.amalCertificate!));
    expect(old.needs_reissue).toBe(true);

    const reissued = await admin((tx) =>
      reissueCertificate(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.amalCertificate!,
        "Corrected final exam mark",
      ),
    );
    expect(reissued.supersedes_id).toBe(ids.amalCertificate);
    expect(reissued.content.overall.average_percentage).toBe(83);
    expect(reissued.content.reissue).toMatchObject({ supersedes_serial: old.serial_number });
    const superseded = await admin((tx) =>
      getCertificate(tx, tenant.schoolId, ids.amalCertificate!),
    );
    expect(superseded.status).toBe("superseded");
    expect(superseded.content.overall.average_percentage).toBe(79);
  });

  test("11, 15: incomplete results can be finalized as incomplete but never certified", async () => {
    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade8!, {
        mark_approval_required: false,
      }),
    );
    expect(
      await codeOf(
        admin((tx) =>
          finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids["8B"]!, null, {
            allowIncomplete: false,
          }),
        ),
      ),
    ).toBe(ERROR_CODES.RESULTS_INCOMPLETE);
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids["8B"]!, null, {
        allowIncomplete: true,
      }),
    );
    const [dana] = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, finalization.id),
    );
    expect(dana).toMatchObject({
      status: "incomplete",
      average_percentage: null,
      academic_status: "incomplete",
    });
    expect(dana!.subjects.every((s) => s.percentage === null && s.passed === null)).toBe(true);
    const readiness = await admin((tx) =>
      certificateReadiness(tx, tenant.schoolId, finalization.id),
    );
    expect(readiness[0]!.state).toBe("blocked");
    expect(
      await codeOf(
        admin((tx) =>
          issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, finalization.id, [
            ids.s3!,
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.CERTIFICATE_BLOCKED);

    const overview = await admin((tx) =>
      getGradingOverview(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(overview.counts.certificates_blocked).toBe(1);
    expect(overview.counts.sections_with_overrides).toBe(2);
  });

  test("6: a new year starts from the old configuration without its marks or results", async () => {
    const nextYear = new Date().getFullYear() + 1;
    const [year2] = await admin(
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${`AY2-${tenant.schoolSlug}`}, 'Next year',
                ${`${nextYear}-01-01`}::date, ${`${nextYear}-12-31`}::date, 'planned')
        RETURNING id
      `,
    );
    await admin(
      (tx) => tx`
        INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${year2!.id}, 'Y2T1', 'Semester 1', 1, ${`${nextYear}-01-01`}::date, ${`${nextYear}-06-30`}::date, 'planned'),
               (${tenant.schoolId}, ${year2!.id}, 'Y2T2', 'Semester 2', 2, ${`${nextYear}-07-01`}::date, ${`${nextYear}-12-30`}::date, 'planned')
      `,
    );
    const summary = await admin((tx) =>
      copyYearConfiguration(tx, tenant.schoolId, tenant.academicYear.id, year2!.id, {
        includeTeacherAssignments: true,
      }),
    );
    expect(summary).toMatchObject({
      scales: 1,
      grade_programs: 1,
      sections_created: 3,
      subject_configs: 5, // three grade defaults, 8B's Mathematics override, 8C's excluded Arabic
      teacher_assignments: 3,
      warnings: [],
    });

    const counts = await admin(
      (tx) => tx<{ marks: number; finalizations: number; certificates: number; status: string }[]>`
        SELECT
          (SELECT count(*)::int FROM app.student_marks WHERE academic_year_id = ${year2!.id}) AS marks,
          (SELECT count(*)::int FROM app.result_finalizations WHERE academic_year_id = ${year2!.id}) AS finalizations,
          (SELECT count(*)::int FROM app.certificates WHERE academic_year_id = ${year2!.id}) AS certificates,
          (SELECT grading_config_status FROM app.academic_years WHERE id = ${year2!.id}) AS status
      `,
    );
    expect(counts[0]).toEqual({ marks: 0, finalizations: 0, certificates: 0, status: "draft" });

    const [section8B] = await admin(
      (tx) =>
        tx<
          { id: string }[]
        >`SELECT id FROM app.sections WHERE academic_year_id = ${year2!.id} AND name = '8B'`,
    );
    const subjects = await admin((tx) => listSectionSubjects(tx, tenant.schoolId, section8B!.id));
    expect(subjects.subjects.find((s) => s.subject_id === ids.math)!.source).toBe("override");
    // The copied Science keeps its two-semester structure, mapped onto the new year's terms.
    const science = subjects.subjects.find((s) => s.subject_id === ids.science)!;
    const scienceView = await admin((tx) => getConfigView(tx, tenant.schoolId, science.config_id!));
    expect(scienceView.term_weights.map((t) => [t.term_name, t.weight])).toEqual([
      ["Semester 1", 40],
      ["Semester 2", 40],
    ]);
    expect(scienceView.valid).toBe(true);
    // And the old year is untouched.
    const old = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.scienceConfig!));
    expect(old.mark_count).toBe(10);
  });

  test("16: another school sees none of it", async () => {
    const otherAdmin = other.users.ORG_ADMIN.id;
    expect(
      await codeOf(
        as(otherAdmin, (tx) => getConfigView(tx, other.schoolId, ids.mathConfig!), other.schoolId),
      ),
    ).toBe(ERROR_CODES.SUBJECT_CONFIG_NOT_FOUND);
    expect(
      await codeOf(
        as(
          otherAdmin,
          (tx) => getCertificate(tx, other.schoolId, ids.amalCertificate!),
          other.schoolId,
        ),
      ),
    ).toBe(ERROR_CODES.CERTIFICATE_NOT_FOUND);
    const leaked = await as(
      otherAdmin,
      (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM app.student_marks`,
      other.schoolId,
    );
    expect(leaked[0]!.count).toBe(0);
  });

  test("HTTP: permissions are enforced on the routes, and students see only their own results", async () => {
    const http = harness!;
    const teacherAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.teachers[0]!.userId,
      roles: [ROLES.INSTRUCTOR],
    };
    const sheetRes = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/sections/${ids["8A"]}/subjects/${ids.math}/marks`,
      teacherAuth,
    );
    expect(sheetRes.status).toBe(200);
    const configRes = await authenticatedRequest(
      http,
      "PUT",
      `/api/grading/subject-configs/${ids.mathConfig}`,
      teacherAuth,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categories: [], assessments: [] }),
      },
    );
    expect(configRes.status).toBe(403);
    const finalizeRes = await authenticatedRequest(
      http,
      "POST",
      `/api/grading/sections/${ids["8A"]}/results/finalize`,
      teacherAuth,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(finalizeRes.status).toBe(403);

    const studentAuth = { schoolId: tenant.schoolId, userId: ids.s1User!, roles: [ROLES.STUDENT] };
    const own = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/students/${ids.s1}/results`,
      studentAuth,
    );
    expect(own.status).toBe(200);
    const body = (await own.json()) as {
      results: { version: number; result: { average_percentage: number } }[];
    };
    // The Semester 1 report, then the annual result -- only its current (corrected) version.
    expect(body.results.map((r) => [r.version, r.result.average_percentage])).toEqual([
      [1, 88],
      [2, 83],
    ]);
    const someoneElse = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/students/${ids.s2}/results`,
      studentAuth,
    );
    expect(someoneElse.status).toBe(403);
    const marksRes = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/sections/${ids["8A"]}/subjects/${ids.math}/marks`,
      studentAuth,
    );
    expect(marksRes.status).toBe(403);

    const adminAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const overview = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/years/${tenant.academicYear.id}/overview`,
      adminAuth,
    );
    expect(overview.status).toBe(200);
  });
});
