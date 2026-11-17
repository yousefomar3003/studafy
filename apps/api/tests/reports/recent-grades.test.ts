/**
 * The parent home's "Recent grades" (`GET /api/reports/children/recent-grades`): the newest
 * released exam marks and published gradebook grades across the calling parent's linked
 * children, read through the HTTP route the mobile app calls with RLS armed.
 *
 * One family with two children (Amal: an approved "First month" exam, a second exam that was
 * marked but never released, and a published gradebook grade; Badr: a published gradebook grade)
 * and a second family whose child (Carim) has marks of both kinds that must never leak.
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/reports/recent-grades.test.ts
 */

import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { withTenantTx } from "../../src/db/tenant-tx";
import {
  createGradeLevel,
  createSection,
  placeStudentInSection,
} from "../../src/modules/academics/section-service";
import {
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../../src/modules/grading/config-service";
import {
  decideAssessmentRelease,
  getMarkSheet,
  saveMarks,
  submitAssessmentRelease,
} from "../../src/modules/grading/marks-service";
import {
  assignRole,
  authenticatedRequest,
  createEnrollment,
  createFullTenant,
  createStudent,
  createSubject,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { SubjectConfigInput } from "../../src/modules/grading/config-service";
import type { MarkEntryInput } from "../../src/modules/grading/marks-service";
import type { TestApp, TestDatabase, TenantFixture } from "../harness";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;

let db: TestDatabase;
let client: ReturnType<typeof postgres> | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;
const ids = {} as Record<string, string>;

interface RecentGrade {
  kind: "exam" | "assignment";
  id: string;
  student_id: string;
  student_first_name: string;
  student_name: string;
  name: string;
  subject_name: string;
  term_name: string | null;
  released_at: string;
  attempt: number;
  status: string;
  score: number | null;
  max_score: number;
  descriptor_label: string | null;
}

const as = <T>(userId: string, fn: (tx: TransactionSql) => Promise<T>) =>
  withTenantTx(client!, { schoolId: tenant.schoolId, userId }, fn);
const admin = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.users.ORG_ADMIN.id, fn);
const teacherUser = () => tenant.teachers[0]!.userId;
const teacher = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(teacherUser(), fn);

const mark = (studentId: string, assessmentId: string, score: number): MarkEntryInput => ({
  assessment_id: assessmentId,
  student_id: studentId,
  attempt: 1,
  status: "graded",
  score,
  descriptor_id: null,
  remarks: null,
});

async function getRecent(userId: string, roles: Role[], query = "") {
  const response = await authenticatedRequest(
    harness!,
    "GET",
    `/api/reports/children/recent-grades${query}`,
    { schoolId: tenant.schoolId, userId, roles },
  );
  return {
    status: response.status,
    body: (await response.json()) as { items: RecentGrade[]; code?: string },
  };
}

/** A published gradebook grade for [studentId] in the fixture class, published now. */
async function publishGrade(studentId: string, label: string, score: number) {
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    const [gradebook] = await tx<{ id: string }[]>`
      INSERT INTO app.gradebooks (school_id, class_id, status)
      VALUES (${tenant.schoolId}::uuid, ${tenant.cls.id}::uuid, 'active')
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    const gradebookId =
      gradebook?.id ??
      (
        await tx<{ id: string }[]>`
          SELECT id FROM app.gradebooks
          WHERE school_id = ${tenant.schoolId}::uuid AND class_id = ${tenant.cls.id}::uuid
        `
      )[0]!.id;
    const [submission] = await tx<{ id: string }[]>`
      INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id)
      VALUES (${tenant.schoolId}::uuid, ${gradebookId}::uuid, ${studentId}::uuid)
      RETURNING id
    `;
    await tx`
      UPDATE app.grade_submissions
      SET status = 'submitted', submitted_by_user_id = ${teacherUser()}::uuid
      WHERE id = ${submission!.id}::uuid
    `;
    await tx`
      UPDATE app.grade_submissions
      SET status = 'approved', decided_by_user_id = ${tenant.users.ORG_ADMIN.id}::uuid
      WHERE id = ${submission!.id}::uuid
    `;
    await tx`
      UPDATE app.grade_submissions SET status = 'published' WHERE id = ${submission!.id}::uuid
    `;
    await tx`
      INSERT INTO app.grades (school_id, grade_submission_id, label, score, max_score, weight)
      VALUES (
        ${tenant.schoolId}::uuid, ${submission!.id}::uuid, ${label}, ${score}::numeric,
        20::numeric, 1::numeric
      )
    `;
  });
}

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

describeDb("the parent home's recent grades across linked children", () => {
  test("setup: two families, an approved exam, an unreleased one, published grades", async () => {
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MA", name: "Mathematics" })
    ).id;
    for (const [key, name] of [
      ["amal", "Amal"],
      ["badr", "Badr"],
      ["carim", "Carim"],
    ] as const) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[key] = student.id;
      await createEnrollment(db.sql, tenant.schoolId, tenant.cls.id, student.id);
    }
    await assignRole(db.sql, tenant.schoolId, teacherUser(), ROLES.INSTRUCTOR);
    for (const [key, children] of [
      ["parent", ["amal", "badr"]],
      ["otherParent", ["carim"]],
    ] as const) {
      const parent = await createUser(db.sql, tenant.schoolId, { displayName: `${key} user` });
      await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
      const [family] = await db.sql<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${tenant.schoolId}::uuid, ${`${key} family`}, ${parent.id}::uuid)
        RETURNING id
      `;
      for (const child of children) {
        await db.sql`
          INSERT INTO app.parent_child_links
            (school_id, family_id, parent_user_id, student_id, relationship)
          VALUES (
            ${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid,
            ${ids[child]!}::uuid, 'mother'
          )
        `;
      }
      ids[`${key}User`] = parent.id;
    }

    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "Grade 5", sort_order: 5 });
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        mark_approval_required: true,
      });
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "5A",
      });
      ids.section = section.id;
      for (const key of ["amal", "badr", "carim"]) {
        await placeStudentInSection(tx, tenant.schoolId, section.id, ids[key]!);
      }
      const saved = await createSubjectConfig(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        {
          yearId: tenant.academicYear.id,
          gradeLevelId: grade.id,
          sectionId: null,
          subjectId: ids.math!,
        },
        {
          requirement: "mandatory",
          include_in_average: true,
          include_on_certificate: true,
          average_weight: 1,
          grading_method: "total_points",
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
          term_weights: [{ term_id: tenant.term.id, weight: 100 }],
          categories: [
            {
              ref: "exams",
              name: "Monthly exams",
              kind: "exam",
              scope: "term",
              weight: null,
              aggregation: "weighted_average",
              drop_lowest: 0,
              sort_order: 0,
            } satisfies SubjectConfigInput["categories"][number],
          ],
          assessments: [
            ["First month", 20],
            ["Second month", 20],
          ].map(([name, max], index) => ({
            category_ref: "exams",
            term_id: tenant.term.id,
            name: name as string,
            max_marks: max as number,
            weight: 1,
            is_mandatory: true,
            assessment_date: `${new Date().getFullYear()}-02-0${index + 1}`,
            due_date: null,
            sort_order: index,
          })),
        },
      );
      expect(saved.config.valid).toBe(true);
      await createTeacherAssignment(tx, tenant.schoolId, {
        section_id: section.id,
        subject_id: ids.math!,
        teacher_id: tenant.teachers[0]!.id,
      });
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });
    const view = await teacher((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, ids.math!));
    for (const assessment of view.assessments) ids[assessment.name] = assessment.id;

    // Published before the exam is released, so older than it.
    await publishGrade(ids.amal!, "Worksheet 3", 16);

    // First month marked for everyone and approved on its own; Second month marked, not sent.
    await teacher((tx) =>
      saveMarks(tx, tenant.schoolId, teacherUser(), ids.section!, ids.math!, [
        mark(ids.amal!, ids["First month"]!, 17.5),
        mark(ids.badr!, ids["First month"]!, 11),
        mark(ids.carim!, ids["First month"]!, 9),
        mark(ids.amal!, ids["Second month"]!, 19),
      ]),
    );
    const release = await teacher((tx) =>
      submitAssessmentRelease(
        tx,
        tenant.schoolId,
        teacherUser(),
        ids.section!,
        ids.math!,
        ids["First month"]!,
      ),
    );
    await admin((tx) =>
      decideAssessmentRelease(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        release.id,
        "approve",
        null,
      ),
    );

    // Published after the release, so newer than the exam.
    await publishGrade(ids.badr!, "Essay", 18);
    await publishGrade(ids.carim!, "Lab report", 12);
  });

  test("a parent sees both children's marks of both kinds, newest first, labelled", async () => {
    const { status, body } = await getRecent(ids.parentUser!, [ROLES.PARENT]);
    expect(status).toBe(200);
    const courseName = (
      await db.sql<{ name: string }[]>`
        SELECT co.name FROM app.classes AS c JOIN app.courses AS co ON co.id = c.course_id
        WHERE c.id = ${tenant.cls.id}::uuid
      `
    )[0]!.name;

    // Both First month marks were released in the same approval, so their order is the id's.
    const kinds = body.items.map((item) => `${item.kind}:${item.student_first_name}:${item.name}`);
    expect(kinds[0]).toBe("assignment:Badr:Essay");
    expect(kinds.slice(1, 3).sort()).toEqual(["exam:Amal:First month", "exam:Badr:First month"]);
    expect(kinds[3]).toBe("assignment:Amal:Worksheet 3");
    expect(kinds).toHaveLength(4);

    const exam = body.items.find((item) => item.kind === "exam" && item.student_id === ids.amal)!;
    expect(exam).toMatchObject({
      id: ids["First month"],
      student_name: "Amal Test",
      subject_name: "Mathematics",
      attempt: 1,
      status: "graded",
      score: 17.5,
      max_score: 20,
      descriptor_label: null,
    });
    expect(exam.term_name).toMatch(/^Term /);
    expect(Date.now() - Date.parse(exam.released_at)).toBeLessThan(60 * 60 * 1000);

    const worksheet = body.items[3]!;
    expect(worksheet).toMatchObject({
      student_id: ids.amal,
      subject_name: courseName,
      term_name: null,
      max_score: 20,
    });
  });

  test("never the unreleased exam, nor another family's child", async () => {
    const { body } = await getRecent(ids.parentUser!, [ROLES.PARENT]);
    expect(body.items.some((item) => item.name === "Second month")).toBe(false);
    expect(body.items.some((item) => item.student_id === ids.carim)).toBe(false);

    const other = await getRecent(ids.otherParentUser!, [ROLES.PARENT]);
    expect(other.status).toBe(200);
    expect(new Set(other.body.items.map((item) => item.student_id))).toEqual(new Set([ids.carim!]));
    expect(other.body.items.map((item) => item.name).sort()).toEqual(["First month", "Lab report"]);
  });

  test("limit caps the merged list", async () => {
    const { status, body } = await getRecent(ids.parentUser!, [ROLES.PARENT], "?limit=2");
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]!.name).toBe("Essay");
    expect((await getRecent(ids.parentUser!, [ROLES.PARENT], "?limit=0")).status).toBe(400);
  });

  test("a staff role that holds grade:read but is not a parent is refused", async () => {
    const { status, body } = await getRecent(tenant.users.ORG_ADMIN.id, [ROLES.ORG_ADMIN]);
    expect(status).toBe(403);
    expect(body.code).toBe(ERROR_CODES.ACCESS_DENIED);
  });

  test("a parent with no linked children gets an empty list", async () => {
    const lonely = await createUser(db.sql, tenant.schoolId, { displayName: "Lonely parent" });
    await assignRole(db.sql, tenant.schoolId, lonely.id, ROLES.PARENT);
    const { status, body } = await getRecent(lonely.id, [ROLES.PARENT]);
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });
});
