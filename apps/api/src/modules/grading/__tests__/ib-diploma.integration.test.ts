/**
 * IB Diploma total (000262) end to end, against a real migrated database with RLS armed: the
 * points_total program settings and their defaults, core grade entry and who may do it, the total
 * on previews, finalized results, class rank, certificates and transcripts, a correction picking up
 * changed core grades, the predicted total and its visibility. Later tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/ib-diploma.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
import { DEFAULT_DIPLOMA_CONFIG } from "@studafy/grading-engine";
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
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../academics/section-service";
import { getCertificate, issueCertificates } from "../certificate-service";
import {
  createScale,
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import { fromEngineDiplomaConfig } from "../diploma-config";
import { getMarkSheet, saveMarks } from "../marks-service";
import { savePredictedGrades } from "../predicted-grades-service";
import { correctFinalization, finalizeSection } from "../results-service";
import { issueTranscript } from "../transcript-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { DiplomaResultView } from "../diploma-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let other: TenantFixture;
const ids = {} as Record<string, string>;
const users = {} as Record<string, string>;

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

const as = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId }, fn);
const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.users.ORG_ADMIN.id, fn);

const adminAuth = (): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: tenant.users.ORG_ADMIN.id,
  roles: [ROLES.ORG_ADMIN],
});
const teacherAuth = (userId: string): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId,
  roles: [ROLES.INSTRUCTOR],
});
const studentAuth = (key: string): TestAuthContext => ({
  schoolId: tenant.schoolId,
  userId: users[key]!,
  roles: [ROLES.STUDENT],
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

/** One annual final exam out of 100; the course level (HL/SL) feeds the level conditions. */
function input(courseLevel: string): SubjectConfigInput {
  return {
    requirement: "mandatory",
    include_in_average: true,
    include_on_certificate: true,
    average_weight: 1,
    course_level: courseLevel,
    grading_method: "weighted",
    max_marks: 100,
    pass_percentage: 40,
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
  };
}

async function recordFinal(subject: string, scores: Record<string, number>) {
  const sheet = await admin((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, ids[subject]!));
  const assessment = sheet.assessments.find((candidate) => candidate.name === "Final")!.id;
  await admin((tx) =>
    saveMarks(
      tx,
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      ids.section!,
      ids[subject]!,
      Object.entries(scores).map(([studentKey, score]) => ({
        assessment_id: assessment,
        student_id: ids[studentKey]!,
        attempt: 1 as const,
        status: "graded" as const,
        score,
        remarks: null,
      })),
    ),
  );
}

const programPath = () => `/api/grading/years/${tenant.academicYear.id}/programs/${ids.grade}`;
const corePath = () => `/api/grading/sections/${ids.section}/diploma-core`;

/** Three counted subjects, the IB matrix, and conditions scaled to three subjects. */
const threeSubjectConfig = () => ({
  ...fromEngineDiplomaConfig(DEFAULT_DIPLOMA_CONFIG),
  counted_subjects: 3,
  conditions: [
    { type: "min_total", value: 12, points: null, grade: null, level: null, best_of: null },
    { type: "cas_complete", value: null, points: null, grade: null, level: null, best_of: null },
    { type: "core_grade_not", value: null, points: null, grade: "E", level: null, best_of: null },
    { type: "min_level_points", value: 10, points: null, grade: null, level: "HL", best_of: 2 },
  ],
});

interface DiplomaRow {
  student_id: string;
  result_display: { format: string; value: number | null; max: number } | null;
  diploma: DiplomaResultView | null;
  class_rank: { rank: number | null } | null;
}

describeDb("IB Diploma total", () => {
  test("setup: DP2 on the IB 1-7 scale, three subjects, a section of two students", async () => {
    for (const [key, code] of [
      ["math", "MAA"],
      ["physics", "PHY"],
      ["english", "ENG"],
    ] as const) {
      ids[key] = (await createSubject(db.sql, tenant.schoolId, { code, name: code })).id;
    }
    for (const name of ["Amal", "Badr"]) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[name.toLowerCase()] = student.id;
      users[name.toLowerCase()] = student.userId;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
    const outsider = await createTeacher(db.sql, tenant.schoolId);
    await assignRole(db.sql, tenant.schoolId, outsider.userId, ROLES.INSTRUCTOR);
    users.outsider = outsider.userId;

    await admin(async (tx) => {
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "IB DP 1-7",
        bands: [
          { label: "7", min_percentage: 80, gpa_points: 7 },
          { label: "6", min_percentage: 70, gpa_points: 6 },
          { label: "5", min_percentage: 60, gpa_points: 5 },
          { label: "4", min_percentage: 50, gpa_points: 4 },
          { label: "3", min_percentage: 40, gpa_points: 3 },
          { label: "2", min_percentage: 25, gpa_points: 2 },
          { label: "1", min_percentage: 0, gpa_points: 1 },
        ],
      });
      ids.grade = (await createGradeLevel(tx, tenant.schoolId, { name: "DP2", sort_order: 12 })).id;
      ids.percentageGrade = (
        await createGradeLevel(tx, tenant.schoolId, { name: "Grade 10", sort_order: 10 })
      ).id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade, {
        grade_scale_id: scale.id,
        mark_approval_required: false,
      });
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.percentageGrade, {
        mark_approval_required: false,
      });
      for (const [subject, level] of [
        ["math", "HL"],
        ["physics", "HL"],
        ["english", "SL"],
      ] as const) {
        await createSubjectConfig(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          {
            yearId: tenant.academicYear.id,
            gradeLevelId: ids.grade,
            sectionId: null,
            subjectId: ids[subject]!,
          },
          input(level),
        );
      }
      // Grade 10 stays on percentages; a year cannot be published with a grade without subjects.
      await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids.percentageGrade,
          sectionId: null,
          subjectId: ids.math!,
        },
        input("SL"),
      );
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: ids.grade,
        name: "DP2 A",
      });
      ids.section = section.id;
      const other10 = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: ids.percentageGrade,
        name: "10A",
      });
      ids.percentageSection = other10.id;
      for (const key of ["amal", "badr"]) {
        await placeStudentInSection(tx, tenant.schoolId, section.id, ids[key]!);
      }
      await createTeacherAssignment(tx, tenant.schoolId, {
        section_id: section.id,
        subject_id: ids.english!,
        teacher_id: tenant.teachers[0]!.id,
      });
    });
  });

  test("a grade switching to points_total gets the IB defaults; bad rules are refused", async () => {
    const switched = await call("PUT", programPath(), adminAuth(), {
      result_format: "points_total",
      result_scale_max: 45,
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toMatchObject({ result_format: "points_total", result_scale_max: 45 });
    const defaults = switched.body.diploma_config as ReturnType<typeof threeSubjectConfig>;
    expect(defaults.counted_subjects).toBe(6);
    expect(defaults.core_matrix).toHaveLength(25);
    expect(defaults.core_matrix).toContainEqual({ tok: "A", ee: "A", points: 3 });
    expect(defaults.conditions).toContainEqual(
      expect.objectContaining({ type: "min_total", value: 24 }),
    );

    // An incomplete matrix is refused by the engine's validation; a bad shape by the schema.
    const incomplete = await call("PUT", programPath(), adminAuth(), {
      diploma_config: { ...defaults, core_matrix: defaults.core_matrix.slice(1) },
    });
    expect(incomplete.status).toBe(400);
    expect(JSON.stringify(incomplete.body)).toContain("25 TOK and EE grade pairs");
    const shape = await call("PUT", programPath(), adminAuth(), {
      diploma_config: { ...defaults, counted_subjects: 0 },
    });
    expect(shape.status).toBe(400);

    const saved = await call("PUT", programPath(), adminAuth(), {
      diploma_config: threeSubjectConfig(),
    });
    expect(saved.status).toBe(200);
    expect((saved.body.diploma_config as { counted_subjects: number }).counted_subjects).toBe(3);

    // Ranking by the total needs a points_total grade.
    const refused = await call(
      "PUT",
      `/api/grading/years/${tenant.academicYear.id}/programs/${ids.percentageGrade}`,
      adminAuth(),
      { rank_enabled: true, rank_basis: "points_total" },
    );
    expect(refused.status).toBe(400);
    const ranked = await call("PUT", programPath(), adminAuth(), {
      rank_enabled: true,
      rank_basis: "points_total",
      rank_visibility: "students_and_parents",
    });
    expect(ranked.status).toBe(200);

    // Other formats carry no diploma rules, in the API and in the database.
    const [percentage] = await db.sql<{ diploma_config: unknown }[]>`
      SELECT diploma_config FROM app.grade_programs WHERE grade_level_id = ${ids.percentageGrade}::uuid
    `;
    expect(percentage!.diploma_config).toBeNull();
    let message = "RESOLVED";
    try {
      await db.sql`
        UPDATE app.grade_programs SET diploma_config = '{}'::jsonb
        WHERE grade_level_id = ${ids.percentageGrade}::uuid
      `;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ck_grade_programs_diploma_config");

    await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );
    // Amal: 7 + 6 + 5 = 18; Badr: 3 + 4 + 2 = 9.
    await recordFinal("math", { amal: 85, badr: 45 });
    await recordFinal("physics", { amal: 72, badr: 55 });
    await recordFinal("english", { amal: 65, badr: 30 });
  });

  test("a teacher of the section enters core grades; others may not", async () => {
    const teacher = teacherAuth(tenant.teachers[0]!.userId);
    const saved = await call("PUT", corePath(), teacher, {
      kind: "final",
      grades: [
        { student_id: ids.amal, tok_grade: "B", ee_grade: "A", cas_complete: true },
        { student_id: ids.badr, tok_grade: "C", ee_grade: "C", cas_complete: true },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, editable: true, predicted_enabled: false });
    const amal = (saved.body.students as Record<string, unknown>[]).find(
      (student) => student.student_id === ids.amal,
    );
    expect(amal!.final).toMatchObject({ tok_grade: "B", ee_grade: "A", cas_complete: true });
    expect(amal!.predicted).toBeNull();

    const outsider = await call("GET", corePath(), teacherAuth(users.outsider!));
    expect(outsider.status).toBe(403);
    const student = await call("PUT", corePath(), studentAuth("amal"), {
      kind: "final",
      grades: [{ student_id: ids.amal, tok_grade: "A", ee_grade: "A", cas_complete: true }],
    });
    expect(student.status).toBe(403);

    // Predicted core grades follow predicted grades, which are off.
    const predicted = await call("PUT", corePath(), adminAuth(), {
      kind: "predicted",
      grades: [{ student_id: ids.amal, tok_grade: "A", ee_grade: "A", cas_complete: true }],
    });
    expect(predicted.status).toBe(409);
    expect(JSON.stringify(predicted.body)).toContain("PREDICTED_GRADES_DISABLED");

    // A grade that is not on the points total takes no core grades.
    const percentage = await call(
      "PUT",
      `/api/grading/sections/${ids.percentageSection}/diploma-core`,
      adminAuth(),
      {
        kind: "final",
        grades: [{ student_id: ids.amal, tok_grade: "A", ee_grade: "A", cas_complete: true }],
      },
    );
    expect(percentage.status).toBe(409);
    expect(JSON.stringify(percentage.body)).toContain("DIPLOMA_TOTAL_DISABLED");

    const outside = await call("PUT", corePath(), adminAuth(), {
      kind: "final",
      grades: [
        { student_id: tenant.students[0]!.id, tok_grade: "A", ee_grade: null, cas_complete: null },
      ],
    });
    expect(outside.status).toBe(400);

    const [audit] = await db.sql<{ new_values: { kind: string } }[]>`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'student_diploma_core_grades'
        AND action = 'update'
      ORDER BY created_at DESC LIMIT 1
    `;
    expect(audit!.new_values.kind).toBe("final");

    // RLS: final core grades are staff data; the student reads none of them directly.
    const own = await as(users.amal!, (tx) => tx`SELECT 1 FROM app.student_diploma_core_grades`);
    expect(own).toHaveLength(0);
  });

  test("the preview and the finalized result carry the total, core points and status", async () => {
    const preview = await call(
      "GET",
      `/api/grading/sections/${ids.section}/results/preview`,
      adminAuth(),
    );
    expect(preview.status).toBe(200);
    const previewed = (preview.body.students as DiplomaRow[]).find(
      (row) => row.student_id === ids.amal,
    )!;
    expect(previewed.result_display).toEqual({ format: "points_total", value: 21, max: 45 });
    expect(previewed.diploma).toMatchObject({
      status: "awarded",
      subject_points: 18,
      core_points: 3,
      tok_grade: "B",
      ee_grade: "A",
    });

    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, null, {
        allowIncomplete: false,
      }),
    );
    ids.final = finalization.id;
    const detail = await call("GET", `/api/grading/finalizations/${ids.final}`, adminAuth());
    expect(detail.status).toBe(200);
    const rows = new Map((detail.body.results as DiplomaRow[]).map((row) => [row.student_id, row]));
    expect(rows.get(ids.amal!)!.diploma).toMatchObject({ status: "awarded", total: 21 });
    const badr = rows.get(ids.badr!)!;
    // 9 subject points + 1 core point (C/C): below 12, and only 7 points at HL.
    expect(badr.result_display).toEqual({ format: "points_total", value: 10, max: 45 });
    expect(badr.diploma!.status).toBe("not_awarded");
    expect(badr.diploma!.failing_conditions.map((condition) => condition.code).sort()).toEqual([
      "LEVEL_POINTS",
      "MIN_TOTAL",
    ]);
    // Ranked by the total.
    expect(rows.get(ids.amal!)!.class_rank).toMatchObject({ rank: 1 });
    expect(badr.class_rank).toMatchObject({ rank: 2 });

    // The student reads their own total, core points and status.
    const own = await call("GET", `/api/grading/students/${ids.badr}/results`, studentAuth("badr"));
    expect(own.status).toBe(200);
    const [latest] = own.body.results as { result: DiplomaRow }[];
    expect(latest!.result.diploma).toMatchObject({ total: 10, core_points: 1 });

    // The snapshot is on the row: changing the rules later does not change it.
    const [stored] = await db.sql<{ result_value: string; diploma_result: { total: number } }[]>`
      SELECT result_value, diploma_result FROM app.student_overall_results
      WHERE finalization_id = ${ids.final}::uuid AND student_id = ${ids.amal}::uuid
    `;
    expect(Number(stored!.result_value)).toBe(21);
    expect(stored!.diploma_result.total).toBe(21);
  });

  test("certificates and transcripts keep the diploma outcome as issued", async () => {
    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.final!, [ids.badr!]),
    );
    const certificate = await admin((tx) => getCertificate(tx, tenant.schoolId, issued.issued[0]!));
    expect(certificate.content.overall.diploma).toMatchObject({
      status: "not_awarded",
      total: 10,
      max: 45,
    });
    const transcript = await admin((tx) =>
      issueTranscript(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.amal!),
    );
    expect(transcript.content.years[0]!.overall.diploma).toMatchObject({
      status: "awarded",
      total: 21,
    });
  });

  test("a correction picks up core grades recorded after finalization", async () => {
    const changed = await call("PUT", corePath(), adminAuth(), {
      kind: "final",
      grades: [{ student_id: ids.amal, tok_grade: "B", ee_grade: "A", cas_complete: false }],
    });
    expect(changed.status).toBe(200);
    // The finalized result is a snapshot until corrected.
    const before = await call("GET", `/api/grading/finalizations/${ids.final}`, adminAuth());
    const amalBefore = (before.body.results as DiplomaRow[]).find(
      (row) => row.student_id === ids.amal,
    )!;
    expect(amalBefore.diploma!.status).toBe("awarded");

    const corrected = await admin((tx) =>
      correctFinalization(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.final!, {
        reason: "CAS not completed",
        marks: [],
        allow_incomplete: false,
      }),
    );
    const after = await call("GET", `/api/grading/finalizations/${corrected.id}`, adminAuth());
    const amal = (after.body.results as DiplomaRow[]).find((row) => row.student_id === ids.amal)!;
    expect(amal.diploma).toMatchObject({ status: "not_awarded", total: 21, cas_complete: false });
    expect(amal.diploma!.failing_conditions.map((condition) => condition.code)).toEqual([
      "CAS_INCOMPLETE",
    ]);
  });

  test("the predicted total, and who may see it", async () => {
    const path = `/api/grading/students/${ids.amal}/diploma`;
    // Predicted grades off: no prediction, but staff still see the final core grades.
    const off = await call("GET", path, adminAuth());
    expect(off.status).toBe(200);
    const [offYear] = off.body.years as Record<string, unknown>[];
    expect(offYear).toMatchObject({ predicted_result: null, can_edit: true });
    expect(offYear!.final).toMatchObject({ tok_grade: "B", cas_complete: false });

    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        predicted_grades_enabled: true,
        predicted_grades_visibility: "students_and_parents",
      }),
    );
    for (const [subject, label] of [
      ["math", "7"],
      ["physics", "7"],
      ["english", "6"],
    ] as const) {
      await admin((tx) =>
        savePredictedGrades(
          tx,
          tenant.schoolId,
          tenant.users.ORG_ADMIN.id,
          ids.section!,
          ids[subject]!,
          null,
          [{ student_id: ids.amal!, grade_label: label }],
        ),
      );
    }
    const core = await call("PUT", corePath(), teacherAuth(tenant.teachers[0]!.userId), {
      kind: "predicted",
      grades: [{ student_id: ids.amal, tok_grade: "A", ee_grade: "B", cas_complete: true }],
    });
    expect(core.status).toBe(200);

    const mine = await call("GET", path, studentAuth("amal"));
    expect(mine.status).toBe(200);
    const [year] = mine.body.years as Record<string, unknown>[];
    // 7 + 7 + 6 + 3 core points (A/B).
    expect(year!.predicted_result).toMatchObject({ status: "awarded", total: 23, core_points: 3 });
    expect(year!.predicted).toMatchObject({ tok_grade: "A", ee_grade: "B" });
    // Final core grades reach the student only on finalized results.
    expect(year!.final).toBeNull();
    expect(year!.can_edit).toBe(false);

    // Staff-only predictions hide the predicted total from the student.
    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        predicted_grades_visibility: "staff",
      }),
    );
    const hidden = await call("GET", path, studentAuth("amal"));
    const [hiddenYear] = hidden.body.years as Record<string, unknown>[];
    expect(hiddenYear).toMatchObject({ predicted_result: null, predicted: null, final: null });
    // Another student's diploma is not theirs to read.
    const sibling = await call(
      "GET",
      `/api/grading/students/${ids.badr}/diploma`,
      studentAuth("amal"),
    );
    expect(sibling.status).toBe(403);
  });

  test("another school sees nothing", async () => {
    const auth: TestAuthContext = {
      schoolId: other.schoolId,
      userId: other.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const section = await call("GET", corePath(), auth);
    expect(section.status).toBe(404);
    const student = await call("GET", `/api/grading/students/${ids.amal}/diploma`, auth);
    expect(student.status).toBe(404);
  });
});
