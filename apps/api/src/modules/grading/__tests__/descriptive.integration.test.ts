/**
 * Descriptive grading (000210) end to end, against a real migrated database with RLS armed.
 *
 * A kindergarten grade with one descriptive subject (Reading: skills, no marks) and one numeric
 * subject (Mathematics): the default descriptor scale, entering descriptors, finalization, the
 * certificate, and a correction. Later tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/descriptive.integration.test.ts
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
  createSubjectConfig,
  setYearGradingStatus,
  updateSubjectConfig,
  upsertProgram,
} from "../config-service";
import { getMarkSheet, saveMarks } from "../marks-service";
import { correctFinalization, finalizeSection, readFinalizationResults } from "../results-service";

import type { TestApp, TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { MarkEntryInput } from "../marks-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
const ids = {} as Record<string, string>;
const descriptor = {} as Record<string, string>;

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

const skill = (name: string, extra: Partial<SubjectConfigInput["assessments"][number]> = {}) => ({
  category_ref: "reading",
  term_id: ids.term1!,
  name,
  max_marks: 25,
  weight: 1,
  is_mandatory: true,
  assessment_date: null,
  due_date: null,
  sort_order: 0,
  ...extra,
});

/** Reading as sent by a client that left numeric settings in (the API must ignore them). */
const readingInput = (overrides: Partial<SubjectConfigInput> = {}) =>
  baseInput({
    grading_method: "descriptive",
    include_in_average: true,
    retake_policy: "highest",
    term_weights: [{ term_id: ids.term1!, weight: 100 }],
    categories: [
      {
        ref: "reading",
        name: "Reading",
        kind: "other",
        scope: "term",
        weight: 40,
        aggregation: "total_points",
        drop_lowest: 1,
        sort_order: 0,
      },
    ],
    assessments: [
      skill("Reads fluently", { sort_order: 0 }),
      skill("Knows letters", { sort_order: 1 }),
    ],
    ...overrides,
  });

const pick = (
  studentId: string,
  assessmentId: string,
  descriptorId: string | null,
  score: number | null = null,
): MarkEntryInput => ({
  assessment_id: assessmentId,
  student_id: studentId,
  attempt: 1,
  status: "graded",
  score,
  descriptor_id: descriptorId,
  remarks: null,
});

describeDb("descriptive grading", () => {
  test("setup: a kindergarten grade, one section, two pupils, Reading and Mathematics", async () => {
    ids.term1 = tenant.term.id;
    ids.reading = (
      await createSubject(db.sql, tenant.schoolId, { code: "RD", name: "Reading" })
    ).id;
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MA", name: "Mathematics" })
    ).id;
    for (const [key, name] of [
      ["s1", "Amal"],
      ["s2", "Badr"],
    ] as const) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Kg",
      });
      ids[key] = student.id;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }
    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "KG 1", sort_order: 0 });
      ids.kg = grade.id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        mark_approval_required: false,
      });
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "KG1-A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s1!);
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s2!);
    });
  });

  test("a descriptive subject drops numeric settings and gets the default descriptor scale", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const saved = await admin((tx) =>
      createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids.kg!,
          sectionId: null,
          subjectId: ids.reading!,
        },
        readingInput(),
      ),
    );
    ids.readingConfig = saved.config.id;
    expect(saved.config.grading_method).toBe("descriptive");
    expect(saved.config.include_in_average).toBe(false);
    expect(saved.config.retake_policy).toBe("none");
    expect(saved.config.categories[0]!.weight).toBeNull();
    expect(saved.config.assessments.map((a) => a.max_marks)).toEqual([1, 1]);
    expect(saved.config.valid).toBe(true);

    const math = await admin((tx) =>
      createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids.kg!,
          sectionId: null,
          subjectId: ids.math!,
        },
        baseInput({
          grading_method: "total_points",
          categories: [
            {
              ref: "tests",
              name: "Tests",
              kind: "exam",
              scope: "annual",
              weight: null,
              aggregation: "weighted_average",
              drop_lowest: 0,
              sort_order: 0,
            },
          ],
          assessments: [
            {
              category_ref: "tests",
              term_id: null,
              name: "Test",
              max_marks: 100,
              weight: 1,
              is_mandatory: true,
              assessment_date: null,
              due_date: null,
              sort_order: 0,
            },
          ],
        }),
      ),
    );
    expect(math.config.valid).toBe(true);

    const res = await authenticatedRequest(
      harness!,
      "GET",
      `/api/grading/years/${tenant.academicYear.id}/programs`,
      { schoolId: tenant.schoolId, userId, roles: [ROLES.ORG_ADMIN] },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      programs: {
        grade_level_id: string;
        descriptors: { id: string; label: string; points: number | null; position: number }[];
      }[];
    };
    const scale = body.programs.find((p) => p.grade_level_id === ids.kg)!.descriptors;
    expect(scale.map((d) => [d.position, d.label, d.points])).toEqual([
      [1, "Excellent", 4],
      [2, "Very good", 3],
      [3, "Good", 2],
      [4, "Needs improvement", 1],
    ]);
    for (const d of scale) descriptor[d.label] = d.id;
  });

  test("the school edits the scale: all-or-no points, unique labels, a 'not achieved' step", async () => {
    const edit = (descriptors: Parameters<typeof upsertProgram>[4]["descriptors"]) =>
      admin((tx) =>
        upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.kg!, { descriptors }),
      );
    const kept = (label: string, points: number | null, notAchieved = false) => ({
      id: descriptor[label]!,
      label,
      points,
      not_achieved: notAchieved,
    });
    expect(
      await codeOf(
        edit([
          kept("Excellent", 4),
          kept("Very good", null),
          kept("Good", 2),
          kept("Needs improvement", 1),
        ]),
      ),
    ).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(
      await codeOf(
        edit([kept("Excellent", 4), { label: "excellent", points: 3, not_achieved: false }]),
      ),
    ).toBe(ERROR_CODES.VALIDATION_FAILED);
    await edit([
      kept("Excellent", 4),
      kept("Very good", 3),
      kept("Good", 2),
      kept("Needs improvement", 1, true),
    ]);

    const published = await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );
    expect(published.status).toBe("active");
  });

  test("teachers pick descriptors; scores and foreign descriptors are refused", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const sheet = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, ids.reading!),
    );
    expect(sheet.config.grading_method).toBe("descriptive");
    expect(sheet.descriptors.map((d) => d.label)).toEqual([
      "Excellent",
      "Very good",
      "Good",
      "Needs improvement",
    ]);
    const byName = (name: string) => sheet.assessments.find((a) => a.name === name)!.id;
    const fluent = byName("Reads fluently");
    const letters = byName("Knows letters");
    ids.fluent = fluent!;
    ids.letters = letters!;
    const save = (entries: MarkEntryInput[], subject = ids.reading!) =>
      admin((tx) => saveMarks(tx, tenant.schoolId, userId, ids.section!, subject, entries));

    expect(await codeOf(save([pick(ids.s1!, fluent!, null, 1)]))).toBe(
      ERROR_CODES.VALIDATION_FAILED,
    );
    expect(
      await codeOf(save([pick(ids.s1!, fluent!, "00000000-0000-4000-8000-000000000000")])),
    ).toBe(ERROR_CODES.VALIDATION_FAILED);

    await save([
      pick(ids.s1!, fluent!, descriptor.Excellent!),
      pick(ids.s1!, letters!, descriptor["Very good"]!),
      pick(ids.s2!, fluent!, descriptor["Needs improvement"]!),
      pick(ids.s2!, letters!, descriptor["Needs improvement"]!),
    ]);

    const mathSheet = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, ids.math!),
    );
    const test = mathSheet.assessments[0]!.id;
    expect(await codeOf(save([pick(ids.s1!, test, descriptor.Excellent!, null)], ids.math!))).toBe(
      ERROR_CODES.VALIDATION_FAILED,
    );
    await save([pick(ids.s1!, test, null, 80), pick(ids.s2!, test, null, 60)], ids.math!);

    const after = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, ids.reading!),
    );
    const amal = after.students.find((s) => s.student_id === ids.s1)!;
    expect(amal.marks.find((m) => m.assessment_id === fluent)?.descriptor_id).toBe(
      descriptor.Excellent,
    );
    // (4 + 3) / 2 = 3.5: a tie between Excellent and Very good goes to the higher.
    expect(amal.preview?.grade_label).toBe("Excellent");
    const badr = after.students.find((s) => s.student_id === ids.s2)!;
    expect(badr.preview?.passed).toBe(false);
  });

  test("a used descriptor cannot be removed, and a subject with marks cannot change kind", async () => {
    expect(
      await codeOf(
        admin((tx) =>
          upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.kg!, {
            descriptors: [
              { id: descriptor.Excellent!, label: "Excellent", points: 4, not_achieved: false },
              { id: descriptor.Good!, label: "Good", points: 2, not_achieved: false },
            ],
          }),
        ),
      ),
    ).toBe(ERROR_CODES.CONFLICT_STATE_MISMATCH);

    expect(
      await codeOf(
        admin((tx) =>
          updateSubjectConfig(
            tx,
            tenant.schoolId,
            tenant.users.ORG_ADMIN.id,
            ids.readingConfig!,
            readingInput({
              grading_method: "weighted",
              include_in_average: true,
              retake_policy: "none",
              categories: [
                {
                  ref: "reading",
                  name: "Reading",
                  kind: "other",
                  scope: "term",
                  weight: 100,
                  aggregation: "weighted_average",
                  drop_lowest: 0,
                  sort_order: 0,
                },
              ],
              assessments: [
                skill("Reads fluently", { id: ids.fluent!, max_marks: 10, sort_order: 0 }),
                skill("Knows letters", { id: ids.letters!, max_marks: 10, sort_order: 1 }),
              ],
            }),
            { confirmImpact: true },
          ),
        ),
      ),
    ).toBe(ERROR_CODES.CONFLICT_STATE_MISMATCH);
  });

  test("finalized results keep descriptors, leave the average numeric, and decide status", async () => {
    const userId = tenant.users.ORG_ADMIN.id;
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, userId, ids.section!, null, { allowIncomplete: false }),
    );
    ids.final = finalization.id;
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, finalization.id),
    );
    const amal = results.find((r) => r.student_id === ids.s1)!;
    const reading = amal.subjects.find((s) => s.subject_id === ids.reading)!;
    expect(reading).toMatchObject({
      status: "complete",
      is_descriptive: true,
      percentage: null,
      marks_obtained: null,
      grade_label: "Excellent",
      average_points: 3.5,
      passed: true,
      include_in_average: false,
    });
    expect(reading.skills.map((s) => [s.name, s.category_name, s.descriptor_label])).toEqual([
      ["Reads fluently", "Reading", "Excellent"],
      ["Knows letters", "Reading", "Very good"],
    ]);
    // Only Mathematics counts in the average.
    expect(amal.average_percentage).toBe(80);
    expect(amal.academic_status).toBe("promoted");

    const badr = results.find((r) => r.student_id === ids.s2)!;
    expect(badr.average_percentage).toBe(60);
    expect(badr.subjects_failed).toBe(1);
    expect(badr.academic_status).toBe("retained");
    expect(badr.subjects.find((s) => s.subject_id === ids.reading)!.fail_reasons).toEqual([
      {
        code: "DESCRIPTOR_NOT_ACHIEVED",
        required: 0,
        actual: null,
        descriptor: "Needs improvement",
      },
    ]);

    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, userId, finalization.id, [ids.s1!]),
    );
    const certificate = await admin((tx) => getCertificate(tx, tenant.schoolId, issued.issued[0]!));
    const subject = certificate.content.subjects.find((s) => s.code === "RD")!;
    expect(subject.descriptive).toBe(true);
    expect(subject.percentage).toBeNull();
    expect(subject.grade_label).toBe("Excellent");
    expect(subject.skills).toEqual([
      {
        name: "Reads fluently",
        category_name: "Reading",
        term_name: expect.any(String),
        descriptor_label: "Excellent",
      },
      {
        name: "Knows letters",
        category_name: "Reading",
        term_name: expect.any(String),
        descriptor_label: "Very good",
      },
    ]);
    expect(certificate.content.subjects.find((s) => s.code === "MA")!.descriptive).toBeUndefined();
  });

  test("a correction changes descriptors under the finalized scale", async () => {
    const corrected = await admin((tx) =>
      correctFinalization(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.final!, {
        reason: "Badr's reading was entered against the wrong pupil",
        marks: [
          { ...pick(ids.s2!, ids.fluent!, descriptor.Good!), attempt: 1 },
          { ...pick(ids.s2!, ids.letters!, descriptor.Good!), attempt: 1 },
        ],
        allow_incomplete: false,
      }),
    );
    const results = await admin((tx) => readFinalizationResults(tx, tenant.schoolId, corrected.id));
    const badr = results.find((r) => r.student_id === ids.s2)!;
    expect(badr.subjects.find((s) => s.subject_id === ids.reading)!.grade_label).toBe("Good");
    expect(badr.academic_status).toBe("promoted");
  });
});
