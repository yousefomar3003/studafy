/**
 * Recipient resolution for the notification dispatcher (ST-139).
 *
 * Turns a domain event into the exact set of people it concerns, and gathers the context their
 * notification will be rendered from.
 *
 * ## Why this reads the database instead of trusting the event
 *
 * ST-139's ticket assumes `grades.published` carries `class_id`, `assessment_id` or `student_ids`.
 * It does not. The contract of record — `eventPayloadSchemas` in apps/api/src/lib/events/schemas.ts,
 * which is exhaustive over DOMAIN_EVENTS — is
 * `{ submissionId, gradebookId, studentId, approvedByUserId }`: one submission, one student.
 *
 * Widening that payload was rejected. The event is already correct, it has a live subscriber
 * (apps/api/src/modules/grades/subscribers/grade-published.subscriber.ts), and the fields the
 * dispatcher wants — course name, grade label, the student's parents — are all derivable and none
 * of them belong in an event envelope: an event says what happened, not what a consumer will need
 * to say about it. So the job carries the submission id and this module resolves the rest.
 *
 * The functions still take `studentIds: string[]` rather than a single id. A class-wide grade
 * publication is a plausible next event and this is the seam it would arrive through; taking the
 * array now costs nothing and means the fan-out logic does not have to be rewritten to accept it.
 */

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecipientRole = "student" | "parent" | "teacher" | "admin";

export interface DispatchRecipient {
  userId: string;
  role: RecipientRole;
  /** The student this recipient is being notified *about*. Equals their own student row when role is `student`. */
  studentId: string;
}

/** Everything a GRADE_POSTED template needs, plus the ids its deep-link route substitutes. */
export interface GradeEventContext {
  studentId: string;
  studentName: string;
  classId: string;
  courseId: string;
  courseName: string;
  /** The assessment(s) this submission covers, as one display string. */
  assignmentName: string;
  /** The published result, as one display string. */
  grade: string;
}

interface GradeContextRow {
  student_id: string;
  student_name: string;
  class_id: string;
  course_id: string;
  course_name: string;
  assignment_name: string | null;
  total_score: string | null;
  total_max_score: string | null;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Resolve the grade context for one published submission, or `null` if there is nothing to say.
 *
 * `null` rather than a throw when the submission is missing or not published: a job for a
 * submission that has since been deleted, or that never reached `published`, is stale rather than
 * broken. Throwing would burn five retries and dead-letter a job whose correct outcome is "nothing
 * to do" — and the dead-letter table is meant to hold things an operator must act on.
 *
 * The status filter is load-bearing in the other direction too. It is what makes a replayed job
 * safe: publication is a one-shot `approved -> published` transition, so re-running this against a
 * submission that was subsequently un-published resolves nothing rather than re-notifying.
 */
export async function resolveGradeContext(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
): Promise<GradeEventContext | null> {
  const [row] = await tx<GradeContextRow[]>`
    SELECT
      submission.student_id,
      btrim(coalesce(student.preferred_name, student.first_name) || ' ' || student.last_name)
        AS student_name,
      class_row.id AS class_id,
      course.id AS course_id,
      course.name AS course_name,
      grade_summary.labels AS assignment_name,
      grade_summary.total_score::text AS total_score,
      grade_summary.total_max_score::text AS total_max_score
    FROM app.grade_submissions AS submission
    JOIN app.students AS student
      ON student.id = submission.student_id
     AND student.school_id = submission.school_id
    JOIN app.gradebooks AS gradebook
      ON gradebook.id = submission.gradebook_id
     AND gradebook.school_id = submission.school_id
    JOIN app.classes AS class_row
      ON class_row.id = gradebook.class_id
     AND class_row.school_id = gradebook.school_id
    JOIN app.courses AS course
      ON course.id = class_row.course_id
     AND course.school_id = class_row.school_id
    -- LEFT JOIN: a submission with no grade rows is degenerate but publishable, and it should
    -- still notify. The template falls back rather than the whole dispatch disappearing.
    LEFT JOIN LATERAL (
      SELECT
        string_agg(grade.label, ', ' ORDER BY grade.label) AS labels,
        sum(grade.score * grade.weight) AS total_score,
        sum(grade.max_score * grade.weight) AS total_max_score
      FROM app.grades AS grade
      WHERE grade.grade_submission_id = submission.id
        AND grade.school_id = submission.school_id
    ) AS grade_summary ON true
    WHERE submission.id = ${submissionId}::uuid
      AND submission.school_id = ${schoolId}::uuid
      AND submission.status = 'published'
  `;

  if (!row) return null;

  return {
    studentId: row.student_id,
    studentName: row.student_name,
    classId: row.class_id,
    courseId: row.course_id,
    courseName: row.course_name,
    assignmentName: row.assignment_name ?? "the assessment",
    grade: formatGrade(row.total_score, row.total_max_score),
  };
}

/**
 * `"85/100"`, or `"not graded"` when there is no score to show.
 *
 * numeric arrives from postgres.js as a string and is kept as one all the way here — parsing to a
 * JS number would round a numeric(10,2) that has no business being rounded, and this value is only
 * ever substituted into a template.
 */
export function formatGrade(totalScore: string | null, totalMaxScore: string | null): string {
  if (totalScore === null || totalMaxScore === null) return "not graded";
  return `${trimNumeric(totalScore)}/${trimNumeric(totalMaxScore)}`;
}

/** `85.00` -> `85`, `85.50` -> `85.5`. Cosmetic only; never used for arithmetic. */
function trimNumeric(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Every user who should hear about these students' grades: the students themselves, and the
 * parents linked to them through app.parent_child_links.
 *
 * This is the whole of the fan-out acceptance criterion, and it holds by construction rather than
 * by filtering afterwards — the query can only produce a student it was asked about, or a parent
 * with a link row to one of them. A classmate has no link and a parent of another child has no
 * link, so neither can appear.
 *
 * Only `active` users are returned. A suspended or still-invited account has no business receiving
 * mail, and app.notification_preferences is not even seeded until activation, so a non-active
 * recipient would resolve to "every channel disabled" and be logged as a preference suppression —
 * which would be a misleading reason. Excluding them here says the true thing.
 *
 * Ordered so a replay resolves recipients in the same sequence as the original run. That is not
 * required for correctness — the idempotency ledger is the arbiter — but it makes two runs of the
 * same job directly comparable in the dispatch log, which is worth the ORDER BY.
 */
export async function resolveGradeRecipients(
  tx: TransactionSql,
  schoolId: string,
  studentIds: readonly string[],
): Promise<DispatchRecipient[]> {
  if (studentIds.length === 0) return [];

  const rows = await tx<{ user_id: string; role: string; student_id: string }[]>`
    SELECT student.user_id, 'student' AS role, student.id AS student_id
    FROM app.students AS student
    JOIN app.users AS student_user
      ON student_user.id = student.user_id
     AND student_user.school_id = student.school_id
    WHERE student.school_id = ${schoolId}::uuid
      AND student.id = ANY(${[...studentIds]}::uuid[])
      AND student_user.status = 'active'

    UNION ALL

    SELECT link.parent_user_id AS user_id, 'parent' AS role, link.student_id
    FROM app.parent_child_links AS link
    JOIN app.users AS parent_user
      ON parent_user.id = link.parent_user_id
     AND parent_user.school_id = link.school_id
    WHERE link.school_id = ${schoolId}::uuid
      AND link.student_id = ANY(${[...studentIds]}::uuid[])
      AND parent_user.status = 'active'

    ORDER BY student_id, role, user_id
  `;

  return rows.map((row) => ({
    userId: row.user_id,
    role: row.role as RecipientRole,
    studentId: row.student_id,
  }));
}
