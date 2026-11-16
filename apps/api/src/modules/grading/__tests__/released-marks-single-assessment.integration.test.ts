/**
 * The family's view of one assessment released on its own (000229), the way a school uses it:
 * a term with several assessments ("First month", "Second month", "Final"), only the first one
 * sent for approval and approved, and the term's mark sheet never submitted -- so no
 * app.mark_sheets row exists for the period at all. Read through the HTTP route the mobile app
 * calls (`GET /api/grading/students/{studentId}/marks`) as the student and as their parent, with
 * RLS armed, and checked field by field against what the app's `ReleasedMarkPeriod.fromJson`
 * reads.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/released-marks-single-assessment.integration.test.ts
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
} from "../config-service";
import {
  decideAssessmentRelease,
  getMarkSheet,
  saveMarks,
  submitAssessmentRelease,
} from "../marks-service";

import type { TestApp, TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { SubjectConfigInput } from "../config-service";
import type { MarkEntryInput } from "../marks-service";
import type { Role } from "@studafy/constants";
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

/** The response as the mobile app's `released_marks.dart` reads it. */
interface MarksResponse {
  periods: {
    academic_year_id: string;
    academic_year_name: string;
    term_id: string | null;
    term_name: string | null;
    subjects: {
      subject_id: string;
      subject_code: string;
      subject_name: string;
      approved_at: string | null;
      period_approved: boolean;
      categories: {
        category_id: string;
        name: string;
        kind: string;
        assessments: {
          assessment_id: string;
          name: string;
          max_marks: number;
          assessment_date: string | null;
          released_at: string;
          attempts: {
            attempt: number;
            status: string;
            score: number | null;
            descriptor_label: string | null;
          }[];
        }[];
      }[];
    }[];
  }[];
}

const getMarks = async (userId: string, roles: Role[], studentId: string) => {
  const response = await authenticatedRequest(
    harness!,
    "GET",
    `/api/grading/students/${studentId}/marks`,
    { schoolId: tenant.schoolId, userId, roles },
  );
  return { status: response.status, body: (await response.json()) as MarksResponse };
};

describeDb("one assessment of a term released on its own, read by the family", () => {
  test("setup: a term with three exams for Mathematics and one for Science, two pupils, a parent", async () => {
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MA", name: "Mathematics" })
    ).id;
    ids.science = (
      await createSubject(db.sql, tenant.schoolId, { code: "SC", name: "Science" })
    ).id;
    for (const [key, name] of [
      ["s1", "Amal"],
      ["s2", "Badr"],
    ] as const) {
      const student = await createStudent(db.sql, tenant.schoolId, {
        firstName: name,
        lastName: "Test",
      });
      ids[key] = student.id;
      ids[`${key}User`] = student.userId;
      await assignRole(db.sql, tenant.schoolId, student.userId, ROLES.STUDENT);
    }
    await assignRole(db.sql, tenant.schoolId, teacherUser(), ROLES.INSTRUCTOR);
    for (const [key, child] of [
      ["parent", "s1"],
      ["otherParent", "s2"],
    ] as const) {
      const parent = await createUser(db.sql, tenant.schoolId, { displayName: `${key} user` });
      await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
      const [family] = await db.sql<{ id: string }[]>`
        INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
        VALUES (${tenant.schoolId}::uuid, ${`${key} family`}, ${parent.id}::uuid)
        RETURNING id
      `;
      await db.sql`
        INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
        VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids[child]!}::uuid, 'mother')
      `;
      ids[`${key}User`] = parent.id;
    }

    const userId = tenant.users.ORG_ADMIN.id;
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
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s1!);
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s2!);
      const config = (
        assessments: [name: string, max: number][],
      ): Parameters<typeof createSubjectConfig>[4] => ({
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
        assessments: assessments.map(([name, max], index) => ({
          category_ref: "exams",
          term_id: tenant.term.id,
          name,
          max_marks: max,
          weight: 1,
          is_mandatory: true,
          assessment_date: `${new Date().getFullYear()}-02-0${index + 1}`,
          due_date: null,
          sort_order: index,
        })),
      });
      for (const [subjectId, assessments] of [
        [
          ids.math!,
          [
            ["First month", 20],
            ["Second month", 20],
            ["Final", 60],
          ],
        ],
        [ids.science!, [["First month", 20]]],
      ] as const) {
        const saved = await createSubjectConfig(
          tx,
          tenant.schoolId,
          userId,
          {
            yearId: tenant.academicYear.id,
            gradeLevelId: grade.id,
            sectionId: null,
            subjectId,
          },
          config(assessments.map(([name, max]) => [name, max])),
        );
        expect(saved.config.valid).toBe(true);
        await createTeacherAssignment(tx, tenant.schoolId, {
          section_id: section.id,
          subject_id: subjectId,
          teacher_id: tenant.teachers[0]!.id,
        });
      }
      await setYearGradingStatus(tx, tenant.schoolId, tenant.academicYear.id, "active");
    });
    const view = await teacher((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, ids.math!));
    for (const assessment of view.assessments) ids[`math:${assessment.name}`] = assessment.id;
    const scienceView = await teacher((tx) =>
      getMarkSheet(tx, tenant.schoolId, ids.section!, ids.science!),
    );
    ids["science:First month"] = scienceView.assessments[0]!.id;
  });

  test("only Mathematics' First month is approved; the term sheet was never submitted", async () => {
    const save = (subjectId: string, entries: MarkEntryInput[]) =>
      teacher((tx) =>
        saveMarks(tx, tenant.schoolId, teacherUser(), ids.section!, subjectId, entries),
      );
    // First month complete for the class; Second month half entered; Science entered, not sent.
    await save(ids.math!, [
      mark(ids.s1!, ids["math:First month"]!, 17.5),
      mark(ids.s2!, ids["math:First month"]!, 12),
      mark(ids.s1!, ids["math:Second month"]!, 19),
    ]);
    await save(ids.science!, [
      mark(ids.s1!, ids["science:First month"]!, 15),
      mark(ids.s2!, ids["science:First month"]!, 14),
    ]);
    const release = await teacher((tx) =>
      submitAssessmentRelease(
        tx,
        tenant.schoolId,
        teacherUser(),
        ids.section!,
        ids.math!,
        ids["math:First month"]!,
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
    const sheets = await db.sql`
      SELECT id FROM app.mark_sheets WHERE school_id = ${tenant.schoolId}::uuid
    `;
    expect(sheets).toHaveLength(0);
  });

  test("the student reads exactly that exam, in its term, with everything the app parses", async () => {
    const { status, body } = await getMarks(ids.s1User!, [ROLES.STUDENT], ids.s1!);
    expect(status).toBe(200);
    expect(body.periods).toHaveLength(1);
    const [period] = body.periods;
    expect(period!.academic_year_id).toBe(tenant.academicYear.id);
    expect(period!.academic_year_name).toBeTruthy();
    expect(period!.term_id).toBe(tenant.term.id);
    expect(period!.term_name).toMatch(/^Term /);
    expect(period!.subjects).toHaveLength(1);
    const [subject] = period!.subjects;
    expect(subject!.subject_id).toBe(ids.math!);
    expect(subject!.subject_name).toBe("Mathematics");
    expect(subject!.subject_code).toBe("MA");
    // More of the term is still to come.
    expect(subject!.period_approved).toBe(false);
    expect(subject!.approved_at).toBeNull();
    expect(subject!.categories).toHaveLength(1);
    const [category] = subject!.categories;
    expect([category!.name, category!.kind]).toEqual(["Monthly exams", "exam"]);
    expect(category!.assessments).toHaveLength(1);
    const [assessment] = category!.assessments;
    expect(assessment!.assessment_id).toBe(ids["math:First month"]!);
    expect(assessment!.name).toBe("First month");
    expect(assessment!.max_marks).toBe(20);
    expect(assessment!.assessment_date).toMatch(/^\d{4}-02-01$/);
    expect(Number.isNaN(Date.parse(assessment!.released_at))).toBe(false);
    expect(Date.now() - Date.parse(assessment!.released_at)).toBeLessThan(60 * 60 * 1000);
    expect(assessment!.attempts).toEqual([
      { attempt: 1, status: "graded", score: 17.5, descriptor_label: null },
    ]);
  });

  test("the linked parent reads the same; another parent and the classmate are refused", async () => {
    const own = await getMarks(ids.s1User!, [ROLES.STUDENT], ids.s1!);
    const parent = await getMarks(ids.parentUser!, [ROLES.PARENT], ids.s1!);
    expect(parent.status).toBe(200);
    expect(parent.body).toEqual(own.body);

    // The classmate sees their own First month, and nothing of Amal's.
    const badr = await getMarks(ids.s2User!, [ROLES.STUDENT], ids.s2!);
    expect(badr.status).toBe(200);
    expect(
      badr.body.periods[0]!.subjects[0]!.categories[0]!.assessments[0]!.attempts[0]!.score,
    ).toBe(12);
    expect((await getMarks(ids.s2User!, [ROLES.STUDENT], ids.s1!)).status).toBe(403);
    expect((await getMarks(ids.otherParentUser!, [ROLES.PARENT], ids.s1!)).status).toBe(403);
  });
});
