/**
 * Releasing marks one assessment at a time (000229), against a real migrated database with RLS
 * armed.
 *
 * A grade with mark approval on, one section (Amal and Badr), Mathematics with a First exam, a
 * Second exam and an optional Homework in the annual period. The teacher sends the First exam on its
 * own as soon as it is complete; leadership returns, then approves it; the family sees that exam
 * and nothing else while the whole period's sheet still waits for the rest. Then the sheet goes
 * through the usual submission and approval, and the reopen / withdraw rules are walked through.
 * Later tests build on earlier ones.
 *
 *   TEST_DATABASE_URL=postgres://... bun test src/modules/grading/__tests__/assessment-release.integration.test.ts
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
  createUser,
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
  createSubjectConfig,
  createTeacherAssignment,
  setYearGradingStatus,
  upsertProgram,
} from "../config-service";
import {
  decideAssessmentRelease,
  decideMarkSheet,
  getMarkSheet,
  listAssessmentReleases,
  listReleasedStudentMarks,
  saveMarks,
  submitAssessmentRelease,
  submitMarkSheet,
} from "../marks-service";
import { getGradingOverview } from "../overview-service";
import { computeSection } from "../results-service";

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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    return String((error as { code?: string }).code ?? error);
  }
  return "RESOLVED";
}

const mark = (
  studentId: string,
  assessmentId: string,
  score: number | null,
  status: MarkEntryInput["status"] = "graded",
): MarkEntryInput => ({
  assessment_id: assessmentId,
  student_id: studentId,
  attempt: 1,
  status,
  score,
  descriptor_id: null,
  remarks: null,
});

const save = (entries: MarkEntryInput[]) =>
  teacher((tx) => saveMarks(tx, tenant.schoolId, teacherUser(), ids.section!, ids.math!, entries));
const sendForApproval = (assessmentId: string) =>
  teacher((tx) =>
    submitAssessmentRelease(
      tx,
      tenant.schoolId,
      teacherUser(),
      ids.section!,
      ids.math!,
      assessmentId,
    ),
  );
const decide = (releaseId: string, action: "approve" | "return" | "reopen", reason?: string) =>
  admin((tx) =>
    decideAssessmentRelease(
      tx,
      tenant.schoolId,
      tenant.users.ORG_ADMIN.id,
      releaseId,
      action,
      reason ?? null,
    ),
  );
const sheet = () => teacher((tx) => getMarkSheet(tx, tenant.schoolId, ids.section!, ids.math!));
const released = (userId: string, studentId: string) =>
  as(userId, (tx) => listReleasedStudentMarks(tx, tenant.schoolId, studentId));
/** "assessment: scores" per released assessment, in response order. */
const lines = (periods: Awaited<ReturnType<typeof released>>) =>
  periods.flatMap((period) =>
    period.subjects.flatMap((subject) =>
      subject.categories.flatMap((category) =>
        category.assessments.map(
          (a) => `${a.name}: ${a.attempts.map((t) => t.score ?? t.status).join(",")}`,
        ),
      ),
    ),
  );

/** The marks.released payloads raised so far (each one becomes the family's MARKS_RELEASED notice). */
const releaseEvents = async () =>
  (
    await db.sql<{ payload: Record<string, string | null> }[]>`
      SELECT payload FROM app.outbox_events
      WHERE school_id = ${tenant.schoolId}::uuid AND event_name = 'marks.released'
      ORDER BY id
    `
  ).map((row) => row.payload);

describeDb("releasing marks one assessment at a time", () => {
  test("setup: approval required, one section, two students and a parent, Mathematics", async () => {
    ids.math = (
      await createSubject(db.sql, tenant.schoolId, { code: "MA", name: "Mathematics" })
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
    const parent = await createUser(db.sql, tenant.schoolId, { displayName: "Amal's father" });
    await assignRole(db.sql, tenant.schoolId, parent.id, ROLES.PARENT);
    const [family] = await db.sql<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${tenant.schoolId}::uuid, 'Test family', ${parent.id}::uuid)
      RETURNING id
    `;
    await db.sql`
      INSERT INTO app.parent_child_links (school_id, family_id, parent_user_id, student_id, relationship)
      VALUES (${tenant.schoolId}::uuid, ${family!.id}::uuid, ${parent.id}::uuid, ${ids.s1}::uuid, 'father')
    `;
    ids.parentUser = parent.id;

    const userId = tenant.users.ORG_ADMIN.id;
    await admin(async (tx) => {
      const grade = await createGradeLevel(tx, tenant.schoolId, { name: "Grade 7", sort_order: 7 });
      ids.grade = grade.id;
      await upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, grade.id, {
        mark_approval_required: true,
      });
      const section = await createSection(tx, tenant.schoolId, {
        academic_year_id: tenant.academicYear.id,
        grade_level_id: grade.id,
        name: "7A",
      });
      ids.section = section.id;
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s1!);
      await placeStudentInSection(tx, tenant.schoolId, section.id, ids.s2!);
      const assessment = (
        name: string,
        categoryRef: string,
        isMandatory: boolean,
        sort: number,
      ) => ({
        category_ref: categoryRef,
        term_id: null,
        name,
        max_marks: name === "Homework" ? 10 : 50,
        weight: 1,
        is_mandatory: isMandatory,
        assessment_date: null,
        due_date: null,
        sort_order: sort,
      });
      const category = (
        ref: string,
        name: string,
        kind: SubjectConfigInput["categories"][number]["kind"],
        sort: number,
      ): SubjectConfigInput["categories"][number] => ({
        ref,
        name,
        kind,
        scope: "annual",
        weight: null,
        aggregation: "weighted_average",
        drop_lowest: 0,
        sort_order: sort,
      });
      const saved = await createSubjectConfig(
        tx,
        tenant.schoolId,
        userId,
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
          term_weights: [],
          categories: [
            category("exams", "Exams", "exam", 0),
            category("homework", "Homework", "homework", 1),
          ],
          assessments: [
            assessment("First exam", "exams", true, 0),
            assessment("Second exam", "exams", true, 1),
            assessment("Homework", "homework", false, 2),
          ],
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
    const view = await sheet();
    const byName = (name: string) => view.assessments.find((a) => a.name === name)!.id;
    ids.first = byName("First exam");
    ids.second = byName("Second exam");
    ids.homework = byName("Homework");
    expect(view.assessments.map((a) => [a.name, a.release_status, a.missing_count])).toEqual([
      ["First exam", "draft", 2],
      ["Second exam", "draft", 2],
      ["Homework", "draft", 2],
    ]);
  });

  test("an assessment goes for approval only once every enrolled student has a usable mark", async () => {
    await save([mark(ids.s1!, ids.first!, 42)]);
    expect(await codeOf(sendForApproval(ids.first!))).toBe(ERROR_CODES.RESULTS_INCOMPLETE);
    // An absence the school does not count as zero is still a missing mark.
    await save([mark(ids.s2!, ids.first!, null, "absent")]);
    expect((await sheet()).assessments.find((a) => a.id === ids.first)!.missing_count).toBe(1);
    expect(await codeOf(sendForApproval(ids.first!))).toBe(ERROR_CODES.RESULTS_INCOMPLETE);
    // Excused counts as recorded.
    await save([mark(ids.s2!, ids.first!, null, "excused")]);
    expect((await sheet()).assessments.find((a) => a.id === ids.first)!.missing_count).toBe(0);
    // An optional assessment with no marks at all is not "complete" either.
    expect(await codeOf(sendForApproval(ids.homework!))).toBe(ERROR_CODES.RESULTS_INCOMPLETE);

    const release = await sendForApproval(ids.first!);
    expect(release.status).toBe("submitted");
    ids.firstRelease = release.id;
    expect(await codeOf(sendForApproval(ids.first!))).toBe(ERROR_CODES.CONFLICT_STATE_MISMATCH);

    // The whole period still needs every mark, and nothing is visible to the family yet.
    expect(
      await codeOf(
        teacher((tx) =>
          submitMarkSheet(tx, tenant.schoolId, teacherUser(), ids.section!, ids.math!, null),
        ),
      ),
    ).toBe(ERROR_CODES.RESULTS_INCOMPLETE);
    expect(await released(ids.s1User!, ids.s1!)).toEqual([]);

    // Its marks are locked while it waits; the other assessments are not.
    expect(await codeOf(save([mark(ids.s1!, ids.first!, 45)]))).toBe(ERROR_CODES.MARKS_LOCKED);
    await save([mark(ids.s1!, ids.second!, 30)]);

    const overview = await admin((tx) =>
      getGradingOverview(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(overview.counts.assessment_releases_awaiting_approval).toBe(1);
    expect(overview.counts.mark_sheets_awaiting_approval).toBe(0);
  });

  test("leadership decides: a teacher cannot, a return needs a reason and reopens the marks", async () => {
    expect(
      await codeOf(
        teacher((tx) =>
          decideAssessmentRelease(
            tx,
            tenant.schoolId,
            teacherUser(),
            ids.firstRelease!,
            "approve",
            null,
          ),
        ),
      ),
    ).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
    expect(await codeOf(decide(ids.firstRelease!, "return"))).toBe(ERROR_CODES.VALIDATION_FAILED);

    const queue = await admin((tx) =>
      listAssessmentReleases(tx, tenant.schoolId, {
        yearId: tenant.academicYear.id,
        status: "submitted",
      }),
    );
    expect(queue.map((r) => [r.assessment_name, r.subject_name, r.section_name])).toEqual([
      ["First exam", "Mathematics", "7A"],
    ]);

    const returned = await decide(ids.firstRelease!, "return", "Amal's mark looks wrong");
    expect([returned.status, returned.return_reason]).toEqual([
      "returned",
      "Amal's mark looks wrong",
    ]);
    const first = (await sheet()).assessments.find((a) => a.id === ids.first)!;
    expect([first.release_status, first.release_return_reason, first.released]).toEqual([
      "returned",
      "Amal's mark looks wrong",
      false,
    ]);

    // Editing a returned assessment puts it back to draft.
    await save([mark(ids.s1!, ids.first!, 44)]);
    expect((await sheet()).assessments.find((a) => a.id === ids.first)!.release_status).toBe(
      "draft",
    );
    ids.firstRelease = (await sendForApproval(ids.first!)).id;
    // Nothing told the family while it was sent, returned or sent again.
    expect(await releaseEvents()).toEqual([]);
    const approved = await decide(ids.firstRelease, "approve");
    expect(approved.status).toBe("approved");
    // Approval raises one marks.released for the family's notice, in the same transaction.
    expect(await releaseEvents()).toEqual([
      { sectionId: ids.section!, subjectId: ids.math!, termId: null, assessmentId: ids.first! },
    ]);
  });

  test("once approved, the student and their parent see that exam, and only that exam", async () => {
    const own = await released(ids.s1User!, ids.s1!);
    expect(lines(own)).toEqual(["First exam: 44"]);
    const subject = own[0]!.subjects[0]!;
    // The rest of the period is still to come: no period approval, so nothing reads as a result.
    expect([subject.period_approved, subject.approved_at]).toEqual([false, null]);
    expect(own[0]!.subjects[0]!.categories[0]!.assessments[0]!.released_at).toBeTruthy();
    expect(await released(ids.parentUser!, ids.s1!)).toEqual(own);
    expect(lines(await released(ids.s2User!, ids.s2!))).toEqual(["First exam: excused"]);
    // Badr cannot read Amal's marks; Amal's session reads only her released row (RLS).
    expect(await released(ids.s2User!, ids.s1!)).toEqual([]);
    const rows = await as(
      ids.s1User!,
      (tx) => tx<{ assessment_id: string }[]>`
        SELECT assessment_id FROM app.student_marks WHERE student_id = ${ids.s1}::uuid
      `,
    );
    expect(rows.map((r) => r.assessment_id)).toEqual([ids.first!]);

    const view = await sheet();
    expect(view.assessments.map((a) => [a.name, a.release_status, a.released])).toEqual([
      ["First exam", "approved", true],
      ["Second exam", "draft", false],
      ["Homework", "draft", false],
    ]);
    // An approved assessment stays locked; leadership must withdraw it to change a mark.
    expect(await codeOf(save([mark(ids.s1!, ids.first!, 40)]))).toBe(ERROR_CODES.MARKS_LOCKED);

    // Term results stay where they were: the period's sheet is not approved, so no finalization.
    const computed = await admin((tx) => computeSection(tx, tenant.schoolId, ids.section!, null));
    expect(computed.unapproved_sheets).toEqual(["Mathematics (annual)"]);
  });

  test("the whole sheet: approving it approves pending assessments and releases everything", async () => {
    await save([
      mark(ids.s2!, ids.second!, 25),
      mark(ids.s1!, ids.homework!, 9),
      mark(ids.s2!, ids.homework!, 7),
    ]);
    ids.secondRelease = (await sendForApproval(ids.second!)).id;
    const sheetRow = await teacher((tx) =>
      submitMarkSheet(tx, tenant.schoolId, teacherUser(), ids.section!, ids.math!, null),
    );
    // While the sheet waits, single releases of its period are refused.
    expect(await codeOf(sendForApproval(ids.homework!))).toBe(ERROR_CODES.CONFLICT_STATE_MISMATCH);
    await admin((tx) =>
      decideMarkSheet(tx, tenant.schoolId, tenant.users.ORG_ADMIN.id, sheetRow.id, "approve", null),
    );
    ids.sheet = sheetRow.id;
    // One notice for the sheet, not one more for the Second exam it approved along the way.
    expect((await releaseEvents()).slice(1)).toEqual([
      { sectionId: ids.section!, subjectId: ids.math!, termId: null, assessmentId: null },
    ]);
    const second = (await sheet()).assessments.find((a) => a.id === ids.second)!;
    expect([second.release_status, second.released]).toEqual(["approved", true]);

    const own = await released(ids.s1User!, ids.s1!);
    expect(lines(own)).toEqual(["First exam: 44", "Second exam: 30", "Homework: 9"]);
    expect(own[0]!.subjects[0]!.period_approved).toBe(true);
    expect(own[0]!.subjects[0]!.approved_at).not.toBeNull();

    // A release cannot be withdrawn while the sheet that also releases it is approved.
    expect(await codeOf(decide(ids.firstRelease!, "reopen", "fix"))).toBe(
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
    );
  });

  test("reopening the sheet keeps individually approved assessments released until withdrawn", async () => {
    await admin((tx) =>
      decideMarkSheet(
        tx,
        tenant.schoolId,
        tenant.users.ORG_ADMIN.id,
        ids.sheet!,
        "reopen",
        "Homework needs a second look",
      ),
    );
    expect(lines(await released(ids.s1User!, ids.s1!))).toEqual([
      "First exam: 44",
      "Second exam: 30",
    ]);
    // Homework (released only with the sheet) is open again; the released exams are not.
    await save([mark(ids.s1!, ids.homework!, 10)]);
    expect(await codeOf(save([mark(ids.s1!, ids.first!, 40)]))).toBe(ERROR_CODES.MARKS_LOCKED);

    // Withdrawing needs a reason, hides the exam again and hands it back to the teacher.
    expect(await codeOf(decide(ids.firstRelease!, "reopen"))).toBe(ERROR_CODES.VALIDATION_FAILED);
    const withdrawn = await decide(ids.firstRelease!, "reopen", "Re-mark question 3");
    expect(withdrawn.status).toBe("returned");
    expect(lines(await released(ids.parentUser!, ids.s1!))).toEqual(["Second exam: 30"]);
    await save([mark(ids.s1!, ids.first!, 40)]);
    expect(await codeOf(save([mark(ids.s1!, ids.second!, 31)]))).toBe(ERROR_CODES.MARKS_LOCKED);
  });

  test("without an approval step for sheets, a single assessment still waits for leadership", async () => {
    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        mark_approval_required: false,
      }),
    );
    const before = (await releaseEvents()).length;
    const release = await sendForApproval(ids.first!);
    expect(release.status).toBe("submitted");
    expect(lines(await released(ids.s1User!, ids.s1!))).toEqual(["Second exam: 30"]);
    expect(await releaseEvents()).toHaveLength(before);
    // It is in leadership's queue and counted on the overview all the same.
    const queue = await admin((tx) =>
      listAssessmentReleases(tx, tenant.schoolId, {
        yearId: tenant.academicYear.id,
        status: "submitted",
      }),
    );
    expect(queue.map((r) => r.id)).toEqual([release.id]);
    const overview = await admin((tx) =>
      getGradingOverview(tx, tenant.schoolId, tenant.academicYear.id),
    );
    expect(overview.counts.assessment_releases_awaiting_approval).toBe(1);

    await decide(release.id, "approve");
    expect(lines(await released(ids.s1User!, ids.s1!))).toEqual([
      "First exam: 40",
      "Second exam: 30",
    ]);
    expect(await releaseEvents()).toHaveLength(before + 1);
    await admin((tx) =>
      upsertProgram(tx, tenant.schoolId, tenant.academicYear.id, ids.grade!, {
        mark_approval_required: true,
      }),
    );
  });

  test("HTTP: the teacher sends, leadership lists and decides, the family reads", async () => {
    const teacherAuth = {
      schoolId: tenant.schoolId,
      userId: teacherUser(),
      roles: [ROLES.INSTRUCTOR],
    };
    const adminAuth = {
      schoolId: tenant.schoolId,
      userId: tenant.users.ORG_ADMIN.id,
      roles: [ROLES.ORG_ADMIN],
    };
    const sent = await authenticatedRequest(
      harness!,
      "POST",
      `/api/grading/sections/${ids.section}/subjects/${ids.math}/assessments/${ids.homework}/release`,
      teacherAuth,
    );
    expect(sent.status).toBe(200);
    const release = (await sent.json()) as { id: string; status: string };
    expect(release.status).toBe("submitted");

    // A student cannot send or list releases.
    const studentAuth = { schoolId: tenant.schoolId, userId: ids.s1User!, roles: [ROLES.STUDENT] };
    expect(
      (
        await authenticatedRequest(
          harness!,
          "GET",
          `/api/grading/years/${tenant.academicYear.id}/assessment-releases?status=submitted`,
          studentAuth,
        )
      ).status,
    ).toBe(403);

    const queue = await authenticatedRequest(
      harness!,
      "GET",
      `/api/grading/years/${tenant.academicYear.id}/assessment-releases?status=submitted`,
      adminAuth,
    );
    expect(queue.status).toBe(200);
    const body = (await queue.json()) as {
      releases: { id: string; assessment_name: string; max_marks: number }[];
    };
    expect(body.releases.map((r) => [r.assessment_name, r.max_marks])).toEqual([["Homework", 10]]);

    const decided = await authenticatedRequest(
      harness!,
      "POST",
      `/api/grading/assessment-releases/${release.id}/decision`,
      adminAuth,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      },
    );
    expect(decided.status).toBe(200);

    const marks = await authenticatedRequest(
      harness!,
      "GET",
      `/api/grading/students/${ids.s1}/marks`,
      studentAuth,
    );
    expect(marks.status).toBe(200);
    const periods = (await marks.json()) as {
      periods: {
        subjects: {
          period_approved: boolean;
          categories: { assessments: { name: string; released_at: string }[] }[];
        }[];
      }[];
    };
    const subject = periods.periods[0]!.subjects[0]!;
    expect(subject.period_approved).toBe(false);
    expect(subject.categories.flatMap((c) => c.assessments.map((a) => a.name))).toEqual([
      "First exam",
      "Second exam",
      "Homework",
    ]);
  });
});
