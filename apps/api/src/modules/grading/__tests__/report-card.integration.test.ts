/**
 * Report card notes (000208) end to end, against a real migrated database with RLS armed:
 * subject comments, the class teacher's comment and conduct rating, the principal's comment and
 * the attendance summary are written as drafts, frozen at finalization, and printed on the
 * certificate. Later tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/report-card.integration.test.ts
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
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import { getMarkSheet, saveMarks } from "../marks-service";
import {
  getReportCardSettings,
  getSectionReportNotes,
  saveStudentNotes,
  saveSubjectComments,
  updateReportCardSettings,
} from "../report-card-service";
import { finalizeSection, listStudentResults, readFinalizationResults } from "../results-service";

import type { TestApp, TestDatabase, TenantFixture } from "../../../../tests/harness";
import type { TransactionSql } from "postgres";

const describeDb = integrationEnabled ? describe : describe.skip;
const year = new Date().getFullYear();

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
const teacher = <T>(fn: (tx: TransactionSql) => Promise<T>) => as(tenant.teachers[0]!.userId, fn);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    return String((error as { code?: string }).code ?? error);
  }
  return "RESOLVED";
}

/** One attendance session for the fixture class, with one record for `studentId`. */
async function seedAttendance(
  date: string,
  period: number,
  studentId: string,
  status: "present" | "remote" | "absent" | "late" | "excused",
  sessionStatus: "submitted" | "locked" | "draft" = "submitted",
) {
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${tenant.schoolId}, true)`;
    const [session] = await tx<{ id: string; created_at: Date }[]>`
      INSERT INTO app.attendance_sessions (school_id, class_id, session_date, period, status, taken_by_user_id)
      VALUES (${tenant.schoolId}, ${tenant.cls.id}, ${date}::date, ${period},
              ${sessionStatus}::app.attendance_session_status, ${tenant.teachers[0]!.userId})
      RETURNING id, created_at
    `;
    await tx`
      INSERT INTO app.attendance_records
        (school_id, attendance_session_id, session_created_at, student_id, status, minutes_late,
         recorded_by_user_id)
      VALUES (${tenant.schoolId}, ${session!.id}, ${session!.created_at}, ${studentId},
              ${status}::app.attendance_status, ${status === "late" ? 5 : null},
              ${tenant.teachers[0]!.userId})
    `;
  });
}

describeDb("report card notes", () => {
  test("setup: a published year with one subject, a section of two students and their marks", async () => {
    ids.math = (await createSubject(db.sql, tenant.schoolId, { code: "MTH", name: "Math" })).id;
    ids.s1 = tenant.students[0]!.id;
    ids.s1User = tenant.students[0]!.userId;
    const second = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Badr",
      lastName: "Test",
    });
    ids.s2 = second.id;
    const stranger = await createStudent(db.sql, tenant.schoolId, {
      firstName: "Other",
      lastName: "Section",
    });
    ids.stranger = stranger.id;
    await assignRole(db.sql, tenant.schoolId, tenant.students[0]!.userId, ROLES.STUDENT);
    await assignRole(db.sql, tenant.schoolId, tenant.teachers[0]!.userId, ROLES.INSTRUCTOR);
    const outsider = await createTeacher(db.sql, tenant.schoolId);
    await assignRole(db.sql, tenant.schoolId, outsider.userId, ROLES.INSTRUCTOR);
    ids.outsiderUser = outsider.userId;

    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "Grade 7", sort_order: 7 });
      ids.grade = grade.id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
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
        {
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
        },
      );
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "7A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s1!);
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s2!);
      await createTeacherAssignment(tx, tenant.schoolId, {
        section_id: section.id,
        subject_id: ids.math!,
        teacher_id: tenant.teachers[0]!.id,
      });
      const published = await setYearGradingStatus(
        tx,
        tenant.schoolId,
        tenant.academicYear.id,
        "active",
      );
      expect(published.status).toBe("active");
    });

    const sheet = await admin((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, ids.math!));
    const finalId = sheet.assessments.find((a) => a.name === "Final")!.id;
    await admin((tx) =>
      saveMarks(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, ids.math!, [
        {
          assessment_id: finalId,
          student_id: ids.s1!,
          attempt: 1,
          status: "graded",
          score: 88,
          remarks: null,
        },
        {
          assessment_id: finalId,
          student_id: ids.s2!,
          attempt: 1,
          status: "graded",
          score: 64,
          remarks: null,
        },
      ]),
    );

    // Day 1: two sessions, one present and one late -> present, and late. Day 2: absent. Day 3:
    // excused. Day 4: a draft session, which never counts.
    await seedAttendance(`${year}-02-02`, 1, ids.s1!, "present");
    await seedAttendance(`${year}-02-02`, 2, ids.s1!, "late");
    await seedAttendance(`${year}-02-03`, 1, ids.s1!, "absent");
    await seedAttendance(`${year}-02-04`, 1, ids.s1!, "excused", "locked");
    await seedAttendance(`${year}-02-05`, 1, ids.s1!, "absent", "draft");
  });

  test("settings default to every section shown and the four conduct ratings", async () => {
    const settings = await admin((tx) => getReportCardSettings(tx, tenant.schoolId));
    expect(settings).toMatchObject({
      show_subject_comments: true,
      show_teacher_comment: true,
      show_principal_comment: true,
      show_attendance: true,
      show_conduct: true,
      conduct_ratings_default: true,
    });
    expect(settings.conduct_ratings.map((r) => r.code)).toEqual([
      "excellent",
      "very_good",
      "good",
      "needs_improvement",
    ]);
  });

  test("teachers write their subject's comments and the class notes; leadership the principal's", async () => {
    await teacher((tx) =>
      saveSubjectComments(
        tx,
        tenant.schoolId,
        tenant.teachers[0]!.userId,
        ids.section!,
        ids.math!,
        null,
        [
          { student_id: ids.s1!, comment: "  Strong problem solver.  " },
          { student_id: ids.s2!, comment: "Needs to show working." },
        ],
      ),
    );
    await teacher((tx) =>
      saveStudentNotes(tx, tenant.schoolId, tenant.teachers[0]!.userId, ids.section!, null, [
        {
          student_id: ids.s1!,
          teacher_comment: "A kind and focused classmate.",
          conduct_code: "very_good",
        },
      ]),
    );
    // Clearing one comment leaves the other.
    await teacher((tx) =>
      saveSubjectComments(
        tx,
        tenant.schoolId,
        tenant.teachers[0]!.userId,
        ids.section!,
        ids.math!,
        null,
        [{ student_id: ids.s2!, comment: "   " }],
      ),
    );
    await admin((tx) =>
      saveStudentNotes(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, null, [
        { student_id: ids.s1!, principal_comment: "Well done this year." },
      ]),
    );

    const view = await teacher((tx) =>
      getSectionReportNotes(tx, tenant.schoolId, ids.section!, null),
    );
    expect(view).toMatchObject({
      editable: true,
      can_edit_class_notes: true,
      can_edit_principal_comment: false,
    });
    expect(view.subjects).toEqual([
      { subject_id: ids.math!, subject_name: "Math", can_comment: true },
    ]);
    const amal = view.students.find((s) => s.student_id === ids.s1)!;
    expect(amal).toMatchObject({
      teacher_comment: "A kind and focused classmate.",
      principal_comment: "Well done this year.",
      conduct_code: "very_good",
      subject_comments: [{ subject_id: ids.math!, body: "Strong problem solver." }],
    });
    expect(view.students.find((s) => s.student_id === ids.s2)!.subject_comments).toEqual([]);
  });

  test("the rules: scope, the principal's comment, known ratings, students of the section", async () => {
    const outsider = (fn: (tx: TransactionSql) => Promise<unknown>) => as(ids.outsiderUser!, fn);
    expect(
      await codeOf(
        outsider((tx) =>
          saveSubjectComments(
            tx,
            tenant.schoolId,
            ids.outsiderUser!,
            ids.section!,
            ids.math!,
            null,
            [{ student_id: ids.s1!, comment: "x" }],
          ),
        ),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect(
      await codeOf(
        outsider((tx) => getSectionReportNotes(tx, tenant.schoolId, ids.section!, null)),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect(
      await codeOf(
        teacher((tx) =>
          saveStudentNotes(tx, tenant.schoolId, tenant.teachers[0]!.userId, ids.section!, null, [
            { student_id: ids.s1!, principal_comment: "Not mine to write" },
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect(
      await codeOf(
        teacher((tx) =>
          saveStudentNotes(tx, tenant.schoolId, tenant.teachers[0]!.userId, ids.section!, null, [
            { student_id: ids.s1!, conduct_code: "outstanding" },
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(
      await codeOf(
        teacher((tx) =>
          saveStudentNotes(tx, tenant.schoolId, tenant.teachers[0]!.userId, ids.section!, null, [
            { student_id: ids.stranger!, teacher_comment: "Not in 7A" },
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.VALIDATION_FAILED);
  });

  test("students cannot read draft notes", async () => {
    const rows = await as(
      ids.s1User!,
      (tx) => tx<{ count: number }[]>`
        SELECT (SELECT count(*) FROM app.report_student_notes)::int
             + (SELECT count(*) FROM app.report_subject_comments)::int AS count
      `,
    );
    expect(rows[0]!.count).toBe(0);
  });

  test("finalizing freezes the notes and the attendance summary into the results", async () => {
    const finalization = await admin((tx) =>
      finalizeSection(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.section!, null, {
        allowIncomplete: false,
      }),
    );
    ids.annual = finalization.id;
    const results = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, finalization.id),
    );
    const amal = results.find((r) => r.student_id === ids.s1)!;
    expect(amal.report).toEqual({
      teacher_comment: "A kind and focused classmate.",
      principal_comment: "Well done this year.",
      conduct: { code: "very_good", label: "Very good", label_ar: "جيد جدًا" },
      attendance: {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        days_recorded: 3,
        days_present: 1,
        days_absent: 1,
        days_late: 1,
        days_excused: 1,
      },
    });
    expect(amal.subjects[0]!.comment).toBe("Strong problem solver.");
    const badr = results.find((r) => r.student_id === ids.s2)!;
    expect(badr.report).toMatchObject({
      teacher_comment: null,
      principal_comment: null,
      conduct: null,
      attendance: { days_recorded: 0 },
    });
    expect(badr.subjects[0]!.comment).toBeNull();

    // The period is closed for notes now.
    expect(
      await codeOf(
        teacher((tx) =>
          saveStudentNotes(tx, tenant.schoolId, tenant.teachers[0]!.userId, ids.section!, null, [
            { student_id: ids.s1!, teacher_comment: "Too late" },
          ]),
        ),
      ),
    ).toBe(ERROR_CODES.RESULTS_ALREADY_FINALIZED);
    const view = await teacher((tx) =>
      getSectionReportNotes(tx, tenant.schoolId, ids.section!, null),
    );
    expect(view).toMatchObject({ finalized: true, editable: false });
  });

  test("the certificate carries the notes, and the student sees them in their results", async () => {
    const issued = await admin((tx) =>
      issueCertificates(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, ids.annual!, [ids.s1!]),
    );
    const certificate = await admin((tx) => getCertificate(tx, tenant.schoolId, issued.issued[0]!));
    expect(certificate.content.report?.principal_comment).toBe("Well done this year.");
    expect(certificate.content.report?.attendance?.days_absent).toBe(1);
    expect(certificate.content.subjects[0]!.comment).toBe("Strong problem solver.");

    const own = await as(ids.s1User!, (tx) => listStudentResults(tx, tenant.schoolId, ids.s1!));
    expect(own[0]!.result.report?.conduct?.label).toBe("Very good");
    expect(own[0]!.result.subjects[0]!.comment).toBe("Strong problem solver.");
  });

  test("sections a school switches off are left out of later finalizations", async () => {
    const settings = await admin((tx) =>
      updateReportCardSettings(tx, tenant.schoolId, {
        show_attendance: false,
        show_principal_comment: false,
        conduct_ratings: [
          { code: "a", label: "A", label_ar: null },
          { code: "b", label: "B", label_ar: null },
        ],
      }),
    );
    expect(settings).toMatchObject({
      show_attendance: false,
      show_principal_comment: false,
      show_teacher_comment: true,
      conduct_ratings_default: false,
    });
    await teacher((tx) =>
      saveStudentNotes(
        tx,
        tenant.schoolId,
        tenant.teachers[0]!.userId,
        ids.section!,
        tenant.term.id,
        [{ student_id: ids.s1!, teacher_comment: "Good first term.", conduct_code: "a" }],
      ),
    );
    await admin((tx) =>
      saveStudentNotes(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.section!,
        tenant.term.id,
        [{ student_id: ids.s1!, principal_comment: "Hidden by the school's settings." }],
      ),
    );
    const term = await admin((tx) =>
      finalizeSection(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.section!,
        tenant.term.id,
        {
          allowIncomplete: true,
        },
      ),
    );
    const [amal] = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, term.id, { studentId: ids.s1! }),
    );
    expect(amal!.report).toEqual({
      teacher_comment: "Good first term.",
      principal_comment: null,
      conduct: { code: "a", label: "A", label_ar: null },
      attendance: null,
    });
    // The annual finalization keeps what it had.
    const [annual] = await admin((tx) =>
      readFinalizationResults(tx, tenant.schoolId, ids.annual!, { studentId: ids.s1! }),
    );
    expect(annual!.report?.attendance?.days_recorded).toBe(3);
  });

  test("HTTP: role gates on the routes", async () => {
    const http = harness!;
    const adminAuth = { schoolId: tenant.schoolId, userId: tenant.users.ORG_ADMIN.id };
    const teacherAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.teachers[0]!.userId,
      roles: [ROLES.INSTRUCTOR],
    };
    const studentAuth = { schoolId: tenant.schoolId, userId: ids.s1User!, roles: [ROLES.STUDENT] };
    const jsonInit = (body: unknown) => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const settings = await authenticatedRequest(
      http,
      "GET",
      "/api/grading/report-card-settings",
      adminAuth,
    );
    expect(settings.status).toBe(200);
    expect(
      (
        await authenticatedRequest(
          http,
          "PUT",
          "/api/grading/report-card-settings",
          teacherAuth,
          jsonInit({ show_conduct: false }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await authenticatedRequest(
          http,
          "GET",
          `/api/grading/sections/${ids.section}/report-notes`,
          studentAuth,
        )
      ).status,
    ).toBe(403);
    const notes = await authenticatedRequest(
      http,
      "GET",
      `/api/grading/sections/${ids.section}/report-notes?term_id=${tenant.term.id}`,
      teacherAuth,
    );
    expect(notes.status).toBe(200);
    expect(((await notes.json()) as { finalized: boolean }).finalized).toBe(true);
    const put = await authenticatedRequest(
      http,
      "PUT",
      `/api/grading/sections/${ids.section}/subjects/${ids.math}/report-comments`,
      studentAuth,
      jsonInit({ term_id: null, comments: [{ student_id: ids.s1, comment: "x" }] }),
    );
    expect(put.status).toBe(403);
  });
});
