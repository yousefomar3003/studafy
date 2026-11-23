/**
 * Curriculum templates against a real migrated database: the preview lists what applying a
 * template would create or change, an apply that would change existing configuration is refused
 * until confirmed, subjects with marks are left alone, and only school leadership of the same
 * school can use any of it.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/curriculum-template.integration.test.ts
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
import {
  createScale,
  createSubjectConfig,
  getConfigView,
  listPrograms,
  listScales,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import {
  applyCurriculumTemplate,
  listCurriculumTemplates,
  previewCurriculumTemplate,
} from "../curriculum-template-service";
import { loadProgramDescriptorViews } from "../descriptor-service";
import { getMarkSheet, saveMarks } from "../marks-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { CurriculumTemplateRequest } from "../curriculum-template-service";
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

const request = (
  templateId: CurriculumTemplateRequest["template_id"],
  grades: string[],
): CurriculumTemplateRequest => ({
  template_id: templateId,
  grade_level_ids: grades,
  locale: "en",
});

const preview = (req: CurriculumTemplateRequest) =>
  admin((tx) => previewCurriculumTemplate(tx, tenant.schoolId, tenant.academicYear.id, req));
const apply = (req: CurriculumTemplateRequest, confirm = false) =>
  admin((tx) =>
    applyCurriculumTemplate(
      tx,
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      tenant.academicYear.id,
      { ...req, confirm },
    ),
  );

/** A subject graded by one annual exam: whatever the school set up before choosing a template. */
const oneExam = (): SubjectConfigInput => ({
  requirement: "mandatory",
  include_in_average: true,
  include_on_certificate: true,
  average_weight: 2,
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

async function addSubject(gradeLevelId: string, subjectId: string): Promise<string> {
  const saved = await admin((tx) =>
    createSubjectConfig(
      tx,
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      { yearId: tenant.academicYear.id, gradeLevelId, sectionId: null, subjectId },
      oneExam(),
    ),
  );
  return saved.config.id;
}

describeDb("curriculum templates", () => {
  test("setup: two terms; grade 10 with Mathematics and Science on a letter scale; grade 11 new", async () => {
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
    for (const [key, code, name] of [
      ["math", "MATH", "Mathematics"],
      ["science", "SCI", "Science"],
      ["art", "ART", "Art"],
    ] as const) {
      // eslint-disable-next-line security/detect-object-injection -- `key` is a literal
      ids[key] = (await createSubject(db.sql, tenant.schoolId, { code, name })).id;
    }
    const student = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Lina",
      lastName: "Test",
    });
    ids.student = student.id;
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);

    await admin(async (tx) => {
      for (const [key, name, order] of [
        ["grade10", "Grade 10", 10],
        ["grade11", "Grade 11", 11],
        ["grade1", "Grade 1", 1],
      ] as const) {
        // eslint-disable-next-line security/detect-object-injection -- `key` is a literal
        ids[key] = (await createGradeLevel(tx, tenant.schoolId, { name, sort_order: order })).id;
      }
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Letters",
        bands: [
          { label: "A", min_percentage: 90, gpa_points: 4 },
          { label: "F", min_percentage: 0, gpa_points: 0 },
        ],
      });
      ids.letters = scale.id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade10!, {
        grade_scale_id: scale.id,
      });
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: ids.grade10!,
        name: "10A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, student.id);
    });
    ids.mathConfig = await addSubject(ids.grade10!, ids.math!);
    ids.scienceConfig = await addSubject(ids.grade10!, ids.science!);
  });

  test("the templates are listed in English and Arabic", async () => {
    const en = listCurriculumTemplates("en");
    expect(en.map((template) => template.id)).toContain("ib_myp");
    const american = en.find((template) => template.id === "american")!;
    expect(american.result_format).toBe("gpa");
    expect(american.result_scale_max).toBe(4);
    expect(american.scale!.bands[0]).toEqual({ label: "A+", min_percentage: 97, gpa_points: 4 });
    expect(american.course_levels.map((level) => [level.label, level.gpa_boost])).toEqual([
      ["Standard", 0],
      ["Honors", 0.5],
      ["AP", 1],
    ]);
    const ar = listCurriculumTemplates("ar");
    expect(
      ar.find((template) => template.id === "national_percentage")!.scale!.bands[0]!.label,
    ).toBe("ممتاز");
  });

  test("preview: the American template would add a scale, set up grade 11 and change grade 10", async () => {
    const plan = await preview(request("american", [ids.grade10!, ids.grade11!]));
    expect(plan.applied).toBe(false);
    expect(plan.requires_confirmation).toBe(true);
    expect(plan.scale).toEqual({ action: "create", scale_id: null, name: "American A+–F" });
    const [grade10, grade11] = plan.grades;
    expect(grade10!.grade_level_name).toBe("Grade 10");
    expect(grade10!.program).toEqual({
      action: "update",
      changes: ["grade_scale", "result_format"],
    });
    expect(grade10!.subjects.map((s) => [s.subject_name, s.action])).toEqual([
      ["Mathematics", "update"],
      ["Science", "update"],
    ]);
    expect(grade11!.program).toEqual({ action: "create", changes: [] });
    expect(grade11!.subjects).toEqual([]);

    // A preview writes nothing.
    const scales = await admin((tx) => listScales(tx, tenant.schoolId, tenant.academicYear.id));
    expect(scales.map((scale) => scale.name)).toEqual(["Letters"]);
  });

  test("apply refuses to change existing configuration without confirm, and changes nothing", async () => {
    expect(await codeOf(apply(request("american", [ids.grade10!, ids.grade11!])))).toBe(
      ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED,
    );
    const scales = await admin((tx) => listScales(tx, tenant.schoolId, tenant.academicYear.id));
    expect(scales.map((scale) => scale.name)).toEqual(["Letters"]);
    const programs = await admin((tx) => listPrograms(tx, tenant.schoolId, tenant.academicYear.id));
    expect(programs.map((program) => program.grade_level_id)).toEqual([ids.grade10]);
  });

  test("a new grade needs no confirmation: the scale and program are created", async () => {
    const result = await apply(request("american", [ids.grade11!]));
    expect(result.applied).toBe(true);
    expect(result.scale!.action).toBe("create");
    ids.american = result.scale!.scale_id!;

    const programs = await admin((tx) => listPrograms(tx, tenant.schoolId, tenant.academicYear.id));
    const grade11 = programs.find((program) => program.grade_level_id === ids.grade11)!;
    expect(grade11.grade_scale_id).toBe(ids.american);
    expect(grade11.result_format).toBe("gpa");
    expect(grade11.result_scale_max).toBe(4);

    // The scale exists now, so a preview reuses it.
    const plan = await preview(request("american", [ids.grade10!, ids.grade11!]));
    expect(plan.scale).toEqual({
      action: "unchanged",
      scale_id: ids.american,
      name: "American A+–F",
    });
    expect(plan.grades[1]!.program.action).toBe("unchanged");
  });

  test("with confirm, grade 10's program and subjects move to the template; a second apply changes nothing", async () => {
    const result = await apply(request("american", [ids.grade10!]), true);
    expect(result.grades[0]!.subjects.map((s) => [s.subject_name, s.action])).toEqual([
      ["Mathematics", "update"],
      ["Science", "update"],
    ]);

    const math = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathConfig!));
    expect(math.valid).toBe(true);
    expect(math.revision).toBe(2);
    expect(math.pass_percentage).toBe(65);
    expect(math.credits).toBe(1);
    expect(math.average_weight).toBe(1);
    expect(math.grade_scale_id).toBeNull();
    expect(math.effective_scale_name).toBe("American A+–F");
    expect(math.categories.map((c) => [c.kind, c.weight])).toEqual([
      ["exam", 40],
      ["quiz", 20],
      ["homework", 15],
      ["classwork", 15],
      ["project", 10],
    ]);
    expect(math.term_weights.map((row) => row.weight)).toEqual([50, 50]);
    expect(math.assessments).toHaveLength(10);

    const again = await preview(request("american", [ids.grade10!, ids.grade11!]));
    expect(again.requires_confirmation).toBe(false);
    expect(again.grades[0]!.program.action).toBe("unchanged");
    expect(again.grades[0]!.subjects.map((s) => s.action)).toEqual(["unchanged", "unchanged"]);

    // The apply is audited once, beside each service's own entries.
    const [audit] = await admin(
      (tx) => tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM app.audit_logs
        WHERE target_table = 'grade_programs'
          AND new_values ->> 'event' = 'curriculum_template_applied'
      `,
    );
    expect(audit!.count).toBe(2);
  });

  test("IB MYP: criteria A-D out of 8 per term, graded by total points on a 1-7 scale", async () => {
    ids.artConfig = await addSubject(ids.grade11!, ids.art!);
    const plan = await preview(request("ib_myp", [ids.grade11!]));
    expect(plan.requires_confirmation).toBe(true);
    await apply(request("ib_myp", [ids.grade11!]), true);

    const art = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.artConfig!));
    expect(art.valid).toBe(true);
    expect(art.grading_method).toBe("total_points");
    expect(art.max_marks).toBe(32);
    expect(art.pass_percentage).toBe(31.25);
    expect(art.categories.map((c) => c.name)).toEqual([
      "Criterion A",
      "Criterion B",
      "Criterion C",
      "Criterion D",
    ]);
    expect(art.assessments.map((a) => a.max_marks)).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
    // MYP keeps the credits and coefficient the subject already had.
    expect(art.average_weight).toBe(2);
    expect(art.credits).toBeNull();

    const scales = await admin((tx) => listScales(tx, tenant.schoolId, tenant.academicYear.id));
    const myp = scales.find((scale) => scale.name === "IB MYP 1–7")!;
    expect(myp.bands.map((band) => [band.label, band.min_percentage])).toEqual(
      expect.arrayContaining([
        ["4", 46.875],
        ["5", 59.375],
        ["7", 87.5],
      ]),
    );
    const programs = await admin((tx) => listPrograms(tx, tenant.schoolId, tenant.academicYear.id));
    const grade11 = programs.find((program) => program.grade_level_id === ids.grade11)!;
    expect([grade11.grade_scale_id, grade11.result_format, grade11.result_scale_max]).toEqual([
      myp.id,
      "gpa",
      7,
    ]);
  });

  test("British Key Stages: the grade gets the descriptor scale and its subjects become descriptive", async () => {
    await apply(request("british_key_stages", [ids.grade1!]));
    const grade1Art = await admin(async (tx) => {
      const saved = await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: ids.grade1!,
          sectionId: null,
          subjectId: ids.art!,
        },
        oneExam(),
      );
      return saved.config.id;
    });
    const plan = await preview(request("british_key_stages", [ids.grade1!]));
    expect(plan.scale).toBeNull();
    expect(plan.grades[0]!.descriptors).toBe("unchanged");
    expect(plan.grades[0]!.subjects[0]!.action).toBe("update");
    await apply(request("british_key_stages", [ids.grade1!]), true);

    const descriptors = await admin((tx) =>
      loadProgramDescriptorViews(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(descriptors.get(ids.grade1!)!.map((d) => [d.label, d.points])).toEqual([
      ["Greater depth", 3],
      ["Expected standard", 2],
      ["Working towards", 1],
    ]);
    const art = await admin((tx) => getConfigView(tx, tenant.schoolId, grade1Art));
    expect(art.grading_method).toBe("descriptive");
    expect(art.include_in_average).toBe(false);
    expect(art.valid).toBe(true);
  });

  test("a subject with marks is never rebuilt", async () => {
    await admin((tx) =>
      setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active"),
    );
    const sheet = await admin((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, ids.science!),
    );
    await admin((tx) =>
      saveMarks(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, ids.science!, [
        {
          assessment_id: sheet.assessments[0]!.id,
          student_id: ids.student!,
          attempt: 1,
          status: "graded",
          score: 30,
          remarks: null,
        },
      ]),
    );

    const result = await apply(request("igcse_9_1", [ids.grade10!]), true);
    expect(result.grades[0]!.subjects.map((s) => [s.subject_name, s.action, s.reason])).toEqual([
      ["Mathematics", "update", null],
      ["Science", "skip", "has_marks"],
    ]);
    const science = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.scienceConfig!));
    expect(science.pass_percentage).toBe(65);
    const math = await admin((tx) => getConfigView(tx, tenant.schoolId, ids.mathConfig!));
    expect(math.pass_percentage).toBe(40);
    expect(math.effective_scale_name).toBe("IGCSE 9–1");
  });

  test("another school can neither preview nor apply against this school's year or grades", async () => {
    const otherAdmin = <T>(fn: (tx: TransactionSql) => Promise<T>) =>
      withTenantTx(client!, { schoolId: other.schoolId, userId: other.users.ORG_ADMIN.id }, fn);
    expect(
      await codeOf(
        otherAdmin((tx) =>
          previewCurriculumTemplate(tx, other.schoolId, tenant.academicYear.id, {
            template_id: "american",
            grade_level_ids: [ids.grade10!],
          }),
        ),
      ),
    ).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    // Its own year, but this school's grade.
    expect(
      await codeOf(
        otherAdmin((tx) =>
          applyCurriculumTemplate(
            tx,
            other.schoolId,
            other.users.ORG_ADMIN.id,
            other.academicYear.id,
            {
              template_id: "american",
              grade_level_ids: [ids.grade10!],
              confirm: true,
            },
          ),
        ),
      ),
    ).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
    const [scales] = await otherAdmin(
      (tx) => tx<{ count: number }[]>`SELECT count(*)::int AS count FROM app.grade_scales`,
    );
    expect(scales!.count).toBe(0);
  });

  test("HTTP: leadership lists, previews and applies; teachers are refused", async () => {
    const http = harness!;
    const adminAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const teacherAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.teachers[0]!.userId,
      roles: [ROLES.INSTRUCTOR],
    };
    const post = (path: string, auth: TestAuthContext, body: unknown) =>
      authenticatedRequest(http, "POST", path, auth, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const base = `/api/grading/years/${tenant.academicYear.id}/curriculum-template`;
    const body = { template_id: "a_level", grade_level_ids: [ids.grade10] };

    const list = await authenticatedRequest(
      http,
      "GET",
      "/api/grading/curriculum-templates?locale=ar",
      adminAuth,
    );
    expect(list.status).toBe(200);
    const templates = ((await list.json()) as { templates: { id: string; name: string }[] })
      .templates;
    expect(templates).toHaveLength(13);
    expect(templates.find((t) => t.id === "french")!.name).toBe("الفرنسي (من 20)");

    expect(
      (await authenticatedRequest(http, "GET", "/api/grading/curriculum-templates", teacherAuth))
        .status,
    ).toBe(403);
    expect((await post(`${base}/preview`, teacherAuth, body)).status).toBe(403);
    expect((await post(`${base}/apply`, teacherAuth, { ...body, confirm: true })).status).toBe(403);

    const previewed = await post(`${base}/preview`, adminAuth, body);
    expect(previewed.status).toBe(200);
    expect(
      ((await previewed.json()) as { requires_confirmation: boolean }).requires_confirmation,
    ).toBe(true);
    const refused = await post(`${base}/apply`, adminAuth, body);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe(
      ERROR_CODES.ACADEMIC_CONFIG_IMPACT_UNCONFIRMED,
    );
    const applied = await post(`${base}/apply`, adminAuth, { ...body, confirm: true });
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as { applied: boolean }).applied).toBe(true);

    const unknown = await post(`${base}/preview`, adminAuth, { ...body, template_id: "nope" });
    expect(unknown.status).toBe(400);
  });
});
