/**
 * Tawjihi equivalency and multi-year results (000267) against a real migrated database with RLS
 * armed.
 *
 * Grade 12 this year (active, not finalized yet); grade 11 last year (closed, finalized).
 *
 *   Last year   Amal: Math 90 (GPA 4), Arabic 80 (GPA 3); overall 85
 *               Badr: Math 60 (GPA 2), Arabic 70 (GPA 2); overall 65
 *   This year   (finalized in the last test) Amal: Math 70, Physics 95; overall 82.5
 *   Amal's IGCSE (letter grades): Mathematics A*, Arabic A, Physics B, Art C.
 *   Badr sat the SAT: 650 + 700 = 1350.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academic-equivalency/__tests__/academic-equivalency.integration.test.ts
 */

import { ROLES } from "@studafy/constants";
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
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import { createGradeLevel, createSection } from "../../academics/section-service";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type {
  EquivalencyRuleSetView,
  EquivalencyStudentListView,
  StudentEquivalencyView,
} from "../equivalency-service";
import type { MultiYearConfigView, StudentMultiYearResultsView } from "../multi-year-service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;
let otherTenant: TenantFixture;

const ids = {} as Record<string, string>;
let igcseSet: EquivalencyRuleSetView;
let americanSet: EquivalencyRuleSetView;
let twoYear: MultiYearConfigView;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createTestDatabase();
  await migrateDatabase(db.url);
  tenant = await createFullTenant(db.sql);
  otherTenant = await createFullTenant(db.sql);
  client = postgres(db.url, { max: 1, prepare: false });
  const created = createTestApp({ database: db.sql });
  await created.ready;
  http = created;
}, 120_000);

afterAll(async () => {
  http?.keyStore.destroy();
  if (client) await client.end({ timeout: 1 });
  if (db?.cleanup) await db.cleanup();
});

const auth = (userId: string, role: keyof typeof ROLES, fixture = tenant): TestAuthContext => ({
  schoolId: fixture.schoolId,
  userId,
  roles: [ROLES[role]],
});
const adminAuth = () => auth(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
const otherAdminAuth = () => auth(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant);
const amalAuth = () => auth(ids.amalUser!, "STUDENT");
const badrAuth = () => auth(ids.badrUser!, "STUDENT");
const parentAuth = () => auth(ids.parent!, "PARENT");
const teacherAuth = () => auth(tenant.teachers[0]!.userId, "INSTRUCTOR");

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  as: TestAuthContext,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await authenticatedRequest(
    http,
    method,
    path,
    as,
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

const SETS = "/api/grading/equivalency-rule-sets";
const CONFIGS = "/api/grading/multi-year-result-configs";
const estimatePath = (studentId: string) => `/api/grading/students/${studentId}/equivalency`;
const multiYearPath = (studentId: string) =>
  `/api/grading/students/${studentId}/multi-year-results`;

interface SubjectRow {
  student: string;
  subject: string;
  percentage: number;
  gpa: number;
}

/** One finalized annual result for a section, as finalization would store it. */
async function seedFinalization(
  yearId: string,
  sectionId: string,
  overall: Record<string, number>,
  rows: SubjectRow[],
) {
  const [finalization] = await db.sql<{ id: string }[]>`
    INSERT INTO app.result_finalizations (
      school_id, academic_year_id, section_id, term_id, version, finalized_by_user_id
    )
    VALUES (
      ${tenant.schoolId}::uuid, ${yearId}::uuid, ${sectionId}::uuid, NULL, 1,
      ${tenant.users.ORG_ADMIN.id}::uuid
    )
    RETURNING id
  `;
  for (const [student, average] of Object.entries(overall)) {
    await db.sql`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, average_percentage, total_obtained,
        total_max, grade_label, subjects_failed, academic_status, result_format, result_scale_max,
        result_value
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids[student]!}::uuid, 'complete',
        ${average}, ${average * 2}, 200, NULL, 0, 'promoted', 'gpa', 4, 3
      )
    `;
  }
  for (const row of rows) {
    await db.sql`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, status, percentage, marks_obtained,
        max_marks, grade_label, gpa_points, passed, include_in_average, include_on_certificate,
        is_descriptive, credits, config_snapshot, breakdown
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids[row.student]!}::uuid,
        ${ids[row.subject]!}::uuid, 'complete', ${row.percentage}, ${row.percentage}, 100, NULL,
        ${row.gpa}, true, true, true, false, NULL,
        ${db.sql.json({
          version: 1,
          subject: { id: ids[row.subject], code: row.subject.toUpperCase(), name: row.subject },
          requirement: "mandatory",
          include_in_average: true,
          include_on_certificate: true,
          average_weight: 1,
          program: { rounding: { decimals: 2, mode: "half_up" } },
        } as never)}::jsonb,
        ${db.sql.json({} as never)}::jsonb
      )
    `;
  }
}

const IGCSE_GRADES = [
  { grade: "A*", percentage: 98 },
  { grade: "A", percentage: 93 },
  { grade: "B", percentage: 85 },
  { grade: "C", percentage: 75 },
];

const blankPart = {
  weight: 100,
  required: true,
  exam_ids: [] as string[],
  best_count: null,
  min_count: null,
  required_subject_ids: [] as string[],
  grade_percentages: [] as typeof IGCSE_GRADES,
  conversion: null,
  require_awarded: false,
  gpa_basis: null,
};

function igcseBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "IGCSE equivalency",
    source_system: "igcse_a_level",
    grade_level_ids: [ids.grade12],
    parts: [
      {
        ...blankPart,
        type: "exam_subjects",
        label: "IGCSE subjects",
        exam_ids: [ids.igcse],
        best_count: 3,
        required_subject_ids: [ids.arabic],
        grade_percentages: IGCSE_GRADES,
      },
    ],
    ...overrides,
  };
}

function americanBody() {
  return {
    name: "American equivalency",
    source_system: "american",
    grade_level_ids: [ids.grade12],
    visible_to_students_and_parents: true,
    parts: [
      {
        ...blankPart,
        type: "gpa",
        label: "GPA",
        weight: 70,
        gpa_basis: "gpa",
        conversion: { mode: "linear", bands: [], slope: 25, intercept: 0 },
      },
      {
        ...blankPart,
        type: "exam_total",
        label: "SAT",
        weight: 30,
        required: false,
        exam_ids: [ids.sat],
        conversion: {
          mode: "table",
          bands: [
            { min: 1200, percentage: 85 },
            { min: 1300, percentage: 90 },
          ],
          slope: null,
          intercept: null,
        },
      },
    ],
  };
}

describeDb("tawjihi equivalency and multi-year results", () => {
  test("setup: two years, placements, last year's results and exam results", async () => {
    ids.amal = tenant.students[0]!.id;
    ids.amalUser = tenant.students[0]!.userId;
    const badr = await createStudent(db.sql, tenant.schoolId, { firstName: "Badr" });
    ids.badr = badr.id;
    ids.badrUser = badr.userId;
    await assignRole(db.sql, tenant.schoolId, badr.userId, ROLES.STUDENT);
    for (const [key, name] of [
      ["math", "Mathematics"],
      ["arabic", "Arabic"],
      ["physics", "Physics"],
      ["art", "Art"],
    ] as const) {
      ids[key] = (
        await createSubject(db.sql, tenant.schoolId, { code: key.toUpperCase(), name })
      ).id;
    }
    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Amal's parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Equivalency family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.amal}::uuid, 'father')
    `;
    ids.parent = parent.id;

    const lastYear = new Date().getFullYear() - 1;
    const [previous] = await db.sql<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${tenant.schoolId}::uuid, ${`PY-${tenant.schoolSlug}`}, 'Last year',
              ${`${lastYear}-01-01`}::date, ${`${lastYear}-12-31`}::date, 'closed')
      RETURNING id
    `;
    ids.previousYear = previous!.id;
    await withTenantTx(
      client!,
      { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id },
      async (tx) => {
        ids.grade11 = (
          await createGradeLevel(tx, tenant.schoolId, { name: "Grade 11", sort_order: 11 })
        ).id;
        ids.grade12 = (
          await createGradeLevel(tx, tenant.schoolId, { name: "Grade 12", sort_order: 12 })
        ).id;
        ids.section11 = (
          await createSection(tx, tenant.schoolId, {
            academic_year_id: ids.previousYear!,
            grade_level_id: ids.grade11,
            name: "11A",
          })
        ).id;
        ids.section12 = (
          await createSection(tx, tenant.schoolId, {
            academic_year_id: tenant.academicYear.id,
            grade_level_id: ids.grade12,
            name: "12A",
          })
        ).id;
      },
    );
    for (const student of [ids.amal!, ids.badr!]) {
      await db.sql`
        INSERT INTO app.student_sections (school_id, student_id, academic_year_id, section_id)
        VALUES
          (${tenant.schoolId}::uuid, ${student}::uuid, ${ids.previousYear!}::uuid, ${ids.section11!}::uuid),
          (${tenant.schoolId}::uuid, ${student}::uuid, ${tenant.academicYear.id}::uuid, ${ids.section12!}::uuid)
      `;
    }
    await seedFinalization(ids.previousYear!, ids.section11!, { amal: 85, badr: 65 }, [
      { student: "amal", subject: "math", percentage: 90, gpa: 4 },
      { student: "amal", subject: "arabic", percentage: 80, gpa: 3 },
      { student: "badr", subject: "math", percentage: 60, gpa: 2 },
      { student: "badr", subject: "arabic", percentage: 70, gpa: 2 },
    ]);

    const igcse = await call<{ id: string; components: { id: string }[] }>(
      "POST",
      "/api/grading/external-exams/from-preset",
      adminAuth(),
      { preset_key: "igcse_letter" },
    );
    expect(igcse.status).toBe(201);
    ids.igcse = igcse.body.id;
    for (const [subject, grade] of [
      ["math", "A*"],
      ["arabic", "A"],
      ["physics", "B"],
      ["art", "C"],
    ] as const) {
      const recorded = await call(
        "POST",
        `/api/grading/students/${ids.amal}/external-exam-results`,
        adminAuth(),
        {
          exam_id: ids.igcse,
          subject_id: ids[subject],
          sat_on: "2026-06-01",
          scores: [{ component_id: igcse.body.components[0]!.id, label_score: grade }],
        },
      );
      expect(recorded.status).toBe(201);
    }
    const sat = await call<{ id: string; components: { id: string }[] }>(
      "POST",
      "/api/grading/external-exams/from-preset",
      adminAuth(),
      { preset_key: "sat" },
    );
    ids.sat = sat.body.id;
    const recorded = await call(
      "POST",
      `/api/grading/students/${ids.badr}/external-exam-results`,
      adminAuth(),
      {
        exam_id: ids.sat,
        sat_on: "2026-10-03",
        scores: [
          { component_id: sat.body.components[0]!.id, numeric_score: 650 },
          { component_id: sat.body.components[1]!.id, numeric_score: 700 },
        ],
      },
    );
    expect(recorded.status).toBe(201);
  });

  test("leadership adds rule sets; the parts are checked", async () => {
    const created = await call<EquivalencyRuleSetView>("POST", SETS, adminAuth(), igcseBody());
    expect(created.status).toBe(201);
    igcseSet = created.body;
    expect(igcseSet).toMatchObject({
      name: "IGCSE equivalency",
      source_system: "igcse_a_level",
      is_active: true,
      visible_to_students_and_parents: false,
      grade_levels: [{ id: ids.grade12, name: "Grade 12" }],
      exams: [{ id: ids.igcse, code: "IGCSE" }],
      subjects: [{ id: ids.arabic, name: "Arabic" }],
    });
    expect(igcseSet.parts[0]).toMatchObject({ type: "exam_subjects", best_count: 3 });

    const american = await call<EquivalencyRuleSetView>("POST", SETS, adminAuth(), americanBody());
    expect(american.status).toBe(201);
    americanSet = american.body;

    expect(
      (await call("POST", SETS, adminAuth(), igcseBody({ name: "igcse EQUIVALENCY" }))).status,
    ).toBe(409);
    for (const parts of [
      [],
      [{ ...igcseBody().parts[0], grade_percentages: [] }],
      [{ ...blankPart, type: "gpa", label: "GPA" }],
      // Another school's exam is unknown here.
      [{ ...igcseBody().parts[0], exam_ids: [otherTenant.subject.id] }],
    ]) {
      const rejected = await call("POST", SETS, adminAuth(), igcseBody({ name: "Other", parts }));
      expect(rejected.status).toBe(400);
    }
  });

  test("teachers read the sets; only leadership changes them; other schools see none", async () => {
    const list = await call<{ sets: EquivalencyRuleSetView[] }>("GET", SETS, teacherAuth());
    expect(list.status).toBe(200);
    expect(list.body.sets.map((set) => set.name)).toEqual([
      "American equivalency",
      "IGCSE equivalency",
    ]);
    expect((await call("POST", SETS, teacherAuth(), igcseBody({ name: "X" }))).status).toBe(403);
    expect((await call("GET", SETS, amalAuth())).status).toBe(403);
    expect((await call("DELETE", `${SETS}/${igcseSet.id}`, teacherAuth())).status).toBe(403);
    const listPath = `${SETS}/${igcseSet.id}/students?academic_year_id=${tenant.academicYear.id}&grade_level_id=${ids.grade12}`;
    expect((await call("GET", listPath, teacherAuth())).status).toBe(403);

    const other = await call<{ sets: EquivalencyRuleSetView[] }>("GET", SETS, otherAdminAuth());
    expect(other.body.sets).toEqual([]);
    expect(
      (await call("PUT", `${SETS}/${igcseSet.id}`, otherAdminAuth(), igcseBody())).status,
    ).toBe(404);
    expect((await call("DELETE", `${SETS}/${igcseSet.id}`, otherAdminAuth())).status).toBe(404);
  });

  test("a student's estimates, step by step", async () => {
    const amal = await call<StudentEquivalencyView>("GET", estimatePath(ids.amal!), adminAuth());
    expect(amal.status).toBe(200);
    expect(amal.body).toMatchObject({
      grade_level: { id: ids.grade12, name: "Grade 12" },
      current_year_pending: true,
    });
    const [american, igcse] = amal.body.estimates;
    // Arabic (required) 93, then the best two: Mathematics 98, Physics 85 -> 92.
    expect(igcse).toMatchObject({ status: "estimated", percentage: 92 });
    expect(
      igcse!.parts[0]!.subjects.map((step) => [step.subject.name, step.grade, step.counted]),
    ).toEqual([
      ["Mathematics", "A*", true],
      ["Arabic", "A", true],
      ["Physics", "B", true],
      ["Art", "C", false],
    ]);
    // GPA (4 + 3) / 2 = 3.5 -> 87.5; no SAT, so the GPA counts alone.
    expect(american).toMatchObject({ status: "estimated", percentage: 87.5 });
    expect(american!.parts.map((part) => [part.status, part.source_value])).toEqual([
      ["counted", 3.5],
      ["skipped", null],
    ]);
    expect(american!.issues.map((found) => found.code)).toEqual([
      "CURRENT_YEAR_PENDING",
      "NO_EXAM_TOTAL",
      "OPTIONAL_PART_SKIPPED",
    ]);

    const badr = await call<StudentEquivalencyView>("GET", estimatePath(ids.badr!), adminAuth());
    const [badrAmerican, badrIgcse] = badr.body.estimates;
    // GPA 2 -> 50 (x 0.7) + SAT 1350 -> 90 (x 0.3) = 62.
    expect(badrAmerican).toMatchObject({ status: "estimated", percentage: 62 });
    expect(badrIgcse!.status).toBe("incomplete");
    expect(badrIgcse!.issues.map((found) => [found.code, found.kind])).toEqual([
      ["NO_EXAM_RESULTS", "missing"],
    ]);
  });

  test("the grade-level list estimates every student placed in the grade", async () => {
    const list = await call<EquivalencyStudentListView>(
      "GET",
      `${SETS}/${igcseSet.id}/students?academic_year_id=${tenant.academicYear.id}&grade_level_id=${ids.grade12}`,
      adminAuth(),
    );
    expect(list.status).toBe(200);
    expect(list.body.applies_to_grade_level).toBe(true);
    expect(
      list.body.students.map((student) => [student.student_id, student.status, student.percentage]),
    ).toEqual(
      expect.arrayContaining([
        [ids.amal, "estimated", 92],
        [ids.badr, "incomplete", null],
      ]),
    );
    expect(list.body.students[0]!.section_name).toBe("12A");
    expect(
      (
        await call(
          "GET",
          `${SETS}/${igcseSet.id}/students?academic_year_id=${tenant.academicYear.id}&grade_level_id=${ids.grade12}`,
          otherAdminAuth(),
        )
      ).status,
    ).toBe(404);
  });

  test("students and parents see only the sets shown to them, and only their own", async () => {
    for (const as of [amalAuth(), parentAuth()]) {
      const seen = await call<StudentEquivalencyView>("GET", estimatePath(ids.amal!), as);
      expect(seen.status).toBe(200);
      expect(seen.body.estimates.map((estimate) => estimate.set.name)).toEqual([
        "American equivalency",
      ]);
    }
    const teacher = await call<StudentEquivalencyView>(
      "GET",
      estimatePath(ids.amal!),
      teacherAuth(),
    );
    expect(teacher.body.estimates).toHaveLength(2);

    const shown = await call<EquivalencyRuleSetView>(
      "PUT",
      `${SETS}/${igcseSet.id}`,
      adminAuth(),
      igcseBody({ visible_to_students_and_parents: true }),
    );
    expect(shown.status).toBe(200);
    const family = await call<StudentEquivalencyView>("GET", estimatePath(ids.amal!), parentAuth());
    const igcse = family.body.estimates.find((estimate) => estimate.set.id === igcseSet.id)!;
    // Subject names reach the parent through the SECURITY DEFINER helpers.
    expect(igcse.parts[0]!.subjects.map((step) => step.subject.name)).toContain("Arabic");

    expect((await call("GET", estimatePath(ids.amal!), badrAuth())).status).toBe(403);
    expect((await call("GET", estimatePath(ids.badr!), parentAuth())).status).toBe(403);
    expect(
      (await call("GET", estimatePath(ids.amal!), auth(tenant.users.INSTRUCTOR.id, "INSTRUCTOR")))
        .status,
    ).toBe(403);
    expect((await call("GET", estimatePath(ids.amal!), otherAdminAuth())).status).toBe(404);
  });

  test("multi-year configurations: checked, read by staff, managed by leadership", async () => {
    const created = await call<MultiYearConfigView>("POST", CONFIGS, adminAuth(), {
      name: "Tawjihi two years",
      years: [
        { grade_level_id: ids.grade11, weight: 40 },
        { grade_level_id: ids.grade12, weight: 60 },
      ],
    });
    expect(created.status).toBe(201);
    twoYear = created.body;
    expect(twoYear.years.map((year) => [year.grade_level.name, year.weight])).toEqual([
      ["Grade 11", 40],
      ["Grade 12", 60],
    ]);
    for (const years of [
      [{ grade_level_id: ids.grade11, weight: 40 }],
      [
        { grade_level_id: ids.grade11, weight: 40 },
        { grade_level_id: ids.grade11, weight: 60 },
      ],
      [
        { grade_level_id: ids.grade11, weight: 0 },
        { grade_level_id: ids.grade12, weight: 60 },
      ],
    ]) {
      expect((await call("POST", CONFIGS, adminAuth(), { name: "Other", years })).status).toBe(400);
    }
    expect(
      (
        await call("POST", CONFIGS, adminAuth(), {
          name: "TAWJIHI TWO YEARS",
          years: [
            { grade_level_id: ids.grade11, weight: 1 },
            { grade_level_id: ids.grade12, weight: 1 },
          ],
        })
      ).status,
    ).toBe(409);
    expect((await call("GET", CONFIGS, teacherAuth())).status).toBe(200);
    expect((await call("GET", CONFIGS, amalAuth())).status).toBe(403);
    expect((await call("DELETE", `${CONFIGS}/${twoYear.id}`, teacherAuth())).status).toBe(403);
    expect((await call("DELETE", `${CONFIGS}/${twoYear.id}`, otherAdminAuth())).status).toBe(404);
  });

  test("a multi-year result is pending while a year is not finalized", async () => {
    const amal = await call<StudentMultiYearResultsView>(
      "GET",
      multiYearPath(ids.amal!),
      adminAuth(),
    );
    expect(amal.status).toBe(200);
    const [result] = amal.body.results;
    expect(result).toMatchObject({ status: "pending", overall_percentage: null });
    expect(result!.years.map((year) => [year.status, year.overall_percentage, year.share])).toEqual(
      [
        ["finalized", 85, 40],
        ["pending", null, 60],
      ],
    );

    // Hidden from the family until shown.
    expect(
      (await call<StudentMultiYearResultsView>("GET", multiYearPath(ids.amal!), parentAuth())).body
        .results,
    ).toEqual([]);
    const shown = await call("PUT", `${CONFIGS}/${twoYear.id}`, adminAuth(), {
      name: "Tawjihi two years",
      visible_to_students_and_parents: true,
      years: [
        { grade_level_id: ids.grade11, weight: 40 },
        { grade_level_id: ids.grade12, weight: 60 },
      ],
    });
    expect(shown.status).toBe(200);
    for (const as of [amalAuth(), parentAuth()]) {
      const seen = await call<StudentMultiYearResultsView>("GET", multiYearPath(ids.amal!), as);
      expect(seen.body.results).toHaveLength(1);
    }
    expect((await call("GET", multiYearPath(ids.badr!), parentAuth())).status).toBe(403);
    expect((await call("GET", multiYearPath(ids.amal!), otherAdminAuth())).status).toBe(404);
  });

  test("once every year is finalized, the weighted result per subject and overall", async () => {
    await seedFinalization(tenant.academicYear.id, ids.section12!, { amal: 82.5 }, [
      { student: "amal", subject: "math", percentage: 70, gpa: 2 },
      { student: "amal", subject: "physics", percentage: 95, gpa: 4 },
    ]);
    const amal = await call<StudentMultiYearResultsView>(
      "GET",
      multiYearPath(ids.amal!),
      amalAuth(),
    );
    const [result] = amal.body.results;
    // 0.4 x 85 + 0.6 x 82.5 = 83.5
    expect(result).toMatchObject({ status: "complete", overall_percentage: 83.5 });
    expect(
      result!.subjects.map((subject) => [subject.name, subject.percentage, subject.years_counted]),
    ).toEqual([
      ["arabic", 80, 1],
      // 0.4 x 90 + 0.6 x 70 = 78
      ["math", 78, 2],
      ["physics", 95, 1],
    ]);

    // Badr's grade 12 result is not finalized yet and he is in grade 12: still pending.
    const badr = await call<StudentMultiYearResultsView>(
      "GET",
      multiYearPath(ids.badr!),
      adminAuth(),
    );
    expect(badr.body.results[0]!.status).toBe("pending");

    expect((await call("DELETE", `${CONFIGS}/${twoYear.id}`, adminAuth())).status).toBe(204);
    expect((await call("DELETE", `${SETS}/${americanSet.id}`, adminAuth())).status).toBe(204);
    const audits = await db.sql<{ target_table: string; action: string }[]>`
      SELECT target_table, action::text AS action FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid
        AND target_table IN ('equivalency_rule_sets', 'multi_year_result_configs')
      ORDER BY created_at
    `;
    expect(audits.map((row) => `${row.target_table}:${row.action}`)).toEqual(
      expect.arrayContaining([
        "equivalency_rule_sets:insert",
        "equivalency_rule_sets:update",
        "equivalency_rule_sets:delete",
        "multi_year_result_configs:insert",
        "multi_year_result_configs:update",
        "multi_year_result_configs:delete",
      ]),
    );
    expect(
      (await call<StudentMultiYearResultsView>("GET", multiYearPath(ids.amal!), adminAuth())).body
        .results,
    ).toEqual([]);
  });
});
