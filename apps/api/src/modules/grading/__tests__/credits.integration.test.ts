/**
 * Credit hours, course levels and the weighted GPA (000253) end to end, against a real migrated
 * database with RLS armed: subject config read/write, section overrides and year copies carrying
 * the fields, snapshots at finalization, and the figures on results, certificates and transcripts.
 *
 * Grade 11 shows its result as a GPA out of 4 (A 4, B 3, C 2, D 1, F 0; pass mark 60):
 *
 *   Calculus   AP      credits 1, boost 1    coefficient 1
 *   English    -       credits 2, no boost   coefficient 1 (credits differ: a warning)
 *   Chemistry  Honors  credits 1, boost 0.5  coefficient 1
 *
 *   Amal: Calculus 92 (A, 4 -> 5), English 85 (B, 3), Chemistry 75 (C, 2 -> 2.5)
 *     GPA (4 + 3 + 2) / 3 = 3; weighted (5 + 3 + 2.5) / 3 = 3.5; credits 4 attempted, 4 earned
 *   Badr: Calculus 95 (A, 4 -> 5), English 82 (B, 3), Chemistry 40 (F, failed: 0 stays 0)
 *     GPA 7 / 3 = 2.33; weighted 8 / 3 = 2.67; credits 4 attempted, 3 earned
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/credits.integration.test.ts
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
import { getCertificate, issueCertificates } from "../certificate-service";
import {
  createScale,
  createSectionOverride,
  createSubjectConfig,
  getConfigView,
  setYearGradingStatus,
  updateSubjectConfig,
  upsertProgram,
} from "../config-service";
import { copyYearConfiguration } from "../copy-year-service";
import { getMarkSheet, saveMarks } from "../marks-service";
import {
  computationView,
  computeSection,
  finalizeSection,
  readFinalizationResults,
} from "../results-service";
import { issueTranscript, transcriptReadiness } from "../transcript-service";

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

const adminAuth = (): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: tenant.users.ORG_ADMIN.id,
  roles: [ROLES.ORG_ADMIN],
});

async function call(
  method: string,
  path: string,
  auth: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await authenticatedRequest(
    harness!,
    method,
    path,
    auth,
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    return String((error as { code?: string }).code ?? error);
  }
  return "RESOLVED";
}

/** One final exam out of 100: the score is the subject's percentage. */
function input(overrides: Partial<SubjectConfigInput> = {}): SubjectConfigInput {
  return {
    requirement: "mandatory",
    include_in_average: true,
    include_on_certificate: true,
    average_weight: 1,
    grading_method: "weighted",
    max_marks: 100,
    pass_percentage: 60,
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
    ...overrides,
  };
}

async function recordFinal(subjectId: string, scores: Record<string, number>) {
  const sheet = await admin((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, subjectId));
  const finalId = sheet.assessments.find((assessment) => assessment.name === "Final")!.id;
  await admin((tx) =>
    saveMarks(
      tx,
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      ids.section!,
      subjectId,
      Object.entries(scores).map(([studentKey, score]) => ({
        assessment_id: finalId,
        student_id: ids[studentKey]!,
        attempt: 1 as const,
        status: "graded" as const,
        score,
        remarks: null,
      })),
    ),
  );
}

describeDb("credits, course levels and the weighted GPA", () => {
  test("setup: a GPA grade with an AP, a plain and an Honors subject", async () => {
    ids.calculus = (
      await createSubject(db.sql, tenant.schoolId, { code: "CALC", name: "Calculus" })
    ).id;
    ids.english = (
      await createSubject(db.sql, tenant.schoolId, { code: "ENG", name: "English" })
    ).id;
    ids.chemistry = (
      await createSubject(db.sql, tenant.schoolId, { code: "CHEM", name: "Chemistry" })
    ).id;
    for (const [key, name] of [
      ["amal", "Amal"],
      ["badr", "Badr"],
    ] as const) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[key] = student.id;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }

    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 11",
        sort_order: 11,
      });
      ids.grade = grade.id;
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "American",
        bands: [
          { label: "A", min_percentage: 90, gpa_points: 4 },
          { label: "B", min_percentage: 80, gpa_points: 3 },
          { label: "C", min_percentage: 70, gpa_points: 2 },
          { label: "D", min_percentage: 60, gpa_points: 1 },
          { label: "F", min_percentage: 0, gpa_points: 0 },
        ],
      });
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        grade_scale_id: scale.id,
        mark_approval_required: false,
        result_format: "gpa",
        result_scale_max: 4,
      });
      const target = (subjectId: string) => ({
        yearId: tenant.academicYear.id,
        gradeLevelId: grade.id,
        sectionId: null,
        subjectId,
      });
      const userId = tenant.users.ORG_ADMIN.id;
      const calculus = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        target(ids.calculus!),
        input({ credits: 1, course_level: "AP", gpa_boost: 1 }),
      );
      ids.calculusConfig = calculus.config.id;
      expect(calculus.config).toMatchObject({ credits: 1, course_level: "AP", gpa_boost: 1 });
      expect(calculus.config.issues).toEqual([]);

      // English is created without the new fields: no credits, no level, no boost.
      const english = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        target(ids.english!),
        input(),
      );
      ids.englishConfig = english.config.id;
      expect(english.config).toMatchObject({ credits: null, course_level: null, gpa_boost: 0 });

      const chemistry = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        target(ids.chemistry!),
        input({ credits: 1, course_level: "Honors", gpa_boost: 0.5 }),
      );
      ids.chemistryConfig = chemistry.config.id;

      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "11A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.amal!);
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.badr!);
      ids.section2 = (
        await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: grade.id,
          name: "11B",
        })
      ).id;
    });
  });

  test("the config API reads and writes the fields; credits unlike the coefficient warn", async () => {
    const path = `/api/grading/subject-configs/${ids.englishConfig}`;
    const current = await call("GET", path, adminAuth());
    expect(current.status).toBe(200);
    const body = { ...input({ credits: 2 }), expected_updated_at: current.body.updated_at };
    const saved = await call("PUT", path, adminAuth(), body);
    expect(saved.status).toBe(200);
    const config = (saved.body as { config: Record<string, unknown> }).config;
    expect(config).toMatchObject({ credits: 2, course_level: null, gpa_boost: 0 });
    expect(config.issues as { code: string; severity: string }[]).toEqual([
      expect.objectContaining({ code: "CREDITS_DIFFER_FROM_COEFFICIENT", severity: "warning" }),
    ]);

    // Out of range, or a label longer than 40 characters: rejected before reaching the database.
    for (const bad of [{ gpa_boost: 6 }, { credits: -1 }, { course_level: "x".repeat(41) }]) {
      const rejected = await call("PUT", path, adminAuth(), { ...input(), ...bad });
      expect(rejected.status).toBe(400);
    }
  });

  test("a section override and a copied year keep the credits, level and boost", async () => {
    const override = await admin((tx) =>
      createSectionOverride(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.section2!,
        ids.calculus!,
        "customize",
      ),
    );
    expect(override.config).toMatchObject({ credits: 1, course_level: "AP", gpa_boost: 1 });

    const nextYear = new Date().getFullYear() + 1;
    const [year2] = await admin(
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${`AY2-${tenant.schoolSlug}`}, 'Next year',
                ${`${nextYear}-01-01`}::date, ${`${nextYear}-12-31`}::date, 'planned')
        RETURNING id
      `,
    );
    await admin((tx) =>
      copyYearConfiguration(tx, tenant.schoolId, tenant.academicYear.id, year2!.id, {
        includeTeacherAssignments: false,
      }),
    );
    const copied = await db.sql<
      { section_id: string | null; credits: string; course_level: string; gpa_boost: string }[]
    >`
      SELECT section_id, credits, course_level, gpa_boost FROM app.subject_configs
      WHERE school_id = ${tenant.schoolId}::uuid AND academic_year_id = ${year2!.id}::uuid
        AND subject_id = ${ids.calculus!}::uuid
      ORDER BY section_id NULLS FIRST
    `;
    expect(copied).toHaveLength(2);
    for (const row of copied) {
      expect([Number(row.credits), row.course_level, Number(row.gpa_boost)]).toEqual([1, "AP", 1]);
    }
  });

  test("the preview and finalized results carry the weighted GPA and credits", async () => {
    await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );
    await recordFinal(ids.calculus!, { amal: 92, badr: 95 });
    await recordFinal(ids.english!, { amal: 85, badr: 82 });
    await recordFinal(ids.chemistry!, { amal: 75, badr: 40 });

    const preview = computationView(
      await admin((tx) => computeSection(tx, tenant.schoolId, ids.section!, null)),
    );
    const amalPreview = preview.students.find((student) => student.student_id === ids.amal)!;
    expect(amalPreview).toMatchObject({
      weighted_gpa: 3.5,
      credits_attempted: 4,
      credits_earned: 4,
    });
    expect(amalPreview.subjects.find((s) => s.subject_id === ids.calculus)).toMatchObject({
      credits: 1,
      course_level: "AP",
    });

    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, null, {
        allowIncomplete: false,
      }),
    );
    ids.finalization = finalization.id;
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, finalization.id),
    );
    const amal = results.find((result) => result.student_id === ids.amal)!;
    const badr = results.find((result) => result.student_id === ids.badr)!;
    expect(amal.result_display).toEqual({ format: "gpa", value: 3, max: 4 });
    expect(amal).toMatchObject({ weighted_gpa: 3.5, credits_attempted: 4, credits_earned: 4 });
    expect(badr.result_display).toEqual({ format: "gpa", value: 2.33, max: 4 });
    expect(badr).toMatchObject({ weighted_gpa: 2.67, credits_attempted: 4, credits_earned: 3 });

    const subject = (subjectId: string) =>
      badr.subjects.find((candidate) => candidate.subject_id === subjectId)!;
    expect(subject(ids.calculus!)).toMatchObject({
      gpa_points: 4,
      weighted_gpa_points: 5,
      credits: 1,
      course_level: "AP",
    });
    expect(subject(ids.english!)).toMatchObject({
      gpa_points: 3,
      weighted_gpa_points: null,
      credits: 2,
      course_level: null,
    });
    // Failed: the Honors boost is not added.
    expect(subject(ids.chemistry!)).toMatchObject({
      passed: false,
      gpa_points: 0,
      weighted_gpa_points: 0,
      course_level: "Honors",
    });

    // A student reads the same figures over HTTP.
    const own = await call("GET", `/api/grading/students/${ids.badr}/results`, adminAuth());
    expect(own.status).toBe(200);
    const [latest] = own.body.results as { result: Record<string, unknown> }[];
    expect(latest!.result).toMatchObject({ weighted_gpa: 2.67, credits_earned: 3 });
  });

  test("a finalized result is a snapshot: changing the boost later leaves it alone", async () => {
    const view = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.calculusConfig!));
    const change = () =>
      admin((tx) =>
        updateSubjectConfig(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          ids.calculusConfig!,
          input({
            credits: 1,
            course_level: "AP",
            gpa_boost: 2,
            categories: view.categories.map((category) => ({
              ref: category.id,
              name: category.name,
              kind: category.kind,
              scope: category.scope,
              weight: category.weight,
              aggregation: category.aggregation,
              drop_lowest: category.drop_lowest,
              sort_order: category.sort_order,
            })),
            assessments: view.assessments.map((assessment) => ({
              id: assessment.id,
              category_ref: assessment.category_id,
              term_id: assessment.term_id,
              name: assessment.name,
              max_marks: assessment.max_marks,
              weight: assessment.weight,
              is_mandatory: assessment.is_mandatory,
              assessment_date: assessment.assessment_date,
              due_date: assessment.due_date,
              sort_order: assessment.sort_order,
            })),
          }),
          { confirmImpact: false },
        ),
      );
    // The boost changes what recorded marks are worth: the impact has to be confirmed.
    expect(await codeOf(change())).toBe(ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED);

    await db.sql`
      UPDATE app.subject_configs SET gpa_boost = 2 WHERE id = ${ids.calculusConfig!}::uuid
    `;
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, ids.finalization!, { studentId: ids.amal! }),
    );
    expect(results[0]!.weighted_gpa).toBe(3.5);
    await db.sql`
      UPDATE app.subject_configs SET gpa_boost = 1 WHERE id = ${ids.calculusConfig!}::uuid
    `;
  });

  test("certificates and transcripts show the course levels, credits and weighted GPA", async () => {
    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.finalization!, [
        ids.amal!,
      ]),
    );
    const certificate = await admin((tx) => getCertificate(tx, tenant.schoolId, issued.issued[0]!));
    expect(certificate.content.overall).toMatchObject({
      weighted_gpa: 3.5,
      credits_attempted: 4,
      credits_earned: 4,
    });
    const calculus = certificate.content.subjects.find((s) => s.code === "CALC")!;
    expect(calculus).toMatchObject({ credits: 1, course_level: "AP", weighted_gpa_points: 5 });
    const english = certificate.content.subjects.find((s) => s.code === "ENG")!;
    expect(english).toMatchObject({ credits: 2 });
    expect("course_level" in english).toBe(false);
    expect("weighted_gpa_points" in english).toBe(false);

    const readiness = await admin((tx) => transcriptReadiness(tx, tenant.schoolId, ids.badr!));
    expect(readiness.cumulative).toMatchObject({
      gpa: 2.33,
      weighted_gpa: 2.67,
      credits_attempted: 4,
      credits_earned: 3,
    });
    const transcript = await admin((tx) =>
      issueTranscript(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.badr!),
    );
    expect(transcript.content.cumulative).toMatchObject({ weighted_gpa: 2.67, credits_earned: 3 });
    const [year] = transcript.content.years;
    expect(year!.overall).toMatchObject({
      weighted_gpa: 2.67,
      credits_attempted: 4,
      credits_earned: 3,
    });
    expect(year!.subjects.find((s) => s.code === "CHEM")).toMatchObject({
      credits: 1,
      course_level: "Honors",
      weighted_gpa_points: 0,
    });
  });

  test("results finalized before 000253 read back without credits or a weighted GPA", async () => {
    await db.sql`
      UPDATE app.student_overall_results
      SET weighted_result_value = NULL, credits_attempted = NULL, credits_earned = NULL
      WHERE finalization_id = ${ids.finalization!}::uuid
    `;
    await db.sql`
      UPDATE app.student_subject_results
      SET credits = NULL, course_level = NULL, gpa_boost = NULL, weighted_gpa_points = NULL
      WHERE finalization_id = ${ids.finalization!}::uuid
    `;
    const [amal] = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, ids.finalization!, { studentId: ids.amal! }),
    );
    expect(amal).toMatchObject({
      weighted_gpa: null,
      credits_attempted: null,
      credits_earned: null,
    });
    for (const subject of amal!.subjects) {
      expect(subject).toMatchObject({
        credits: null,
        course_level: null,
        weighted_gpa_points: null,
      });
    }
  });

  test("the database refuses a weighted GPA on a result that is not a GPA", async () => {
    let message = "RESOLVED";
    try {
      await db.sql`
        UPDATE app.student_overall_results SET weighted_result_value = 3, result_format = 'percentage',
          result_scale_max = 100
        WHERE finalization_id = ${ids.finalization!}::uuid
      `;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ck_student_overall_results_weighted_result_value");
  });
});
