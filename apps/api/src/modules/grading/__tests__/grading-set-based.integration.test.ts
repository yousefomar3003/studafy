/**
 * Set-based grading reads, on a school big enough to show it: four grades (one without sections),
 * eight sections, seven subjects (weighted, three-term, total-points, optional, elective, a
 * zero-policy subject with retakes, a section-only subject), overrides (customized and outdated,
 * excluded), a section assessment, a teacher's proposed assessment, exemptions, missing / absent /
 * excused marks and retakes, approved and pending sheets, finalized annual and term results,
 * issued, blocked and needs-reissue certificates.
 *
 * Every read is compared with the per-row reference implementation (legacy-grading.ts) for exact
 * equality, and the statements each read sends are counted to show the N+1 is gone.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/grading-set-based.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  createFullTenant,
  createStudent,
  createSubject,
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
import { certificateReadiness, issueCertificates } from "../certificate-service";
import {
  collectPublishIssues,
  createScale,
  createSectionOverride,
  createSubjectConfig,
  createTeacherAssignment,
  getConfigView,
  listGradeConfigs,
  setSubjectEnrollment,
  setYearGradingStatus,
  updateSubjectConfig,
  upsertProgram,
} from "../config-service";
import { addSectionAssessment, getMarkSheet, listMyAssignments } from "../marks-service";
import { getGradingOverview } from "../overview-service";
import {
  computeSection,
  correctFinalization,
  finalizeSection,
  readFinalizationResults,
} from "../results-service";

import { expectSameAsLegacy, normalizeAssignments } from "./characterize";
import {
  legacyCollectPublishIssues,
  legacyComputeSection,
  legacyGetGradingOverview,
  legacyListMyAssignments,
} from "./legacy-grading";

import type { TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let counted: ReturnType<typeof postgres> | undefined;
let statements = 0;
let tenant: TenantFixture;
const ids = {} as Record<string, string>;
const sections: { id: string; name: string; grade: string }[] = [];

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  // Same database, but every statement sent is counted.
  counted = postgres(db.url, {
    max: 1,
    prepare: false,
    debug: () => {
      statements += 1;
    },
  });
}, 120_000);

afterAll(async () => {
  if (client) await client.end({ timeout: 1 });
  if (counted) await counted.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const as = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId }, fn);
const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.users.ORG_ADMIN.id, fn);
const teacher = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.teachers[0]!.userId, fn);

/** Statements one call sends (the transaction's own BEGIN / set_config / COMMIT excluded). */
async function countStatements<T>(
  userId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<{ value: T; statements: number }> {
  const baseline = await (async () => {
    statements = 0;
    await withTenantTx(counted!, { schoolId: tenant.schoolId, userId }, async () => undefined);
    return statements;
  })();
  statements = 0;
  const value = await withTenantTx(counted!, { schoolId: tenant.schoolId, userId }, fn);
  return { value, statements: statements - baseline };
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

const inputs = {
  math: () =>
    baseInput({
      teachers_can_add_assessments: true,
      categories: [
        category("homework", 20, { kind: "homework", drop_lowest: 1 }),
        category("midterm", 30, { kind: "midterm" }),
        category("final", 50, { kind: "final_exam" }),
      ],
      assessments: [
        assessment("HW1", "homework", 10),
        assessment("HW2", "homework", 10),
        assessment("HW3", "homework", 10, { is_mandatory: false }),
        assessment("Midterm", "midterm", 50),
        assessment("Final", "final", 100),
      ],
    }),
  science: () =>
    baseInput({
      final_exam_pass_percentage: 40,
      term_weights: [
        { term_id: ids.term1!, weight: 30 },
        { term_id: ids.term2!, weight: 30 },
        { term_id: ids.term3!, weight: 20 },
      ],
      categories: [
        category("exams", 70, { scope: "term", kind: "exam" }),
        category("labs", 30, { scope: "term", kind: "practical" }),
        category("final", 20, { scope: "annual", kind: "final_exam" }),
      ],
      assessments: [
        ...[1, 2, 3].flatMap((n) => [
          assessment(`Exam T${n}`, "exams", 40, { term_id: ids[`term${n}`]! }),
          assessment(`Lab T${n}`, "labs", 20, { term_id: ids[`term${n}`]! }),
        ]),
        assessment("Annual final", "final", 100),
      ],
    }),
  arabic: () =>
    baseInput({
      grading_method: "total_points",
      rounding_decimals: 1,
      rounding_mode: "half_even",
      categories: [category("tests", null), category("final", null, { kind: "final_exam" })],
      assessments: [
        assessment("Test 1", "tests", 25),
        assessment("Test 2", "tests", 25, { term_id: null }),
        assessment("Final", "final", 50),
      ],
    }),
  art: () =>
    baseInput({
      requirement: "optional",
      include_in_average: false,
      categories: [category("portfolio", 100, { kind: "project" })],
      assessments: [assessment("Portfolio", "portfolio", 40)],
    }),
  french: () =>
    baseInput({
      requirement: "elective",
      average_weight: 0.5,
      include_on_certificate: false,
      categories: [category("oral", 40), category("written", 60)],
      assessments: [assessment("Oral", "oral", 20), assessment("Written", "written", 80)],
    }),
  pe: () =>
    baseInput({
      missing_mark_policy: "zero",
      absent_policy: "zero",
      retake_policy: "highest",
      categories: [category("fitness", 100, { kind: "practical" })],
      assessments: [assessment("Run", "fitness", 10), assessment("Swim", "fitness", 10)],
    }),
  music: () =>
    baseInput({
      retake_policy: "capped",
      retake_cap_percentage: 60,
      categories: [category("performance", 100, { kind: "practical" })],
      assessments: [assessment("Recital", "performance", 30)],
    }),
};

/** A deterministic spread of marks: mostly graded, some missing, absent, excused, retaken. */
function markFor(seed: number, maxMarks: number) {
  const roll = seed % 23;
  if (roll === 0) return null; // missing
  if (roll === 1) return { status: "absent", score: null } as const;
  if (roll === 2) return { status: "excused", score: null } as const;
  return { status: "graded", score: Math.round(((seed * 37) % 101) * maxMarks) / 100 } as const;
}

describeDb("set-based grading reads", () => {
  test("seed: grades, sections, subjects, overrides, students, marks, sheets, results", async () => {
    const year = new Date().getFullYear();
    const userId = tenant.users.ORG_ADMIN.id;
    ids.term1 = tenant.term.id;
    const [term2, term3] = await admin(
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.terms (school_id, academic_year_id, code, name, sequence_number, starts_on, ends_on, status)
        VALUES (${tenant.schoolId}, ${tenant.academicYear.id}, ${`T2-${tenant.schoolSlug}`}, 'Term two', 2,
                ${`${year}-07-01`}::date, ${`${year}-09-30`}::date, 'planned'),
               (${tenant.schoolId}, ${tenant.academicYear.id}, ${`T3-${tenant.schoolSlug}`}, 'Term three', 3,
                ${`${year}-10-01`}::date, ${`${year}-12-30`}::date, 'planned')
        RETURNING id
      `,
    );
    ids.term2 = term2!.id;
    ids.term3 = term3!.id;
    for (const [key, code, name] of [
      ["math", "MATH", "Mathematics"],
      ["science", "SCI", "Science"],
      ["arabic", "AR", "Arabic"],
      ["art", "ART", "Art"],
      ["french", "FR", "French"],
      ["pe", "PE", "Physical education"],
      ["music", "MUS", "Music"],
    ] as const) {
      ids[key] = (await createSubject(db.sql, tenant.schoolId, { code, name })).id;
    }
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);

    const layout: Record<string, { sections: string[]; subjects: (keyof typeof inputs)[] }> = {
      "Grade 7": {
        sections: ["7A", "7B", "7C"],
        subjects: ["math", "science", "arabic", "art", "french", "pe"],
      },
      "Grade 8": { sections: ["8A", "8B"], subjects: ["math", "science", "arabic", "art"] },
      "Grade 9": { sections: ["9A", "9B", "9C"], subjects: ["math", "science", "pe", "french"] },
      "Grade 10": { sections: [], subjects: ["math"] },
    };
    await admin(async (tx) => {
      const letters = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Letters",
        bands: [
          { label: "A", min_percentage: 85, gpa_points: 4 },
          { label: "B", min_percentage: 70, gpa_points: 3 },
          { label: "C", min_percentage: 50, gpa_points: 2 },
          { label: "F", min_percentage: 0, gpa_points: 0 },
        ],
      });
      const words = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Words",
        bands: [
          { label: "Excellent", min_percentage: 90, gpa_points: null },
          { label: "Good", min_percentage: 60, gpa_points: null },
          { label: "Weak", min_percentage: 0, gpa_points: null },
        ],
      });
      ids.words = words.id;
      let sort = 7;
      for (const [gradeName, plan] of Object.entries(layout)) {
        const grade = await createGradeLevel(tx, tenant.schoolId, {
          name: gradeName,
          sort_order: sort++,
        });
        ids[gradeName] = grade.id;
        await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
          grade_scale_id: gradeName === "Grade 8" ? null : letters.id,
          max_failed_subjects_for_supplementary: gradeName === "Grade 8" ? 1 : 2,
          mark_approval_required: gradeName !== "Grade 8",
          average_rounding_decimals: gradeName === "Grade 9" ? 1 : 2,
        });
        for (const subject of plan.subjects) {
          const input = inputs[subject]();
          // Grade 8 Arabic grades on its own scale.
          if (gradeName === "Grade 8" && subject === "arabic") input.grade_scale_id = words.id;
          const saved = await createSubjectConfig(
            tx,
            tenant.schoolId,
            userId,
            {
              yearId: tenant.academicYear.id,
              gradeLevelId: grade.id,
              sectionId: null,
              subjectId: ids[subject]!,
            },
            input,
          );
          ids[`${gradeName}/${subject}`] = saved.config.id;
        }
        for (const name of plan.sections) {
          const section = await createSection(tx, tenant.schoolId, {
            academic_year_id: tenant.academicYear.id,
            grade_level_id: grade.id,
            name,
          });
          ids[name] = section.id;
          sections.push({ id: section.id, name, grade: gradeName });
        }
      }
      // 8B teaches Music on its own.
      await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids["Grade 8"]!,
          sectionId: ids["8B"]!,
          subjectId: ids.music!,
        },
        inputs.music(),
      );
    });

    // Overrides: 7B customizes Mathematics (and falls behind the default below), 9C drops Science.
    await admin(async (tx) => {
      await createSectionOverride(tx, tenant.schoolId, userId, ids["7B"]!, ids.math!, "customize");
      await createSectionOverride(tx, tenant.schoolId, userId, ids["9C"]!, ids.science!, "exclude");
    });
    const scienceView = await admin((tx) =>
      getConfigView(tx, tenant.schoolId, ids["Grade 7/science"]!),
    );
    await admin((tx) =>
      addSectionAssessment(tx, tenant.schoolId, userId, ids["7C"]!, ids.science!, {
        category_id: scienceView.categories.find((c) => c.name === "final")!.id,
        term_id: null,
        name: "Field trip report",
        max_marks: 20,
        weight: 1,
        is_mandatory: true,
        assessment_date: null,
        due_date: null,
      }),
    );
    const mathView = await admin((tx) => getConfigView(tx, tenant.schoolId, ids["Grade 7/math"]!));
    await admin((tx) =>
      updateSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        ids["Grade 7/math"]!,
        {
          ...inputs.math(),
          pass_percentage: 55,
          categories: mathView.categories.map((c) => ({ ...c, ref: c.id })),
          assessments: mathView.assessments.map((a) => ({ ...a, category_ref: a.category_id })),
        },
        { confirmImpact: true },
      ),
    );

    // Students: four per section, with optional and elective choices and exemptions.
    let n = 0;
    for (const section of sections) {
      for (let i = 0; i < 4; i++) {
        n += 1;
        const student = await createStudent(db.sql, tenant.schoolId, {
          firstName: `S${String(n).padStart(2, "0")}`,
          lastName: ["Haddad", "Khalil", "Nasser", "Saleh"][i]!,
          admissionNumber: `ADM-${String(n).padStart(3, "0")}`,
        });
        const offers = (subject: keyof typeof inputs) =>
          layout[section.grade]!.subjects.includes(subject);
        await admin(async (tx) => {
          await placeStudentInSection(tx, tenant.schoolId, section.id, student.id);
          if (offers("art") && (i === 0 || i === 2))
            await setSubjectEnrollment(tx, tenant.schoolId, section.id, {
              student_id: student.id,
              subject_id: ids.art!,
              status: i === 0 ? "enrolled" : "exempt",
              reason: i === 0 ? null : "Medical",
            });
          if (offers("french") && i !== 3)
            await setSubjectEnrollment(tx, tenant.schoolId, section.id, {
              student_id: student.id,
              subject_id: ids.french!,
              status: "enrolled",
              reason: null,
            });
          if (i === 1)
            await setSubjectEnrollment(tx, tenant.schoolId, section.id, {
              student_id: student.id,
              subject_id: ids.math!,
              status: "exempt",
              reason: "Transferred mid-year",
            });
        });
      }
    }

    // Teachers: the instructor covers every subject of 7A and 9A, and Science everywhere in grade 8.
    await admin(async (tx) => {
      for (const section of ["7A", "9A"]) {
        for (const subject of layout[section === "7A" ? "Grade 7" : "Grade 9"]!.subjects) {
          await createTeacherAssignment(tx, tenant.schoolId, {
            section_id: ids[section]!,
            subject_id: ids[subject]!,
            teacher_id: tenant.teachers[0]!.id,
          });
        }
      }
      for (const section of ["8A", "8B"]) {
        await createTeacherAssignment(tx, tenant.schoolId, {
          section_id: ids[section]!,
          subject_id: ids.science!,
          teacher_id: tenant.teachers[0]!.id,
        });
      }
    });

    await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );

    // A teacher's own addition, awaiting approval.
    const g9math = await teacher((tx) => getMarkSheet(tx, tenant.schoolId, ids["9A"]!, ids.math!));
    const proposal = await teacher((tx) =>
      addSectionAssessment(tx, tenant.schoolId, tenant.teachers[0]!.userId, ids["9A"]!, ids.math!, {
        category_id: g9math.categories.find((c) => c.name === "homework")!.id,
        term_id: null,
        name: "Bonus worksheet",
        max_marks: 10,
        weight: 1,
        is_mandatory: false,
        assessment_date: null,
        due_date: null,
      }),
    );
    expect(proposal.status).toBe("proposed");

    // Marks, written straight to the table so the seed stays fast.
    let seed = 0;
    for (const section of sections) {
      for (const subject of [...layout[section.grade]!.subjects, "music"]) {
        const view = await admin((tx) =>
          getMarkSheet(tx, tenant.schoolId, section.id, ids[subject]!),
        ).catch(() => null);
        if (!view) continue;
        const rows: {
          assessment_id: string;
          student_id: string;
          attempt: 1 | 2;
          status: "graded" | "absent" | "excused";
          score: number | null;
        }[] = [];
        for (const student of view.students) {
          for (const item of view.assessments.filter((a) => a.status === "active")) {
            seed += 1;
            const mark = markFor(seed, item.max_marks);
            if (!mark) continue;
            rows.push({
              assessment_id: item.id,
              student_id: student.student_id,
              attempt: 1,
              ...mark,
            });
            if ((subject === "pe" || subject === "music") && seed % 3 === 0) {
              rows.push({
                assessment_id: item.id,
                student_id: student.student_id,
                attempt: 2,
                status: "graded",
                score: Math.round(((seed * 53) % 101) * item.max_marks) / 100,
              });
            }
          }
        }
        if (rows.length === 0) continue;
        await admin(
          (tx) => tx`
            INSERT INTO app.student_marks (school_id, academic_year_id, assessment_id, student_id, attempt, status, score, entered_by_user_id)
            SELECT ${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, x.assessment_id, x.student_id,
                   x.attempt, x.status, x.score, ${userId}::uuid
            FROM jsonb_to_recordset(${tx.json(rows as never)}::jsonb)
              AS x(assessment_id uuid, student_id uuid, attempt smallint, status text, score numeric)
          `,
        );
      }
    }

    // Sheets: 7A's are all approved; 9A's Mathematics annual sheet waits for approval.
    const now = new Date();
    for (const [section, subjects] of [
      ["7A", layout["Grade 7"]!.subjects],
      ["9A", ["math"]],
    ] as const) {
      for (const subject of subjects) {
        const view = await admin((tx) =>
          getMarkSheet(tx, tenant.schoolId, ids[section]!, ids[subject]!),
        );
        const periods = [...new Set(view.assessments.map((a) => a.term_id))];
        for (const term of periods) {
          const approved = section === "7A";
          await admin(
            (tx) => tx`
              INSERT INTO app.mark_sheets (school_id, academic_year_id, section_id, subject_id, term_id, status,
                submitted_by_user_id, submitted_at, decided_by_user_id, decided_at)
              VALUES (${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${ids[section]!}::uuid,
                ${ids[subject]!}::uuid, ${term}::uuid, ${approved ? "approved" : "submitted"},
                ${userId}::uuid, ${now}, ${approved ? userId : null}::uuid, ${approved ? now : null})
            `,
          );
        }
      }
    }
  }, 120_000);

  test("before finalization: every read equals the per-row reference", async () => {
    const { sectionsCompared } = await expectSameAsLegacy(
      admin,
      tenant.schoolId,
      tenant.academicYear.id,
      [teacher],
    );
    expect(sectionsCompared).toBe(8);
    const overview = await admin((tx) =>
      getGradingOverview(tx, tenant.schoolId, tenant.academicYear.id),
    );
    // The seed reaches the cases it means to.
    expect(overview.counts).toMatchObject({
      grades: 4,
      sections: 8,
      sections_with_overrides: 3,
      outdated_overrides: 1,
      proposed_assessments: 1,
      mark_sheets_awaiting_approval: 1,
    });
    expect(overview.counts.students_with_incomplete_marks).toBeGreaterThan(0);
    expect(overview.issues.map((issue) => issue.code)).toContain("GRADE_WITHOUT_SECTIONS");
    const preview = await admin((tx) => computeSection(tx, tenant.schoolId, ids["7A"]!, null));
    expect(preview.students.some((s) => s.overall.status === "complete")).toBe(true);
    expect(preview.students.some((s) => s.subjects.some((subject) => subject.exempt))).toBe(true);
  }, 120_000);

  test("finalize, certify and correct: results and readiness still equal the reference", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const annual7A = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, userId, ids["7A"]!, null, { allowIncomplete: true }),
    );
    // What finalization stored is exactly what the reference computes.
    const stored = await admin((tx) => readFinalizationResults(tx, tenant.schoolId, annual7A.id));
    const reference = await admin((tx) =>
      legacyComputeSection(tx, tenant.schoolId, ids["7A"]!, null),
    );
    expect(stored.map((row) => [row.student_id, row.status, row.average_percentage])).toEqual(
      reference.students.map((s) => [s.student.id, s.overall.status, s.overall.averagePercentage]),
    );
    const storedSnapshots = await admin(
      (tx) => tx<
        {
          student_id: string;
          subject_id: string;
          config_snapshot: unknown;
          breakdown: unknown;
          percentage: string | null;
        }[]
      >`
        SELECT student_id, subject_id, config_snapshot, breakdown, percentage::text
        FROM app.student_subject_results WHERE finalization_id = ${annual7A.id}::uuid
      `,
    );
    for (const student of reference.students) {
      for (const subject of student.subjects) {
        const row = storedSnapshots.find(
          (r) => r.student_id === student.student.id && r.subject_id === subject.subject_id,
        )!;
        expect(row.config_snapshot).toEqual(JSON.parse(JSON.stringify(subject.snapshot)));
        expect(row.breakdown).toEqual(
          JSON.parse(JSON.stringify(subject.result ?? { exempt: true })),
        );
      }
    }

    await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, userId, ids["8A"]!, null, { allowIncomplete: true }),
    );
    await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, userId, ids["8A"]!, ids.term1!, {
        allowIncomplete: true,
      }),
    );
    const annual8B = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, userId, ids["8B"]!, null, { allowIncomplete: true }),
    );
    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, userId, annual7A.id, undefined),
    );
    const issued8B = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, userId, annual8B.id, undefined),
    );
    expect(issued.issued.length + issued8B.issued.length).toBeGreaterThan(0);
    // Issued ids come back in readiness order, one per ready student.
    const readiness = await admin((tx) => certificateReadiness(tx, tenant.schoolId, annual7A.id));
    expect(issued.issued).toEqual(
      readiness.filter((row) => row.state === "issued").map((row) => row.certificate_id!),
    );

    // Correct one mark in 8B: its certificates now need reissue.
    const sheet8B = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids["8B"]!, ids.science!),
    );
    await admin((tx) =>
      correctFinalization(tx, tenant.schoolId, userId, annual8B.id, {
        reason: "Re-marked",
        marks: [
          {
            assessment_id: sheet8B.assessments.find((a) => a.name === "Annual final")!.id,
            student_id: sheet8B.students[0]!.student_id,
            attempt: 1,
            status: "graded",
            score: 99,
          },
        ],
        allow_incomplete: true,
      }),
    );

    const { sectionsCompared } = await expectSameAsLegacy(
      admin,
      tenant.schoolId,
      tenant.academicYear.id,
      [teacher],
    );
    expect(sectionsCompared).toBe(8);
    const overview = await admin((tx) =>
      getGradingOverview(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(
      overview.counts.certificates_ready +
        overview.counts.certificates_blocked +
        overview.counts.certificates_needing_reissue,
    ).toBeGreaterThan(0);
  }, 120_000);

  test("query counts: the overview and its siblings no longer grow with the school", async () => {
    const adminId = tenant.users.ORG_ADMIN.id;
    const teacherId = tenant.teachers[0]!.userId;
    const yearId = tenant.academicYear.id;
    const measure = async (
      label: string,
      userId: string,
      next: (tx: TransactionSql) => Promise<unknown>,
      legacy: (tx: TransactionSql) => Promise<unknown>,
    ) => {
      const after = await countStatements(userId, next);
      const before = await countStatements(userId, legacy);
      expect(JSON.stringify(after.value)).toBe(JSON.stringify(before.value));
      console.info(`[query count] ${label}: ${before.statements} -> ${after.statements}`);
      return { before: before.statements, after: after.statements };
    };

    const overview = await measure(
      "GET /grading/years/:id/overview",
      adminId,
      (tx) => getGradingOverview(tx, tenant.schoolId, yearId),
      (tx) => legacyGetGradingOverview(tx, tenant.schoolId, yearId),
    );
    // A fixed handful of queries, whatever the number of grades, sections and subjects.
    expect(overview.after).toBeLessThanOrEqual(30);
    expect(overview.before).toBeGreaterThan(overview.after * 10);

    const issues = await measure(
      "publish validation",
      adminId,
      (tx) => collectPublishIssues(tx, tenant.schoolId, yearId),
      (tx) => legacyCollectPublishIssues(tx, tenant.schoolId, yearId),
    );
    expect(issues.after).toBeLessThanOrEqual(15);
    expect(issues.before).toBeGreaterThan(issues.after * 5);

    const section = await measure(
      "computeSection (7A, annual)",
      adminId,
      (tx) => computeSection(tx, tenant.schoolId, ids["7A"]!, null),
      (tx) => legacyComputeSection(tx, tenant.schoolId, ids["7A"]!, null),
    );
    expect(section.after).toBeLessThanOrEqual(15);
    expect(section.before).toBeGreaterThan(section.after * 3);

    const assignments = await measure(
      "my assignments (teacher)",
      teacherId,
      (tx) => listMyAssignments(tx, tenant.schoolId, yearId).then(normalizeAssignments),
      (tx) => legacyListMyAssignments(tx, tenant.schoolId, yearId).then(normalizeAssignments),
    );
    expect(assignments.after).toBeLessThanOrEqual(5);
    expect(assignments.before).toBeGreaterThan(assignments.after * 3);

    const gradeConfigs = await countStatements(adminId, (tx) =>
      listGradeConfigs(tx, tenant.schoolId, yearId, ids["Grade 7"]!),
    );
    console.info(`[query count] grade configs (Grade 7, 6 subjects): ${gradeConfigs.statements}`);
    expect(gradeConfigs.statements).toBeLessThanOrEqual(12);

    // Finalizing 9B writes its results in a couple of multi-row INSERTs, not one per row.
    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, yearId, ids["Grade 9"]!, {
        mark_approval_required: false,
      }),
    );
    const finalize = await countStatements(adminId, (tx) =>
      finalizeSection(tx, tenant.schoolId, adminId, ids["9B"]!, null, { allowIncomplete: true }),
    );
    const rows = await admin(
      (tx) => tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.student_subject_results
        WHERE finalization_id = ${finalize.value.id}::uuid
      `,
    );
    console.info(
      `[query count] finalize 9B (${rows[0]!.count} subject results + 4 overall): ${finalize.statements}`,
    );
    expect(finalize.statements).toBeLessThanOrEqual(25);
  }, 120_000);
});
