/**
 * Remedial plans (000268) end to end, against a real migrated database with RLS armed: suggestions
 * from current marks, a teacher opening and updating plans, the coordinator and leadership following
 * them up, reviews going overdue and done, a teacher of another class seeing nothing, the student
 * and parents seeing only shared plans of their own child (never internal notes) while the school
 * allows sharing, the audit trail and tenant isolation. Later tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/remedial-plans/__tests__/remedial-plans.integration.test.ts
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
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../../../../tests/harness";
import { withTenantTx } from "../../../db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../academics/section-service";
import {
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../../grading/config-service";
import { saveMarks } from "../../grading/marks-service";

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
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & {
      code?: string;
      plans?: Record<string, unknown>[];
      notes?: Record<string, unknown>[];
      reviews?: Record<string, unknown>[];
      suggestions?: Record<string, unknown>[];
    },
  };
}

const authOf = (userId: string, role: keyof typeof ROLES, schoolId = tenant.schoolId) =>
  ({ schoolId, userId, roles: [ROLES[role]] }) as TestAuthContext;

/** A subject with one annual final exam out of 100, pass at 50%. */
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

const sectionPath = (section: string) =>
  `/api/grading/sections/${ids[section]}/subjects/${ids.math}/remedial-plans`;
const planPath = (plan = "plan") => `/api/grading/remedial-plans/${ids[plan]}`;
const studentPath = (student: string) => `/api/grading/students/${ids[student]}/remedial-plans`;

const leader = () => authOf(tenant.users.ORG_ADMIN.id, "ORG_ADMIN");
const teacherA = () => authOf(ids.teacherA!, "INSTRUCTOR");
const teacherB = () => authOf(ids.teacherB!, "INSTRUCTOR");
const coordinator = () => authOf(ids.coordinator!, "INSTRUCTOR");
const parent = () => authOf(ids.parent!, "PARENT");
const studentS1 = () => authOf(ids.s1User!, "STUDENT");

/** A date `days` from today in the school's timezone (UTC for a school without settings). */
const dayFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const NEW_PLAN = () => ({
  section_id: ids.sec10a,
  subject_id: ids.math,
  student_id: ids.s1,
  term_id: null,
  reason: "below_pass",
  reason_note: "  Struggles with algebra  ",
  targets: "Solve linear equations",
  actions: "Weekly practice sheet and a lunchtime session",
  review_dates: [dayFromToday(14), dayFromToday(-3), dayFromToday(-3)],
  shared_with_family: false,
});

describeDb("remedial plans", () => {
  test("setup: grade 10 math in two sections, marks recorded, a coordinator and a parent", async () => {
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MTH", name: "Math" })).id;
    const a = tenant.teachers[0]!;
    const b = await createTeacher(db.sql, tenant.schoolId);
    const coord = await createTeacher(db.sql, tenant.schoolId);
    for (const teacher of [a, b, coord]) {
      await assignRole(db.sql, tenant.schoolId, teacher.userId, ROLES.INSTRUCTOR);
    }
    ids.teacherA = a.userId;
    ids.teacherB = b.userId;
    ids.coordinator = coord.userId;
    ids.s1 = tenant.students[0]!.id;
    ids.s1User = tenant.students[0]!.userId;
    await assignRole(db.sql, tenant.schoolId, ids.s1User, ROLES.STUDENT);
    ids.s2 = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Badr", lastName: "B" })
    ).id;
    ids.s3 = (
      await createStudent(db.sql, tenant.schoolId, { firstName: "Cala", lastName: "C" })
    ).id;

    const parentUser = await createUser(db.sql, tenant.schoolId, { displayName: "S1 parent" });
    await assignRole(db.sql, tenant.schoolId, parentUser.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Remedial family', ${parentUser.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parentUser.id}::uuid, ${ids.s1}::uuid, 'father')
    `;
    ids.parent = parentUser.id;

    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, {
        name: "Grade 10",
        sort_order: 10,
      });
      ids.g10 = grade.id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        grade_scale_id: null,
        mark_approval_required: false,
      });
      await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: grade.id,
          sectionId: null,
          subjectId: ids.math!,
        },
        CONFIG,
      );
      for (const [key, students, teacher] of [
        ["sec10a", ["s1", "s2"], a.id],
        ["sec10b", ["s3"], b.id],
      ] as const) {
        const section = await createSection(tx, tenant.schoolId, {
          academic_year_id: tenant.academicYear.id,
          grade_level_id: grade.id,
          name: key.slice(3).toUpperCase(),
        });
        ids[key] = section.id;
        for (const student of students) {
          await placeStudentInSection(tx, tenant.schoolId, section.id, ids[student]!);
        }
        await createTeacherAssignment(tx, tenant.schoolId, {
          section_id: section.id,
          subject_id: ids.math!,
          teacher_id: teacher,
        });
      }
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });

    const [assessment] = await db.sql<{ id: string }[]>`
      SELECT assessment.id FROM app.subject_config_assessments AS assessment
      JOIN app.subject_configs AS config ON config.id = assessment.subject_config_id
      WHERE config.subject_id = ${ids.math!}::uuid AND config.grade_level_id = ${ids.g10!}::uuid
    `;
    const mark = (student: string, score: number) => ({
      assessment_id: assessment!.id,
      student_id: ids[student]!,
      attempt: 1 as const,
      status: "graded" as const,
      score,
      remarks: null,
    });
    await as(ids.teacherA!, (tx) =>
      saveMarks(tx, tenant.schoolId, ids.teacherA!, ids.sec10a!, ids.math!, [
        mark("s1", 40),
        mark("s2", 80),
      ]),
    );
    await as(ids.teacherB!, (tx) =>
      saveMarks(tx, tenant.schoolId, ids.teacherB!, ids.sec10b!, ids.math!, [mark("s3", 30)]),
    );
    const coordinatorAssignment = await call(
      "POST",
      `/api/grading/years/${tenant.academicYear.id}/subject-coordinators`,
      leader(),
      { subject_id: ids.math, user_id: ids.coordinator, grade_level_ids: [ids.g10] },
    );
    expect(coordinatorAssignment.status).toBe(201);
  });

  test("the teacher sees the students below the pass line on current marks", async () => {
    const view = await call("GET", sectionPath("sec10a"), teacherA());
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      section_id: ids.sec10a,
      subject_name: "Math",
      term_id: null,
      access: "teacher",
      can_create: true,
      family_sharing_enabled: false,
      pass_percentage: 50,
      plans: [],
    });
    expect(view.body.suggestions).toEqual([
      {
        student_id: ids.s1,
        first_name: expect.any(String),
        last_name: expect.any(String),
        admission_number: expect.any(String),
        percentage: 40,
        provisional: false,
        active_plan_id: null,
      },
    ]);
    expect((view.body.students as unknown[]).length).toBe(2);

    // The coordinator reads it, but does not open plans; a teacher of another class reads nothing.
    const coord = await call("GET", sectionPath("sec10a"), coordinator());
    expect(coord.status).toBe(200);
    expect(coord.body).toMatchObject({ access: "coordinator", can_create: false });
    const other = await call("GET", sectionPath("sec10a"), teacherB());
    expect(other.status).toBe(403);
  });

  test("the teacher opens a plan; duplicates, other classes and non-writers are refused", async () => {
    const created = await call("POST", "/api/grading/remedial-plans", teacherA(), NEW_PLAN());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      student_id: ids.s1,
      subject_name: "Math",
      section_name: "10A",
      grade_level_name: "Grade 10",
      reason: "below_pass",
      reason_note: "Struggles with algebra",
      status: "open",
      start_percentage: 40,
      pass_percentage: 50,
      shared_with_family: false,
      next_review_on: dayFromToday(-3),
      overdue: true,
      access: "teacher",
      can_edit: true,
      can_add_note: true,
      notes: [],
    });
    expect(created.body.reviews).toEqual([
      { review_on: dayFromToday(-3), completed_at: null, overdue: true },
      { review_on: dayFromToday(14), completed_at: null, overdue: false },
    ]);
    ids.plan = created.body.id as string;

    const duplicate = await call("POST", "/api/grading/remedial-plans", teacherA(), NEW_PLAN());
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe(ERROR_CODES.REMEDIAL_PLAN_DUPLICATE);

    const notTaking = await call("POST", "/api/grading/remedial-plans", teacherA(), {
      ...NEW_PLAN(),
      student_id: ids.s3,
    });
    expect(notTaking.status).toBe(400);

    for (const auth of [teacherB(), coordinator()]) {
      const refused = await call("POST", "/api/grading/remedial-plans", auth, NEW_PLAN());
      expect(refused.status).toBe(403);
    }
    const byParent = await call("POST", "/api/grading/remedial-plans", parent(), NEW_PLAN());
    expect(byParent.status).toBe(403);

    // The suggestion now points at the plan.
    const view = await call("GET", sectionPath("sec10a"), teacherA());
    expect(view.body.suggestions?.[0]).toMatchObject({ active_plan_id: ids.plan });
  });

  test("a teacher of another class sees nothing, through the API or the database", async () => {
    expect((await call("GET", planPath(), teacherB())).status).toBe(404);
    const list = await call("GET", "/api/grading/remedial-plans", teacherB());
    expect(list.status).toBe(200);
    expect(list.body.plans).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain(ids.plan!);
    expect((await call("GET", studentPath("s1"), teacherB())).status).toBe(403);
    expect(
      (await call("POST", `${planPath()}/notes`, teacherB(), { body: "Hi", internal: false }))
        .status,
    ).toBe(404);
    for (const table of ["remedial_plans", "remedial_plan_reviews"]) {
      const rows = await as(ids.teacherB!, (tx) => tx.unsafe(`SELECT 1 FROM app.${table}`));
      expect(rows.length).toBe(0);
    }
    // RLS refuses a direct write too.
    const write = as(
      ids.teacherB!,
      (tx) => tx`UPDATE app.remedial_plans SET targets = 'x' WHERE id = ${ids.plan!}::uuid`,
    );
    expect((await write).count).toBe(0);
  });

  test("leadership lists plans by grade, subject, status and overdue reviews", async () => {
    const list = await call(
      "GET",
      `/api/grading/remedial-plans?grade_level_id=${ids.g10}&subject_id=${ids.math}&status=open&overdue=true`,
      leader(),
    );
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      academic_year_id: tenant.academicYear.id,
      counts: { open: 1, in_progress: 0, achieved: 0, closed: 0, overdue: 1 },
      truncated: false,
    });
    expect(list.body.plans?.map((plan) => plan.id)).toEqual([ids.plan]);
    expect(list.body.plans?.[0]).toMatchObject({
      student_id: ids.s1,
      grade_level_id: ids.g10,
      overdue: true,
    });
    const notOverdue = await call("GET", "/api/grading/remedial-plans?overdue=false", leader());
    expect(notOverdue.body.plans).toEqual([]);
    const closed = await call("GET", "/api/grading/remedial-plans?status=closed", leader());
    expect(closed.body.plans).toEqual([]);
    // Students and parents have no staff list.
    const asParent = await call("GET", "/api/grading/remedial-plans", parent());
    expect(asParent.body.plans).toEqual([]);
  });

  test("the coordinator follows up with a note that completes the overdue review", async () => {
    const detail = await call("GET", planPath(), coordinator());
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      access: "coordinator",
      can_edit: false,
      can_add_note: true,
    });
    expect(
      (await call("PATCH", planPath(), coordinator(), { targets: "Something else" })).status,
    ).toBe(403);

    const noted = await call("POST", `${planPath()}/notes`, coordinator(), {
      body: "Spoke with the teacher; parents not told yet",
      internal: true,
    });
    expect(noted.status).toBe(201);
    expect(noted.body).toMatchObject({ overdue: false, next_review_on: dayFromToday(14) });
    expect(noted.body.reviews?.[0]).toMatchObject({
      overdue: false,
      completed_at: expect.any(String),
    });
    expect(noted.body.notes).toEqual([
      expect.objectContaining({
        kind: "note",
        internal: true,
        author_access: "coordinator",
        body: "Spoke with the teacher; parents not told yet",
      }),
    ]);
    const list = await call("GET", "/api/grading/remedial-plans", coordinator());
    expect(list.body.plans?.map((plan) => plan.id)).toEqual([ids.plan]);
  });

  test("the teacher moves the plan forward; the timeline records it; it never moves back", async () => {
    const updated = await call("PATCH", planPath(), teacherA(), {
      status: "in_progress",
      status_note: "Sessions started",
      actions: "Two sessions a week",
      review_dates: [dayFromToday(-3), dayFromToday(30)],
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: "in_progress", actions: "Two sessions a week" });
    // The kept date stays done; the dropped one is gone.
    expect(updated.body.reviews).toEqual([
      { review_on: dayFromToday(-3), completed_at: expect.any(String), overdue: false },
      { review_on: dayFromToday(30), completed_at: null, overdue: false },
    ]);
    expect(updated.body.notes?.at(-1)).toMatchObject({
      kind: "status_change",
      new_status: "in_progress",
      body: "Sessions started",
      internal: false,
      author_access: "teacher",
    });
    const back = await call("PATCH", planPath(), teacherA(), { status: "open" });
    expect(back.status).toBe(400);
    expect(back.body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("the student and parents see a plan only when shared and allowed, never internal notes", async () => {
    // Not shared, sharing not allowed: nothing.
    for (const auth of [parent(), studentS1()]) {
      const own = await call("GET", studentPath("s1"), auth);
      expect(own.status).toBe(200);
      expect(own.body.plans).toEqual([]);
      expect((await call("GET", planPath(), auth)).status).toBe(404);
    }

    // Shared, but the school does not allow sharing yet: still nothing.
    expect((await call("PATCH", planPath(), teacherA(), { shared_with_family: true })).status).toBe(
      200,
    );
    expect((await call("GET", studentPath("s1"), parent())).body.plans).toEqual([]);

    // Only leadership with academicConfig:manage changes the school's setting.
    expect(
      (
        await call("PUT", "/api/grading/remedial-plan-settings", teacherA(), {
          family_visible: true,
        })
      ).status,
    ).toBe(403);
    const settings = await call("PUT", "/api/grading/remedial-plan-settings", leader(), {
      family_visible: true,
    });
    expect(settings.status).toBe(200);
    expect(settings.body).toEqual({ family_visible: true });

    for (const auth of [parent(), studentS1()]) {
      const own = await call("GET", studentPath("s1"), auth);
      expect(own.status).toBe(200);
      expect(own.body.plans?.length).toBe(1);
      const plan = own.body.plans![0]!;
      expect(plan).toMatchObject({
        id: ids.plan,
        subject_name: "Math",
        access: "family",
        can_edit: false,
        can_add_note: false,
        family_sharing_enabled: true,
      });
      // The coordinator's internal note is withheld; the status change is not internal.
      expect((plan.notes as { internal: boolean }[]).every((note) => !note.internal)).toBe(true);
      expect(JSON.stringify(plan)).not.toContain("parents not told yet");
      expect((await call("GET", planPath(), auth)).status).toBe(200);
    }
    // The parent reads only their own child, cannot write, and RLS hides internal notes.
    expect((await call("GET", studentPath("s2"), parent())).status).toBe(403);
    expect(
      (await call("POST", `${planPath()}/notes`, parent(), { body: "Thanks", internal: false }))
        .status,
    ).toBe(403);
    const notes = await as(ids.parent!, (tx) => tx`SELECT internal FROM app.remedial_plan_notes`);
    expect(notes.map((row) => row.internal)).toEqual([false]);

    // Turning the setting off hides the plan again at once.
    await call("PUT", "/api/grading/remedial-plan-settings", leader(), { family_visible: false });
    expect((await call("GET", studentPath("s1"), parent())).body.plans).toEqual([]);
  });

  test("an achieved plan is history; a new plan for the student can then be opened", async () => {
    const achieved = await call("PATCH", planPath(), teacherA(), { status: "achieved" });
    expect(achieved.status).toBe(200);
    expect(achieved.body).toMatchObject({ status: "achieved", can_edit: false, overdue: false });
    const locked = await call("PATCH", planPath(), teacherA(), { targets: "More" });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe(ERROR_CODES.REMEDIAL_PLAN_CLOSED);

    const again = await call("POST", "/api/grading/remedial-plans", teacherA(), {
      ...NEW_PLAN(),
      reason: "teacher_concern",
      review_dates: [],
    });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ next_review_on: null, overdue: false });
    // A term plan is another period.
    const term = await call("POST", "/api/grading/remedial-plans", leader(), {
      ...NEW_PLAN(),
      term_id: tenant.term.id,
      review_dates: [],
    });
    expect(term.status).toBe(201);
    expect(term.body).toMatchObject({ term_id: tenant.term.id, access: "leadership" });
  });

  test("every write is audited", async () => {
    const rows = await db.sql<{ action: string; target_table: string }[]>`
      SELECT action::text, target_table FROM app.audit_logs
      WHERE school_id = ${tenant.schoolId}::uuid
        AND target_table IN ('remedial_plans', 'remedial_plan_notes', 'school_settings')
      ORDER BY created_at
    `;
    const count = (table: string, action: string) =>
      rows.filter((row) => row.target_table === table && row.action === action).length;
    expect(count("remedial_plans", "insert")).toBe(3);
    expect(count("remedial_plans", "update")).toBe(3);
    expect(count("remedial_plan_notes", "insert")).toBe(1);
    expect(count("school_settings", "update")).toBe(2);
  });

  test("another school reaches nothing", async () => {
    const outsider = authOf(otherTenant.users.ORG_ADMIN.id, "ORG_ADMIN", otherTenant.schoolId);
    expect((await call("GET", planPath(), outsider)).status).toBe(404);
    const list = await call("GET", "/api/grading/remedial-plans", outsider);
    expect(JSON.stringify(list.body)).not.toContain(ids.plan!);
    expect(
      (await call("POST", `${planPath()}/notes`, outsider, { body: "x", internal: false })).status,
    ).toBe(404);
    const rows = await withTenantTx(
      client!,
      { schoolId: otherTenant.schoolId, userId: otherTenant.users.ORG_ADMIN.id },
      (tx) => tx`SELECT id FROM app.remedial_plans`,
    );
    expect(rows.length).toBe(0);
  });
});
