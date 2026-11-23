/**
 * Graduation requirements (000258) against a real migrated database with RLS armed.
 *
 * Grade 12 this year (active, not finalized yet); grade 11 last year (closed, finalized).
 *
 *   Last year   Amal: English 11 85 (B 3, 1 credit), Algebra 92 (A 4, 1 credit), PE pass/fail
 *                     passed (0.5 credit, out of the average)            -> 2.5 credits, GPA 3.5
 *               Badr: English 11 55 failed (F 0), Algebra 70 (C 2), PE failed -> 1 credit, GPA 1
 *   This year   Amal: English 12 80 (B 3, 1 credit) -> 3.5 credits, GPA 3.33
 *               Badr: English 12 40 failed          -> 1 credit, GPA 0.67
 *   Amal sat the SAT: 650 + 700 = 1350.
 *
 * "High school diploma" (grade 12): 2 credits; 2 English credits; Algebra passed; GPA 2; SAT 1200.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/graduation-requirements/__tests__/graduation-requirements.integration.test.ts
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
import type { TranscriptView } from "../../grading/transcript-service";
import type {
  GraduationChecklistView,
  GraduationPreviewView,
  GraduationReportView,
  GraduationSetView,
} from "../service";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let http: TestApp;
let tenant: TenantFixture;
let otherTenant: TenantFixture;

const ids = {} as Record<string, string>;
let diploma: GraduationSetView;

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

const SETS = "/api/grading/graduation-requirement-sets";
const checklistPath = (studentId: string) =>
  `/api/grading/students/${studentId}/graduation-requirements`;
const reportPath = () =>
  `/api/grading/graduation-requirements/report?academic_year_id=${tenant.academicYear.id}&grade_level_id=${ids.grade12}`;

interface SubjectRow {
  student: string;
  subject: string;
  percentage: number | null;
  gpa: number | null;
  credits: number;
  passed: boolean;
  descriptive?: boolean;
}

/** One finalized annual result for a section, as finalization would store it. */
async function seedFinalization(yearId: string, sectionId: string, rows: SubjectRow[]) {
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
  for (const student of new Set(rows.map((row) => row.student))) {
    await db.sql`
      INSERT INTO app.student_overall_results (
        school_id, finalization_id, student_id, status, average_percentage, total_obtained,
        total_max, grade_label, subjects_failed, academic_status
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids[student]!}::uuid, 'complete',
        70, 140, 200, NULL, 0, 'promoted'
      )
    `;
  }
  for (const row of rows) {
    const descriptive = row.descriptive === true;
    await db.sql`
      INSERT INTO app.student_subject_results (
        school_id, finalization_id, student_id, subject_id, status, percentage, marks_obtained,
        max_marks, grade_label, gpa_points, passed, include_in_average, include_on_certificate,
        is_descriptive, credits, config_snapshot, breakdown
      )
      VALUES (
        ${tenant.schoolId}::uuid, ${finalization!.id}::uuid, ${ids[row.student]!}::uuid,
        ${ids[row.subject]!}::uuid, 'complete', ${row.percentage}, ${row.percentage}, 100, NULL,
        ${row.gpa}, ${row.passed}, ${!descriptive}, true, ${descriptive}, ${row.credits},
        ${db.sql.json({
          version: 1,
          subject: { id: ids[row.subject], code: row.subject.toUpperCase(), name: row.subject },
          requirement: descriptive ? "optional" : "mandatory",
          include_in_average: !descriptive,
          include_on_certificate: true,
          average_weight: 1,
          credits: row.credits,
          program: { rounding: { decimals: 2, mode: "half_up" } },
        } as never)}::jsonb,
        ${db.sql.json((descriptive ? { descriptive: true } : {}) as never)}::jsonb
      )
    `;
  }
  return finalization!.id;
}

function setBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "High school diploma",
    grade_level_ids: [ids.grade12],
    rules: [
      { type: "total_credits", min_value: 2 },
      {
        type: "group_credits",
        min_value: 2,
        group_name: "English",
        subject_ids: [ids.english11, ids.english12],
      },
      { type: "subjects_passed", group_name: "Core", subject_ids: [ids.algebra] },
      { type: "cumulative_gpa", min_value: 2 },
      { type: "external_exam", external_exam_id: ids.sat, min_value: 1200 },
    ],
    ...overrides,
  };
}

describeDb("graduation requirements", () => {
  test("setup: two years of grade levels, sections, placements and last year's results", async () => {
    ids.amal = tenant.students[0]!.id;
    ids.amalUser = tenant.students[0]!.userId;
    const badr = await createStudent(db.sql, tenant.schoolId, { firstName: "Badr" });
    ids.badr = badr.id;
    ids.badrUser = badr.userId;
    await assignRole(db.sql, tenant.schoolId, badr.userId, ROLES.STUDENT);
    for (const [key, name] of [
      ["english11", "English 11"],
      ["english12", "English 12"],
      ["algebra", "Algebra"],
      ["pe", "Physical Education"],
    ] as const) {
      ids[key] = (
        await createSubject(db.sql, tenant.schoolId, { code: key.toUpperCase(), name })
      ).id;
    }
    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Amal's parent" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Graduation family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.amal}::uuid, 'mother')
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
    await seedFinalization(ids.previousYear!, ids.section11!, [
      { student: "amal", subject: "english11", percentage: 85, gpa: 3, credits: 1, passed: true },
      { student: "amal", subject: "algebra", percentage: 92, gpa: 4, credits: 1, passed: true },
      {
        student: "amal",
        subject: "pe",
        percentage: null,
        gpa: null,
        credits: 0.5,
        passed: true,
        descriptive: true,
      },
      { student: "badr", subject: "english11", percentage: 55, gpa: 0, credits: 1, passed: false },
      { student: "badr", subject: "algebra", percentage: 70, gpa: 2, credits: 1, passed: true },
      {
        student: "badr",
        subject: "pe",
        percentage: null,
        gpa: null,
        credits: 0.5,
        passed: false,
        descriptive: true,
      },
    ]);

    const sat = await call<{ id: string; components: { id: string }[] }>(
      "POST",
      "/api/grading/external-exams/from-preset",
      adminAuth(),
      { preset_key: "sat" },
    );
    expect(sat.status).toBe(201);
    ids.sat = sat.body.id;
    const recorded = await call(
      "POST",
      `/api/grading/students/${ids.amal}/external-exam-results`,
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

  test("leadership adds a set; each rule is checked", async () => {
    const created = await call<GraduationSetView>("POST", SETS, adminAuth(), setBody());
    expect(created.status).toBe(201);
    diploma = created.body;
    expect(diploma).toMatchObject({
      name: "High school diploma",
      is_active: true,
      visible_to_students_and_parents: false,
      applies_from_academic_year: null,
      grade_levels: [{ id: ids.grade12, name: "Grade 12" }],
    });
    expect(diploma.rules.map((rule) => rule.type)).toEqual([
      "total_credits",
      "group_credits",
      "subjects_passed",
      "cumulative_gpa",
      "external_exam",
    ]);
    expect(diploma.rules[1]!.subjects.map((subject) => subject.name)).toEqual([
      "English 11",
      "English 12",
    ]);
    expect(diploma.rules[4]!.external_exam?.code).toBe("SAT");

    // Same name in any case: a conflict.
    const duplicate = await call(
      "POST",
      SETS,
      adminAuth(),
      setBody({ name: "HIGH SCHOOL DIPLOMA" }),
    );
    expect(duplicate.status).toBe(409);

    for (const rules of [
      [{ type: "group_credits", min_value: 2, group_name: "English", subject_ids: [] }],
      [{ type: "cumulative_gpa", min_value: 12 }],
      [{ type: "subjects_passed", group_name: "Core", subject_ids: [ids.algebra], min_value: 1 }],
      [{ type: "external_exam" }],
      // Another school's subject is unknown here.
      [{ type: "subjects_passed", group_name: "Core", subject_ids: [otherTenant.subject.id] }],
    ]) {
      const rejected = await call("POST", SETS, adminAuth(), setBody({ name: "Other", rules }));
      expect(rejected.status).toBe(400);
    }
    const otherGrade = await call(
      "POST",
      SETS,
      adminAuth(),
      setBody({ name: "Other", grade_level_ids: [ids.grade12, ids.grade12] }),
    );
    expect(otherGrade.status).toBe(400);
  });

  test("teachers read the sets; only leadership changes them; other schools see none", async () => {
    const teacherList = await call<{ sets: GraduationSetView[] }>("GET", SETS, teacherAuth());
    expect(teacherList.status).toBe(200);
    expect(teacherList.body.sets.map((set) => set.id)).toEqual([diploma.id]);
    // The subjects a rule names are shown to staff.
    expect(teacherList.body.sets[0]!.rules[2]!.subjects.map((s) => s.name)).toEqual(["Algebra"]);

    expect((await call("POST", SETS, teacherAuth(), setBody({ name: "X" }))).status).toBe(403);
    expect((await call("GET", SETS, amalAuth())).status).toBe(403);
    expect((await call("DELETE", `${SETS}/${diploma.id}`, teacherAuth())).status).toBe(403);
    expect((await call("GET", reportPath(), teacherAuth())).status).toBe(403);

    const other = await call<{ sets: GraduationSetView[] }>("GET", SETS, otherAdminAuth());
    expect(other.body.sets).toEqual([]);
    expect((await call("PUT", `${SETS}/${diploma.id}`, otherAdminAuth(), setBody())).status).toBe(
      404,
    );
    expect((await call("DELETE", `${SETS}/${diploma.id}`, otherAdminAuth())).status).toBe(404);
  });

  test("while this year is not finalized, rules not met yet are pending", async () => {
    const amal = await call<GraduationChecklistView>("GET", checklistPath(ids.amal!), adminAuth());
    expect(amal.status).toBe(200);
    expect(amal.body).toMatchObject({
      grade_level: { id: ids.grade12, name: "Grade 12" },
      current_year_pending: true,
      years_counted: 1,
    });
    const [set] = amal.body.sets;
    expect(set).toMatchObject({ status: "pending", rules_met: 3, rules_total: 5 });
    const rules = set!.rules.map((rule) => [rule.status, rule.current, rule.required]);
    expect(rules).toEqual([
      // The pass/fail PE half credit counts.
      ["met", 2.5, 2],
      ["pending", 1, 2],
      ["met", 1, 1],
      // Above the minimum, but this year can still lower it.
      ["pending", 3.5, 2],
      ["met", 1350, 1200],
    ]);

    const badr = await call<GraduationChecklistView>("GET", checklistPath(ids.badr!), adminAuth());
    expect(badr.body.sets[0]!.rules.map((rule) => rule.status)).toEqual([
      "pending",
      "pending",
      "met",
      "pending",
      "pending",
    ]);

    const report = await call<GraduationReportView>("GET", reportPath(), adminAuth());
    expect(report.status).toBe(200);
    expect(report.body.students_checked).toBe(2);
    expect(report.body.students.map((s) => [s.first_name, s.status])).toEqual(
      expect.arrayContaining([
        ["Badr", "pending"],
        ["Primary", "pending"],
      ]),
    );
  });

  test("students and parents see their checklist only when the set is shown to them", async () => {
    const hidden = await call<GraduationChecklistView>("GET", checklistPath(ids.amal!), amalAuth());
    expect(hidden.status).toBe(200);
    expect(hidden.body.sets).toEqual([]);
    const parentHidden = await call<GraduationChecklistView>(
      "GET",
      checklistPath(ids.amal!),
      parentAuth(),
    );
    expect(parentHidden.body.sets).toEqual([]);
    // The student's teacher is staff: every set.
    const teacher = await call<GraduationChecklistView>(
      "GET",
      checklistPath(ids.amal!),
      teacherAuth(),
    );
    expect(teacher.body.sets).toHaveLength(1);

    const shown = await call<GraduationSetView>(
      "PUT",
      `${SETS}/${diploma.id}`,
      adminAuth(),
      setBody({ visible_to_students_and_parents: true }),
    );
    expect(shown.status).toBe(200);
    diploma = shown.body;
    for (const as of [amalAuth(), parentAuth()]) {
      const visible = await call<GraduationChecklistView>("GET", checklistPath(ids.amal!), as);
      expect(visible.body.sets).toHaveLength(1);
      // Subject names come through even for a student.
      expect(visible.body.sets[0]!.rules[1]!.subjects.map((s) => s.name)).toEqual([
        "English 11",
        "English 12",
      ]);
      expect(visible.body.sets[0]!.rules[1]!.missing_subjects).toEqual([]);
    }

    // Nobody else: another student, an unrelated teacher, another school.
    expect(
      (await call("GET", checklistPath(ids.amal!), auth(ids.badrUser!, "STUDENT"))).status,
    ).toBe(403);
    expect(
      (await call("GET", checklistPath(ids.amal!), auth(tenant.users.INSTRUCTOR.id, "INSTRUCTOR")))
        .status,
    ).toBe(403);
    expect((await call("GET", checklistPath(ids.amal!), parentAuth())).status).toBe(200);
    expect((await call("GET", checklistPath(ids.badr!), parentAuth())).status).toBe(403);
    expect((await call("GET", checklistPath(ids.amal!), otherAdminAuth())).status).toBe(404);
  });

  test("an inactive set, or one from a later year, applies to nobody; a preview still checks it", async () => {
    const nextYear = new Date().getFullYear() + 1;
    const [later] = await db.sql<{ id: string }[]>`
      INSERT INTO app.academic_years (school_id, code, name, starts_on, ends_on, status)
      VALUES (${tenant.schoolId}::uuid, ${`NY-${tenant.schoolSlug}`}, 'Next year',
              ${`${nextYear}-01-01`}::date, ${`${nextYear}-12-31`}::date, 'planned')
      RETURNING id
    `;
    const future = await call<GraduationSetView>(
      "POST",
      SETS,
      adminAuth(),
      setBody({
        name: "New diploma",
        applies_from_academic_year_id: later!.id,
        rules: [{ type: "total_credits", min_value: 30 }],
      }),
    );
    expect(future.status).toBe(201);
    expect(future.body.applies_from_academic_year).toEqual({ id: later!.id, name: "Next year" });
    const inactive = await call<GraduationSetView>(
      "POST",
      SETS,
      adminAuth(),
      setBody({ name: "Retired diploma", is_active: false, rules: [] }),
    );
    expect(inactive.status).toBe(201);
    const checklist = await call<GraduationChecklistView>(
      "GET",
      checklistPath(ids.amal!),
      adminAuth(),
    );
    expect(checklist.body.sets.map((set) => set.set.name)).toEqual(["High school diploma"]);

    const preview = await call<GraduationPreviewView>(
      "GET",
      `${SETS}/${future.body.id}/preview?student_id=${ids.amal}`,
      adminAuth(),
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ applies: false, status: "pending", rules_met: 0 });
    expect(preview.body.rules[0]).toMatchObject({ current: 2.5, required: 30 });
    expect(
      (
        await call(
          "GET",
          `${SETS}/${future.body.id}/preview?student_id=${otherTenant.students[0]!.id}`,
          adminAuth(),
        )
      ).status,
    ).toBe(404);

    for (const set of [future.body, inactive.body]) {
      expect((await call("DELETE", `${SETS}/${set.id}`, adminAuth())).status).toBe(204);
    }
  });

  test("once this year is finalized, every rule is met or not met", async () => {
    await seedFinalization(tenant.academicYear.id, ids.section12!, [
      { student: "amal", subject: "english12", percentage: 80, gpa: 3, credits: 1, passed: true },
      { student: "badr", subject: "english12", percentage: 40, gpa: 0, credits: 1, passed: false },
    ]);
    const amal = await call<GraduationChecklistView>("GET", checklistPath(ids.amal!), adminAuth());
    expect(amal.body.current_year_pending).toBe(false);
    expect(amal.body.years_counted).toBe(2);
    expect(amal.body.sets[0]).toMatchObject({ status: "met", rules_met: 5 });
    expect(amal.body.sets[0]!.rules[3]).toMatchObject({ status: "met", current: 3.33 });

    const badr = await call<GraduationChecklistView>("GET", checklistPath(ids.badr!), adminAuth());
    const [set] = badr.body.sets;
    expect(set!.status).toBe("not_met");
    expect(set!.rules.map((rule) => [rule.status, rule.current, rule.required])).toEqual([
      ["not_met", 1, 2],
      ["not_met", 0, 2],
      ["met", 1, 1],
      ["not_met", 0.67, 2],
      ["not_met", null, 1200],
    ]);

    const report = await call<GraduationReportView>("GET", reportPath(), adminAuth());
    expect(report.body.students_checked).toBe(2);
    expect(report.body.students.map((s) => [s.student_id, s.status])).toEqual([
      [ids.badr, "not_met"],
    ]);
    expect(report.body.students[0]!.section_name).toBe("12A");
  });

  test("a transcript keeps the outcome as it stood at issue", async () => {
    const issued = await call<TranscriptView>(
      "POST",
      `/api/grading/students/${ids.amal}/transcripts`,
      adminAuth(),
    );
    expect(issued.status).toBe(201);
    expect(issued.body.content.graduation_requirements).toEqual([
      { name: "High school diploma", status: "met", rules_met: 5, rules_total: 5 },
    ]);
    // Out-of-average and pass/fail subjects earn credits on new transcripts too.
    expect(issued.body.content.cumulative).toMatchObject({
      credits_attempted: 3.5,
      credits_earned: 3.5,
    });

    expect((await call("DELETE", `${SETS}/${diploma.id}`, adminAuth())).status).toBe(204);
    const [audit] = await db.sql<{ action: string; old_values: { name: string } }[]>`
      SELECT action::text AS action, old_values FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'graduation_requirement_sets'
        AND target_id = ${diploma.id}::uuid AND action = 'delete'
    `;
    expect(audit?.old_values.name).toBe("High school diploma");

    const read = await call<TranscriptView>(
      "GET",
      `/api/grading/transcripts/${issued.body.id}`,
      adminAuth(),
    );
    expect(read.body.content.graduation_requirements?.[0]?.status).toBe("met");
    // No set applies any more: the checklist is empty and new transcripts carry no line.
    const checklist = await call<GraduationChecklistView>(
      "GET",
      checklistPath(ids.amal!),
      adminAuth(),
    );
    expect(checklist.body.sets).toEqual([]);
  });
});
