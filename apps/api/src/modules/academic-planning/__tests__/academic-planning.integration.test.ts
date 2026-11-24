/**
 * Learning outcomes, outcome achievement, and lesson and term plans (000268) end to end, against a
 * real migrated database with RLS armed: leadership manages the catalogue (and imports it from
 * CSV), teachers record achievement and write plans, the subject's coordinator and leadership
 * review them, finalization copies achievement onto report cards when the school shows it, and a
 * teacher of another class, a coordinator of another subject and another school see nothing. Later
 * tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/academic-planning/__tests__/academic-planning.integration.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  assignRole,
  authenticatedRequest,
  createClass,
  createCourse,
  createFullTenant,
  createMaterial,
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
import { publishTimetableVersion } from "../../academics/timetable-service";
import {
  createScale,
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../../grading/config-service";
import { createSubjectCoordinator } from "../../grading/coordinator-service";
import { finalizeSection } from "../../grading/results-service";
import { readOutcomeSnapshot } from "../report-snapshot";

import type {
  TestApp,
  TestAuthContext,
  TestDatabase,
  TenantFixture,
} from "../../../../tests/harness";
import type { SubjectConfigInput } from "../../grading/config-service";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
let otherTenant: TenantFixture;
const ids = {} as Record<string, string>;
const year = new Date().getFullYear();

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

const errorCode = (body: Record<string, unknown>) =>
  (body.error as { code: string } | undefined)?.code ?? body.code;

const authOf = (userId: string, role: keyof typeof ROLES, schoolId = tenant.schoolId) =>
  ({ schoolId, userId, roles: [ROLES[role]] }) as TestAuthContext;

const leader = () => authOf(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
const teacherA = () => authOf(ids.teacherA!, "INSTRUCTOR");
const teacherB = () => authOf(ids.teacherB!, "INSTRUCTOR");
const coordinator = () => authOf(ids.coordinator!, "INSTRUCTOR");
const scienceCoordinator = () => authOf(ids.scienceCoordinator!, "INSTRUCTOR");

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

const sectionSubject = (section: string, subject: string) =>
  `/api/grading/sections/${ids[section]}/subjects/${ids[subject]}`;
const achievementsPath = (section: string, subject: string, termId?: string | null) =>
  `${sectionSubject(section, subject)}/outcome-achievements${termId ? `?term_id=${termId}` : ""}`;

describeDb("lesson plans and learning outcomes", () => {
  test("setup: grades 10 and 11, math and science, a math coordinator for grade 10", async () => {
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MTH", name: "Math" })).id;
    ids.science = (
      await createSubject(db.sql, tenant.schoolId, { code: "SCI", name: "Science" })
    ).id;
    const a = tenant.teachers[0]!;
    const b = await createTeacher(db.sql, tenant.schoolId);
    const c = await createTeacher(db.sql, tenant.schoolId);
    const s = await createTeacher(db.sql, tenant.schoolId);
    for (const teacher of [a, b, c, s]) {
      await assignRole(db.sql, tenant.schoolId, teacher.userId, ROLES.INSTRUCTOR);
    }
    ids.teacherA = a.userId;
    ids.teacherARecord = a.id;
    ids.teacherB = b.userId;
    ids.coordinator = c.userId;
    ids.scienceCoordinator = s.userId;
    ids.s10a = tenant.students[0]!.id;
    ids.s10aUser = tenant.students[0]!.userId;
    const other = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Badr",
      lastName: "B",
    });
    ids.s10b = other.id;
    ids.s10bUser = other.userId;

    await admin(async (tx) => {
      const scale = await createScale(tx, tenant.schoolId, tenant.academicYear.id, {
        name: "Percent",
        bands: [
          { label: "A", min_percentage: 80, gpa_points: null },
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
        ["sec10a", "g10", "s10a", a.id],
        ["sec10b", "g10", "s10b", b.id],
        ["sec11a", "g11", null, a.id],
      ] as const) {
        const section = await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: ids[grade]!,
          name: key.slice(3).toUpperCase(),
        });
        ids[key] = section.id;
        if (student) await placeStudentInSection(tx, tenant.schoolId, section.id, ids[student]!);
        await createTeacherAssignment(tx, tenant.schoolId, {
          section_id: section.id,
          subject_id: ids.math!,
          teacher_id: teacher,
        });
      }
      await createTeacherAssignment(tx, tenant.schoolId, {
        section_id: ids.sec10b!,
        subject_id: ids.science!,
        teacher_id: b.id,
      });
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
      await createSubjectCoordinator(tx, tenant.schoolId, tenant.academicYear.id, {
        subject_id: ids.math!,
        user_id: ids.coordinator!,
        grade_level_ids: [ids.g10!],
      });
      await createSubjectCoordinator(tx, tenant.schoolId, tenant.academicYear.id, {
        subject_id: ids.science!,
        user_id: ids.scienceCoordinator!,
        grade_level_ids: [],
      });
    });

    // 10A's math class, with an uploaded material and a live timetable: period 3 on every weekday.
    const course = await createCourse(db.sql, tenant.schoolId, ids.math!, { code: "MTH-10A" });
    const cls = await createClass(db.sql, tenant.schoolId, {
      courseId: course.id,
      academicYearId: tenant.academicYear.id,
      termId: tenant.term.id,
      leadTeacherId: a.id,
      roomId: tenant.room.id,
    });
    await db.sql`UPDATE app.classes SET section_id = ${ids.sec10a!}::uuid WHERE id = ${cls.id}::uuid`;
    ids.material = (
      await createMaterial(db.sql, tenant.schoolId, {
        classId: cls.id,
        uploadedByUserId: ids.teacherA!,
        title: "Fractions worksheet",
      })
    ).id;
    ids.otherMaterial = (
      await createMaterial(db.sql, tenant.schoolId, {
        classId: tenant.cls.id,
        uploadedByUserId: ids.teacherA!,
        title: "Unrelated",
      })
    ).id;
    const [version] = await db.sql<{ id: string }[]>`
      INSERT INTO app.timetable_versions (school_id, academic_year_id, term_id, name)
      VALUES (${tenant.schoolId}::uuid, ${tenant.academicYear.id}::uuid, ${tenant.term.id}::uuid, 'Live')
      RETURNING id
    `;
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      await db.sql`
        INSERT INTO app.timetable_slots (school_id, timetable_version_id, class_id, teacher_id, weekday, period)
        VALUES (${tenant.schoolId}::uuid, ${version!.id}::uuid, ${cls.id}::uuid, ${a.id}::uuid,
                ${weekday}, 3)
      `;
    }
    await admin((tx) =>
      publishTimetableVersion(tx, tenant.schoolId, version!.id, tenant.users.ORG_ADMIN.id),
    );
  });

  test("leadership manages the catalogue; teachers read it, never write it", async () => {
    const create = (body: Record<string, unknown>, auth = leader()) =>
      call("POST", "/api/grading/learning-outcomes", auth, body);
    const m1 = await create({
      subject_id: ids.math,
      grade_level_id: ids.g10,
      code: "M10.1",
      text: "Adds fractions",
      text_ar: "يجمع الكسور",
      strand: "Number",
      sort_order: 1,
    });
    expect(m1.status).toBe(201);
    expect(m1.body).toMatchObject({ code: "M10.1", grade_level_name: "Grade 10", in_use: false });
    ids.m1 = m1.body.id as string;
    ids.m2 = (
      await create({
        subject_id: ids.math,
        grade_level_id: ids.g10,
        code: "M10.2",
        text: "Ratios",
        sort_order: 2,
      })
    ).body.id as string;
    ids.m11 = (
      await create({
        subject_id: ids.math,
        grade_level_id: ids.g11,
        code: "M11.1",
        text: "Algebra",
      })
    ).body.id as string;
    ids.s1 = (
      await create({
        subject_id: ids.science,
        grade_level_id: ids.g10,
        code: "S10.1",
        text: "Cells",
      })
    ).body.id as string;

    const repeat = await create({
      subject_id: ids.math,
      grade_level_id: ids.g10,
      code: "M10.1",
      text: "x",
    });
    expect(repeat.status).toBe(409);
    expect(errorCode(repeat.body)).toBe(ERROR_CODES.LEARNING_OUTCOME_DUPLICATE);
    expect(
      (
        await create(
          { subject_id: ids.math, grade_level_id: ids.g10, code: "T", text: "t" },
          teacherA(),
        )
      ).status,
    ).toBe(403);

    const list = await call(
      "GET",
      `/api/grading/learning-outcomes?subject_id=${ids.math}&grade_level_id=${ids.g10}`,
      teacherA(),
    );
    expect(list.status).toBe(200);
    expect((list.body.outcomes as { code: string }[]).map((o) => o.code)).toEqual([
      "M10.1",
      "M10.2",
    ]);

    // Another school's catalogue is not this one's.
    const foreign = await call(
      "GET",
      "/api/grading/learning-outcomes",
      authOf(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant.schoolId),
    );
    expect(foreign.body.outcomes).toEqual([]);
    expect(
      (
        await call(
          "PATCH",
          `/api/grading/learning-outcomes/${ids.m1}`,
          authOf(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant.schoolId),
          { text: "hijack" },
        )
      ).status,
    ).toBe(404);
  });

  test("CSV import: a dry run and errors write nothing; a clean file adds and updates", async () => {
    const path = "/api/grading/learning-outcomes/import";
    const csv = [
      "subject,grade,code,text,text_ar,strand",
      "MTH,Grade 10,M10.2,Ratios and rates,,Number",
      "MTH,Grade 10,M10.3,Percentages,النسب المئوية,Number",
    ].join("\n");
    const dry = await call("POST", path, leader(), { csv, dry_run: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ applied: false, created: 1, updated: 1, errors: [] });

    const broken = await call("POST", path, leader(), {
      csv: `${csv}\nXXX,Grade 10,X1,Unknown subject\nMTH,Grade 99,X2,Unknown grade`,
    });
    expect(broken.body.applied).toBe(false);
    expect((broken.body.errors as { line: number }[]).map((e) => e.line)).toEqual([4, 5]);
    expect((await call("POST", path, leader(), { csv: "code,text\nA,B" })).status).toBe(400);

    const applied = await call("POST", path, leader(), { csv });
    expect(applied.body).toMatchObject({ applied: true, created: 1, updated: 1 });
    const again = await call("POST", path, leader(), { csv });
    expect(again.body).toMatchObject({ applied: true, created: 0, updated: 0, unchanged: 2 });
    expect((await call("POST", path, teacherA(), { csv })).status).toBe(403);
  });

  test("settings: defaults, then a school scale; teachers cannot change them", async () => {
    const path = "/api/grading/planning-settings";
    const defaults = await call("GET", path, teacherA());
    expect(defaults.body).toMatchObject({
      show_outcomes_on_report_cards: false,
      lesson_plan_lead_days: 1,
      term_plan_due_days: 7,
      achievement_levels_default: true,
    });
    expect((defaults.body.achievement_levels as unknown[]).length).toBe(4);
    expect((await call("PUT", path, teacherA(), { lesson_plan_lead_days: 0 })).status).toBe(403);

    // Due dates every submission in this file misses, whatever day the suite runs on.
    const saved = await call("PUT", path, leader(), {
      lesson_plan_lead_days: 30,
      term_plan_due_days: -90,
      achievement_levels: [
        { label: "Emerging", label_ar: "ناشئ" },
        { label: "Developing" },
        { label: "Secure" },
        { label: "Mastered" },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.achievement_levels).toEqual([
      { level: 1, label: "Emerging", label_ar: "ناشئ" },
      { level: 2, label: "Developing", label_ar: null },
      { level: 3, label: "Secure", label_ar: null },
      { level: 4, label: "Mastered", label_ar: null },
    ]);
  });

  test("achievement: the teacher records it; others read or see nothing", async () => {
    const termId = tenant.term.id;
    const sheet = await call("GET", achievementsPath("sec10a", "math", termId), teacherA());
    expect(sheet.status).toBe(200);
    expect(sheet.body).toMatchObject({ access: "teacher", editable: true, term_id: termId });
    expect((sheet.body.outcomes as { code: string }[]).map((o) => o.code)).toEqual([
      "M10.1",
      "M10.2",
      "M10.3",
    ]);

    const save = (body: unknown, auth = teacherA()) =>
      call("PUT", achievementsPath("sec10a", "math"), auth, body);
    const saved = await save({
      term_id: termId,
      achievements: [
        { student_id: ids.s10a, outcome_id: ids.m1, level: 4 },
        { student_id: ids.s10a, outcome_id: ids.m2, level: 2 },
      ],
    });
    expect(saved.status).toBe(200);
    const student = (saved.body.students as { student_id: string; achievements: unknown[] }[]).find(
      (s) => s.student_id === ids.s10a,
    );
    expect(student?.achievements).toHaveLength(2);

    // Off the scale, another grade's outcome, a student of another section: refused.
    expect(
      (
        await save({
          term_id: termId,
          achievements: [{ student_id: ids.s10a, outcome_id: ids.m1, level: 9 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await save({
          term_id: termId,
          achievements: [{ student_id: ids.s10a, outcome_id: ids.m11, level: 1 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await save({
          term_id: termId,
          achievements: [{ student_id: ids.s10b, outcome_id: ids.m1, level: 1 }],
        })
      ).status,
    ).toBe(400);

    // Teacher B teaches 10B, not 10A; the coordinator reads but never writes; the science
    // coordinator and another school see nothing.
    expect((await call("GET", achievementsPath("sec10a", "math", termId), teacherB())).status).toBe(
      403,
    );
    expect(
      (
        await save(
          {
            term_id: termId,
            achievements: [{ student_id: ids.s10a, outcome_id: ids.m1, level: 1 }],
          },
          teacherB(),
        )
      ).status,
    ).toBe(403);
    const coordinated = await call(
      "GET",
      achievementsPath("sec10a", "math", termId),
      coordinator(),
    );
    expect(coordinated.body).toMatchObject({ access: "coordinator", editable: false });
    expect(
      (
        await save(
          {
            term_id: termId,
            achievements: [{ student_id: ids.s10a, outcome_id: ids.m1, level: 1 }],
          },
          coordinator(),
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("GET", achievementsPath("sec10a", "math", termId), scienceCoordinator())).status,
    ).toBe(403);
    expect(
      (
        await call(
          "GET",
          achievementsPath("sec10a", "math", termId),
          authOf(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant.schoolId),
        )
      ).status,
    ).toBe(404);

    // RLS agrees: teacher B and the science coordinator read no rows at all.
    for (const user of [ids.teacherB!, ids.scienceCoordinator!]) {
      const rows = await as(user, (tx) => tx`SELECT id FROM app.student_outcome_achievements`);
      expect(rows.length).toBe(0);
    }
    expect(
      (await as(ids.coordinator!, (tx) => tx`SELECT id FROM app.student_outcome_achievements`))
        .length,
    ).toBe(2);
  });

  test("a level in use stays on the scale; a used outcome is archived, not deleted", async () => {
    const shrink = await call("PUT", "/api/grading/planning-settings", leader(), {
      achievement_levels: [{ label: "No" }, { label: "Yes" }],
    });
    expect(shrink.status).toBe(409);
    const remove = await call("DELETE", `/api/grading/learning-outcomes/${ids.m1}`, leader());
    expect(remove.status).toBe(409);
    expect(errorCode(remove.body)).toBe(ERROR_CODES.LEARNING_OUTCOME_IN_USE);
    expect(
      (await call("DELETE", `/api/grading/learning-outcomes/${ids.m11}`, leader())).status,
    ).toBe(204);
  });

  test("term plans: the teacher drafts and submits; the coordinator returns and approves", async () => {
    const path = `${sectionSubject("sec10a", "math")}/term-plans`;
    const body = {
      term_id: tenant.term.id,
      notes: "Number first",
      weeks: [
        { week_number: 1, unit: "Fractions", outcome_ids: [ids.m1] },
        { week_number: 2, unit: "Ratios", notes: "Group work", outcome_ids: [ids.m2] },
      ],
    };
    const created = await call("POST", path, teacherA(), body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "draft", can_edit: true, can_review: false });
    expect((created.body.weeks as { outcomes: { code: string }[] }[])[0]!.outcomes[0]!.code).toBe(
      "M10.1",
    );
    ids.termPlan = created.body.id as string;
    const plan = `/api/grading/term-plans/${ids.termPlan}`;

    expect((await call("POST", path, teacherA(), body)).status).toBe(409);
    expect((await call("POST", path, teacherB(), body)).status).toBe(403);
    expect((await call("POST", path, coordinator(), body)).status).toBe(403);
    // Teacher B, the science coordinator and another school do not see it at all.
    expect((await call("GET", plan, teacherB())).status).toBe(404);
    expect((await call("GET", plan, scienceCoordinator())).status).toBe(404);
    expect(
      (
        await call(
          "GET",
          plan,
          authOf(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant.schoolId),
        )
      ).status,
    ).toBe(404);
    expect((await call("GET", path, teacherB())).status).toBe(403);

    // A draft is not reviewable.
    expect(
      (await call("POST", `${plan}/review`, coordinator(), { decision: "approve" })).status,
    ).toBe(409);
    const submitted = await call("POST", `${plan}/submit`, teacherA());
    expect(submitted.body).toMatchObject({ status: "submitted", on_time: false });
    expect(
      (await call("POST", `${plan}/review`, scienceCoordinator(), { decision: "approve" })).status,
    ).toBe(404);
    expect((await call("POST", `${plan}/review`, teacherA(), { decision: "approve" })).status).toBe(
      403,
    );
    expect(
      (await call("POST", `${plan}/review`, coordinator(), { decision: "return" })).status,
    ).toBe(400);
    const returned = await call("POST", `${plan}/review`, coordinator(), {
      decision: "return",
      comment: "Add week 3",
    });
    expect(returned.body).toMatchObject({ status: "returned", review_comment: "Add week 3" });

    const edited = await call("PUT", plan, teacherA(), {
      notes: "Number first",
      weeks: [...body.weeks, { week_number: 3, unit: "Percentages", outcome_ids: [ids.m2] }],
    });
    expect(edited.body).toMatchObject({ status: "returned" });
    expect((edited.body.weeks as unknown[]).length).toBe(3);
    await call("POST", `${plan}/submit`, teacherA());
    const approved = await call("POST", `${plan}/review`, coordinator(), { decision: "approve" });
    expect(approved.body).toMatchObject({
      status: "approved",
      reviewed_by_user_id: ids.coordinator,
    });
    expect((await call("PUT", plan, teacherA(), body)).status).toBe(409);
    expect((await call("DELETE", plan, teacherA())).status).toBe(409);

    const audit = await db.sql<{ new_values: { status?: string } }[]>`
      SELECT new_values FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid AND target_table = 'term_plans'
        AND target_id = ${ids.termPlan!}::uuid AND action = 'update'
      ORDER BY created_at
    `;
    expect(audit.map((row) => row.new_values.status).filter(Boolean)).toEqual([
      "submitted",
      "returned",
      "submitted",
      "approved",
    ]);
  });

  test("lesson plans: timetable periods, materials, review by leadership, reflection", async () => {
    const date = `${year}-01-05`;
    const options = await call(
      "GET",
      `${sectionSubject("sec10a", "math")}/lesson-plan-options?date=${date}`,
      teacherA(),
    );
    expect(options.status).toBe(200);
    expect(options.body.periods).toEqual([3]);
    expect((options.body.materials as { title: string }[]).map((m) => m.title)).toEqual([
      "Fractions worksheet",
    ]);

    const path = `${sectionSubject("sec10a", "math")}/lesson-plans`;
    const body = {
      lesson_date: date,
      period: 3,
      title: "Adding fractions",
      objectives: "Add unlike fractions",
      activities: "Pairs",
      homework: "Sheet 1",
      outcome_ids: [ids.m1],
      material_ids: [ids.material],
    };
    expect(
      (await call("POST", path, teacherA(), { ...body, material_ids: [ids.otherMaterial] })).status,
    ).toBe(400);
    expect(
      (await call("POST", path, teacherA(), { ...body, lesson_date: `${year + 3}-01-01` })).status,
    ).toBe(400);
    const created = await call("POST", path, teacherA(), body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      term_id: tenant.term.id,
      period: 3,
      materials: [{ id: ids.material, title: "Fractions worksheet" }],
    });
    ids.lesson = created.body.id as string;
    const plan = `/api/grading/lesson-plans/${ids.lesson}`;

    expect((await call("GET", plan, teacherB())).status).toBe(404);
    // The coordinator sees the linked material's title even without reading the class's files.
    expect((await call("GET", plan, coordinator())).body.materials).toEqual([
      { id: ids.material, title: "Fractions worksheet" },
    ]);

    await call("POST", `${plan}/submit`, teacherA());
    const queue = await call("GET", "/api/grading/plan-reviews", coordinator());
    expect((queue.body.lesson_plans as { id: string }[]).map((p) => p.id)).toEqual([ids.lesson]);
    const empty = await call("GET", "/api/grading/plan-reviews", scienceCoordinator());
    expect(empty.body.lesson_plans).toEqual([]);
    expect(empty.body.term_plans).toEqual([]);
    expect((await call("GET", "/api/grading/plan-reviews", teacherB())).body.lesson_plans).toEqual(
      [],
    );

    const approved = await call("POST", `${plan}/review`, leader(), { decision: "approve" });
    expect(approved.body).toMatchObject({ status: "approved", can_edit: false });
    const reflected = await call("PUT", `${plan}/reflection`, teacherA(), {
      reflection: "Most pairs finished",
    });
    expect(reflected.body).toMatchObject({ reflection: "Most pairs finished", status: "approved" });
    expect((await call("PUT", `${plan}/reflection`, teacherB(), { reflection: "x" })).status).toBe(
      404,
    );
  });

  test("coverage: leadership sees every section, a coordinator their subject's", async () => {
    const path = `/api/grading/plan-coverage?term_id=${tenant.term.id}`;
    const all = await call("GET", path, leader());
    expect(all.status).toBe(200);
    interface Row {
      section_id: string;
      subject_id: string;
      term_plan: { status: string; on_time: boolean } | null;
      lesson_plans: { total: number; approved: number; on_time: number; late: number };
      outcomes: { total: number; covered: number };
    }
    const rows = all.body.rows as Row[];
    const math10a = rows.find((r) => r.section_id === ids.sec10a && r.subject_id === ids.math)!;
    expect(math10a.term_plan).toMatchObject({ status: "approved", on_time: false });
    expect(math10a.lesson_plans).toMatchObject({ total: 1, approved: 1, on_time: 0, late: 1 });
    expect(math10a.outcomes).toEqual({ total: 3, covered: 2 });
    expect(rows.some((r) => r.subject_id === ids.science)).toBe(true);
    expect(rows.some((r) => r.section_id === ids.sec11a)).toBe(true);

    const mine = (await call("GET", path, coordinator())).body.rows as Row[];
    // Math in grade 10 only: not grade 11, not science.
    expect(mine.every((r) => r.subject_id === ids.math && r.section_id !== ids.sec11a)).toBe(true);
    expect(mine.length).toBe(2);
    const science = (await call("GET", path, scienceCoordinator())).body.rows as Row[];
    expect(science.map((r) => r.subject_id)).toEqual([ids.science]);
    expect((await call("GET", path, teacherA())).body.rows).toEqual([]);
  });

  test("report cards: achievement is copied at finalization when the school shows it", async () => {
    await call("PUT", "/api/grading/planning-settings", leader(), {
      show_outcomes_on_report_cards: true,
    });
    await call("PUT", achievementsPath("sec10a", "math"), teacherA(), {
      term_id: null,
      achievements: [{ student_id: ids.s10a, outcome_id: ids.m1, level: 3 }],
    });
    await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.sec10a!, null, {
        allowIncomplete: true,
      }),
    );

    const results = await call(
      "GET",
      `/api/grading/students/${ids.s10a}/results`,
      authOf(ids.s10aUser!, "STUDENT"),
    );
    expect(results.status).toBe(200);
    const rows = results.body.results as {
      result: { subjects: { subject_id: string; outcomes: unknown[] }[] };
    }[];
    const math = rows[0]!.result.subjects.find((s) => s.subject_id === ids.math)!;
    expect(math.outcomes).toEqual([
      {
        outcome_id: ids.m1,
        code: "M10.1",
        text: "Adds fractions",
        text_ar: "يجمع الكسور",
        strand: "Number",
        level: 3,
        label: "Secure",
        label_ar: null,
      },
    ]);

    // The period is locked; another student never reads this one's snapshot.
    const locked = await call("PUT", achievementsPath("sec10a", "math"), teacherA(), {
      term_id: null,
      achievements: [{ student_id: ids.s10a, outcome_id: ids.m1, level: 1 }],
    });
    expect(locked.status).toBe(409);
    expect(errorCode(locked.body)).toBe(ERROR_CODES.RESULTS_ALREADY_FINALIZED);
    const [finalization] = await db.sql<{ id: string }[]>`
      SELECT id FROM app.result_finalizations WHERE section_id = ${ids.sec10a!}::uuid
    `;
    const leaked = await as(ids.s10bUser!, (tx) =>
      readOutcomeSnapshot(tx, tenant.schoolId, finalization!.id),
    );
    expect(leaked.size).toBe(0);
    const teacherBView = await as(ids.teacherB!, (tx) =>
      readOutcomeSnapshot(tx, tenant.schoolId, finalization!.id),
    );
    expect(teacherBView.size).toBe(0);
  });
});
