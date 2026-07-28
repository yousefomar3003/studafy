import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { SubmissionGradeStatus, SubmissionStatus } from "./schemas";
import type { TransactionSql } from "postgres";

/**
 * Submission persistence and authorization (ST-104).
 *
 * ## Where authorization actually lives
 *
 * Three layers, each doing something the others cannot:
 *
 * 1. `tenant_isolation` (000006) pins every row to app.school_id. Nothing here crosses a school.
 * 2. `role_scope_visibility` on app.assignment_submissions (000037) restricts SELECT to
 *    `app.current_user_is_school_admin() OR app.teaches_assignment(...) OR
 *    app.is_related_to_student(...)` -- an admin, the class's teacher, the student themselves, or a
 *    linked parent. This is what makes one student's work invisible to their classmates, and it is
 *    the reason the reads below carry no ownership predicate of their own.
 * 3. This module, for the things RLS does not express.
 *
 * ## The thing RLS does not express, and why it cannot
 *
 * A teacher's unreleased mark has to be hidden from the student while the submission itself stays
 * visible -- it is the student's own work, and making their hand-in disappear while it is being
 * marked would be worse than showing them nothing. That is a COLUMN rule, and RLS filters rows.
 *
 * So `score`, `feedback`, `graded_at` and `graded_by_user_id` are withheld at the response
 * projection (`toSubmissionResponse` in routes/submission-routes.ts), driven by `gradeIsVisible`
 * below. Note what this module does NOT do: it never selects those columns away. The service
 * always returns the complete row, so audit diffs and event payloads see the truth and only the
 * wire format is narrowed. There is exactly one place that decides, and it is testable without a
 * database.
 *
 * This is deliberately different from app.exam_results, which 000037 gates wholesale on
 * publication. An exam result has no existence for the student before it is published; a
 * submission does.
 *
 * ## Writes
 *
 * `role_scope_visibility` is SELECT-only by design (000037's header says so), so write scope is
 * enforced here -- via `assertCanGradeAssignment` for marking, and via the enrollment predicate
 * inside the upsert for handing in. Both ask the same SECURITY DEFINER helpers the policies use
 * rather than reimplementing "teaches this class" in TypeScript.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmissionRow {
  id: string;
  school_id: string;
  assignment_id: string;
  student_id: string;
  content: string | null;
  status: SubmissionStatus;
  grade_status: SubmissionGradeStatus;
  is_late: boolean;
  attempt_number: number;
  submitted_at: Date | null;
  graded_at: Date | null;
  graded_by_user_id: string | null;
  /**
   * PostgreSQL numeric arrives from postgres.js as a string -- the driver will not silently narrow
   * an arbitrary-precision type to an IEEE double. Kept as a string here and converted once, at the
   * response boundary, so the lossy step is visible rather than implied.
   */
  score: string | null;
  feedback: string | null;
  last_edited_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface SubmitParams {
  content?: string;
}

export interface ListSubmissionsParams {
  limit: number;
  offset: number;
  status?: SubmissionStatus;
  grade_status?: SubmissionGradeStatus;
  student_id?: string;
}

export interface GradeSubmissionParams {
  score?: number;
  feedback?: string | null;
  publish: boolean;
  return_to_student: boolean;
}

// ---------------------------------------------------------------------------
// The privacy rule
// ---------------------------------------------------------------------------

/**
 * Whether this caller may see the marks on this row.
 *
 * Pure, exported, and one line, because it is the single most security-relevant decision in the
 * module and it should be provable without standing up a database. Everything that withholds a
 * grade goes through here.
 *
 * Staff means "an admin, or a teacher of the class this assignment belongs to" -- resolved once
 * per request by `isStaffForAssignment` using the same SQL helpers the RLS policy calls, so
 * "staff" has one definition in the system rather than a TypeScript one and a SQL one that can
 * drift apart.
 */
export function gradeIsVisible(
  row: Pick<SubmissionRow, "grade_status">,
  viewerIsStaff: boolean,
): boolean {
  return viewerIsStaff || row.grade_status === "published";
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/**
 * Is the caller staff for this assignment?
 *
 * One round trip, computed once per request and threaded through the whole page rather than asked
 * per row -- the answer is a property of the caller and the assignment, and cannot differ between
 * two submissions on the same assignment.
 */
export async function isStaffForAssignment(
  tx: TransactionSql,
  assignmentId: string,
): Promise<boolean> {
  const [row] = await tx<{ is_staff: boolean }[]>`
    SELECT (
      app.current_user_is_school_admin() OR app.teaches_assignment(${assignmentId})
    ) AS is_staff
  `;

  return row?.is_staff ?? false;
}

/**
 * Refuse unless the caller may mark work on this assignment.
 *
 * 403 rather than 404 even though it confirms the assignment exists: the caller has already passed
 * the submission:grade permission gate, so they are staff somewhere in this school, and a teacher
 * who mistypes an id is far better served by "not your class" than by "no such thing". The
 * opposite choice is correct on reads -- see getSubmission.
 */
export async function assertCanGradeAssignment(
  tx: TransactionSql,
  assignmentId: string,
): Promise<void> {
  if (!(await isStaffForAssignment(tx, assignmentId))) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.SUBMISSION_FORBIDDEN,
      "You do not teach the class this assignment belongs to",
    );
  }
}

/**
 * The calling user's student id in this tenant, or null if they are not a student.
 *
 * Resolved from `app.scope_user_id()` rather than from a parameter, so there is no request-shaped
 * way to name a different student. This is also what refuses an admin or a teacher trying to hand
 * work in on a student's behalf: they have no app.students row, so they get null and, from the
 * caller, a 403.
 */
export async function resolveCallerStudentId(
  tx: TransactionSql,
  schoolId: string,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    SELECT id FROM app.students
    WHERE school_id = ${schoolId} AND user_id = app.scope_user_id()
  `;

  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

function selectColumns(tx: TransactionSql) {
  return tx`
    s.id, s.school_id, s.assignment_id, s.student_id, s.content,
    s.status, s.grade_status, s.is_late, s.attempt_number,
    s.submitted_at, s.graded_at, s.graded_by_user_id, s.score, s.feedback,
    s.last_edited_by_user_id, s.created_at, s.updated_at
  `;
}

/** Fields worth recording in an audit diff. Timestamps and identity columns are noise there. */
function auditableFields(row: SubmissionRow): Record<string, unknown> {
  return {
    assignment_id: row.assignment_id,
    student_id: row.student_id,
    status: row.status,
    grade_status: row.grade_status,
    is_late: row.is_late,
    attempt_number: row.attempt_number,
    submitted_at: row.submitted_at?.toISOString() ?? null,
    score: row.score,
    feedback: row.feedback,
    graded_by_user_id: row.graded_by_user_id,
  };
}

async function loadSubmission(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
): Promise<SubmissionRow | null> {
  const [row] = await tx<SubmissionRow[]>`
    SELECT ${selectColumns(tx)}
    FROM app.assignment_submissions AS s
    WHERE s.school_id = ${schoolId} AND s.id = ${submissionId}
  `;

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Load one submission, or null when the caller cannot see it.
 *
 * There is no ownership predicate here on purpose: `role_scope_visibility` (000037) already
 * removes rows this caller has no business seeing, and duplicating the rule in SQL would create a
 * second definition of it that could drift. What the caller does with a null matters more -- see
 * the 404 in the route.
 */
export async function getSubmission(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
): Promise<SubmissionRow | null> {
  return loadSubmission(tx, schoolId, submissionId);
}

/**
 * List the submissions on one assignment.
 *
 * Staff get the whole class; everyone else gets their own row and nothing else. The
 * `student_id = callerStudentId` predicate is redundant with RLS and is here anyway, for the same
 * reason `visibilityPredicate()` exists in the assignments service: a student's list should not
 * depend on a policy for its correctness. Remove the policy and this still refuses; remove this and
 * the policy still refuses.
 *
 * The `grade_status` filter is dropped for non-staff rather than rejected. They cannot observe the
 * distinction it filters on -- an unreleased grade reads as `none` to them -- so honouring it would
 * turn the query into an oracle for exactly the fact the projection hides: ask for
 * `grade_status=draft` and a non-empty result tells you marking has begun.
 */
export async function listSubmissions(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  params: ListSubmissionsParams,
  viewerIsStaff: boolean,
  callerStudentId: string | null,
): Promise<{ rows: SubmissionRow[]; total: number }> {
  // A non-staff caller who is not a student has nobody's work to look at. Short-circuiting keeps
  // the SQL below from having to express "match no rows".
  if (!viewerIsStaff && !callerStudentId) {
    return { rows: [], total: 0 };
  }

  const studentFilter = viewerIsStaff
    ? params.student_id
      ? tx`AND s.student_id = ${params.student_id}`
      : tx``
    : tx`AND s.student_id = ${callerStudentId!}`;

  const statusFilter = params.status ? tx`AND s.status = ${params.status}` : tx``;

  const gradeStatusFilter =
    viewerIsStaff && params.grade_status ? tx`AND s.grade_status = ${params.grade_status}` : tx``;

  const rows = await tx<SubmissionRow[]>`
    SELECT ${selectColumns(tx)}
    FROM app.assignment_submissions AS s
    WHERE s.school_id = ${schoolId}
      AND s.assignment_id = ${assignmentId}
      ${studentFilter}
      ${statusFilter}
      ${gradeStatusFilter}
    ORDER BY s.submitted_at DESC NULLS LAST, s.id ASC
    LIMIT ${params.limit} OFFSET ${params.offset}
  `;

  const [counted] = await tx<{ total: string }[]>`
    SELECT count(*)::text AS total
    FROM app.assignment_submissions AS s
    WHERE s.school_id = ${schoolId}
      AND s.assignment_id = ${assignmentId}
      ${studentFilter}
      ${statusFilter}
      ${gradeStatusFilter}
  `;

  return { rows, total: Number(counted?.total ?? 0) };
}

// ---------------------------------------------------------------------------
// Hand-in
// ---------------------------------------------------------------------------

interface SubmitDiagnosis {
  assignment_exists: boolean;
  published: boolean;
  available: boolean;
  within_window: boolean;
  enrolled: boolean;
  already_graded: boolean;
}

/**
 * Work out why the upsert matched nothing, and say so precisely.
 *
 * Run only on the failure path. Folding these conditions into the write as predicates is what
 * makes the write atomic; the cost is that "zero rows" collapses six different refusals into one
 * signal, so they are separated out again here rather than answered with a vague 409.
 */
async function diagnoseSubmitFailure(
  tx: TransactionSql,
  schoolId: string,
  assignmentId: string,
  studentId: string,
): Promise<never> {
  const [d] = await tx<SubmitDiagnosis[]>`
    SELECT
      true AS assignment_exists,
      (a.status = 'published') AS published,
      (a.available_from IS NULL OR CURRENT_TIMESTAMP >= a.available_from) AS available,
      (a.allow_late_submission OR CURRENT_TIMESTAMP <= a.due_at) AS within_window,
      EXISTS (
        SELECT 1 FROM app.enrollments AS e
        WHERE e.school_id = a.school_id AND e.class_id = a.class_id
          AND e.student_id = ${studentId} AND e.status = 'active'
      ) AS enrolled,
      COALESCE(s.grade_status = 'published' AND s.status <> 'returned', false) AS already_graded
    FROM app.assignments AS a
    LEFT JOIN app.assignment_submissions AS s
      ON s.assignment_id = a.id AND s.school_id = a.school_id AND s.student_id = ${studentId}
    WHERE a.id = ${assignmentId} AND a.school_id = ${schoolId}
  `;

  // No row, or a draft assignment. Both answer 404: a student must not be able to tell "this
  // assignment exists but your teacher has not published it" from "no such assignment". A
  // window-closed error here would confirm a draft's existence.
  if (!d || !d.published) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Assignment not found");
  }

  if (!d.enrolled) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.SUBMISSION_NOT_ENROLLED,
      "You are not actively enrolled in the class this assignment belongs to",
    );
  }

  if (d.already_graded) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBMISSION_ALREADY_GRADED,
      "This submission has already been graded. Ask your teacher to return it before resubmitting.",
    );
  }

  if (!d.available) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBMISSION_WINDOW_CLOSED,
      "This assignment is not open for submissions yet",
    );
  }

  if (!d.within_window) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBMISSION_WINDOW_CLOSED,
      "The deadline has passed and this assignment does not accept late submissions",
    );
  }

  // Every predicate the write applies now reports true. Rather than return a success the caller
  // cannot honour, fail loudly -- this means the write and this query have drifted apart.
  throw new CodedHttpException(
    409,
    ERROR_CODES.SUBMISSION_INVALID_STATE,
    "The submission could not be recorded",
  );
}

/**
 * Hand work in, or replace an earlier hand-in.
 *
 * ## Why this is one statement
 *
 * Every gate -- publication, availability, deadline, the assignment's own late policy, active
 * enrollment -- is a predicate on the SELECT feeding the INSERT, and the replace is `ON CONFLICT
 * DO UPDATE`. A failed gate therefore produces zero rows rather than a partial write, and there is
 * no window between checking and writing in which any of those facts could change.
 *
 * `ON CONFLICT DO UPDATE` *is* the atomicity the ticket asks for. Two concurrent double-taps race
 * for uq_assignment_submissions_school_assignment_student; the loser blocks on the index tuple,
 * then resolves to the DO UPDATE and reads attempt_number under the row lock that conflict
 * resolution is already holding. Exactly one row exists afterwards and attempt_number has moved
 * exactly once. A read-then-write would lose an increment, and a SELECT ... FOR UPDATE cannot help
 * because on a first submission there is no row to lock.
 *
 * ## What resubmission clears, and why in the same statement
 *
 * A new attempt invalidates any mark on the old one, so score/feedback/graded_at/graded_by are
 * nulled and grade_status returns to 'none'. That is not tidiness:
 * ck_assignment_submissions_grading_time requires `graded_at >= submitted_at`, and this statement
 * moves submitted_at forward. Splitting the clear from the move would fire the constraint.
 *
 * ## Lateness
 *
 * `CURRENT_TIMESTAMP > a.due_at` is evaluated by PostgreSQL, against the same clock as every
 * ordering and constraint on the row. Computing it in TypeScript would introduce a second clock
 * that can disagree with the first, and the disagreement would be invisible.
 */
export async function submitAssignment(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  studentId: string,
  assignmentId: string,
  params: SubmitParams,
): Promise<{ row: SubmissionRow; created: boolean }> {
  const previous = await tx<SubmissionRow[]>`
    SELECT ${selectColumns(tx)}
    FROM app.assignment_submissions AS s
    WHERE s.school_id = ${schoolId}
      AND s.assignment_id = ${assignmentId}
      AND s.student_id = ${studentId}
  `;

  const [written] = await tx<{ id: string; created: boolean }[]>`
    INSERT INTO app.assignment_submissions (
      school_id, assignment_id, student_id, last_edited_by_user_id,
      content, status, submitted_at, is_late, attempt_number
    )
    SELECT
      ${schoolId}, a.id, ${studentId}, ${userId},
      ${params.content ?? null}, 'submitted', CURRENT_TIMESTAMP,
      (CURRENT_TIMESTAMP > a.due_at), 1
    FROM app.assignments AS a
    WHERE a.id = ${assignmentId}
      AND a.school_id = ${schoolId}
      AND a.status = 'published'
      AND (a.available_from IS NULL OR CURRENT_TIMESTAMP >= a.available_from)
      AND (a.allow_late_submission OR CURRENT_TIMESTAMP <= a.due_at)
      AND EXISTS (
        SELECT 1 FROM app.enrollments AS e
        WHERE e.school_id = a.school_id
          AND e.class_id = a.class_id
          AND e.student_id = ${studentId}
          AND e.status = 'active'
      )
    ON CONFLICT ON CONSTRAINT uq_assignment_submissions_school_assignment_student
    DO UPDATE SET
      content = EXCLUDED.content,
      status = 'submitted',
      submitted_at = CURRENT_TIMESTAMP,
      is_late = EXCLUDED.is_late,
      attempt_number = app.assignment_submissions.attempt_number + 1,
      grade_status = 'none',
      score = NULL,
      feedback = NULL,
      graded_at = NULL,
      graded_by_user_id = NULL,
      last_edited_by_user_id = ${userId},
      updated_at = CURRENT_TIMESTAMP
    WHERE app.assignment_submissions.grade_status <> 'published'
       OR app.assignment_submissions.status = 'returned'
    RETURNING id, (xmax = 0) AS created
  `;

  if (!written) {
    await diagnoseSubmitFailure(tx, schoolId, assignmentId, studentId);
  }

  const row = (await loadSubmission(tx, schoolId, written!.id))!;

  await emitAuditLog(tx, {
    action: written!.created ? "insert" : "update",
    targetTable: "assignment_submissions",
    targetId: row.id,
    oldValues: written!.created ? undefined : auditableFields(previous[0]!),
    newValues: auditableFields(row),
  });

  // Only a first hand-in is a creation. A resubmission is an edit of work the rest of the system
  // already knows about, and re-announcing it would have every consumer treat it as new.
  if (written!.created) {
    await emit(tx, DOMAIN_EVENTS.SUBMISSION_CREATED, {
      submissionId: row.id,
      assignmentId: row.assignment_id,
      studentId: row.student_id,
    });
  }

  return { row, created: written!.created };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Record or release a mark, or send the work back.
 *
 * ## Draft versus publish
 *
 * `publish: false` writes score and feedback with grade_status 'draft' and leaves `status` alone.
 * That combination is what 000049 added the third lifecycle branch for, and leaving `status` at
 * 'submitted' is deliberate: it is the field the student sees, so not moving it is what keeps a
 * draft mark invisible without any masking of the lifecycle itself.
 *
 * `publish: true` moves both axes together -- grade_status 'published' and status 'graded' -- which
 * the constraint requires, so the two can never disagree.
 *
 * ## Why score is checked in SQL
 *
 * `score <= a.max_score` is a join predicate against the assignment rather than a comparison
 * against a separately fetched value. The ceiling and the score are then read in the same statement
 * from the same snapshot, so a concurrent edit to max_score cannot slip between the check and the
 * write.
 */
export async function gradeSubmission(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  submissionId: string,
  params: GradeSubmissionParams,
): Promise<SubmissionRow> {
  const existing = await loadSubmission(tx, schoolId, submissionId);
  if (!existing) {
    throw new CodedHttpException(404, ERROR_CODES.SUBMISSION_NOT_FOUND, "Submission not found");
  }

  await assertCanGradeAssignment(tx, existing.assignment_id);

  if (!existing.submitted_at) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBMISSION_INVALID_STATE,
      "This submission has not been handed in yet",
    );
  }

  // Sending work back clears the mark entirely: the student is being asked to redo it, so a score
  // attached to the superseded attempt would be answering a question no longer on the table. This
  // is also the branch the resubmission gate looks for -- see submitAssignment.
  if (params.return_to_student) {
    await tx`
      UPDATE app.assignment_submissions
      SET status = 'returned',
          grade_status = 'none',
          score = NULL,
          feedback = NULL,
          graded_at = NULL,
          graded_by_user_id = NULL,
          last_edited_by_user_id = ${userId},
          updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId} AND id = ${submissionId}
    `;

    const returned = (await loadSubmission(tx, schoolId, submissionId))!;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "assignment_submissions",
      targetId: submissionId,
      oldValues: auditableFields(existing),
      newValues: auditableFields(returned),
    });

    await emit(tx, DOMAIN_EVENTS.SUBMISSION_RESUBMISSION_REQUESTED, {
      submissionId,
      assignmentId: returned.assignment_id,
      studentId: returned.student_id,
    });

    return returned;
  }

  // `undefined` means "leave it alone" and `null` means "clear it"; COALESCE cannot tell those
  // apart and would silently turn every clear into a no-op. Merged here, where the stored row is
  // already in hand, so the statement stays a flat list of bound parameters.
  const mergedScore = params.score ?? (existing.score === null ? null : Number(existing.score));
  const mergedFeedback = params.feedback === undefined ? existing.feedback : params.feedback;

  if (params.publish && mergedScore === null) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.SUBMISSION_INVALID_STATE,
      "A score is required before a grade can be published",
    );
  }

  const nextGradeStatus = params.publish ? "published" : "draft";
  const nextStatus = params.publish ? "graded" : existing.status;

  const updated = await tx<{ id: string }[]>`
    UPDATE app.assignment_submissions AS s
    SET score = ${mergedScore},
        feedback = ${mergedFeedback},
        graded_at = CURRENT_TIMESTAMP,
        graded_by_user_id = ${userId},
        grade_status = ${nextGradeStatus}::app.submission_grade_status,
        status = ${nextStatus}::app.assignment_submission_status,
        last_edited_by_user_id = ${userId},
        updated_at = CURRENT_TIMESTAMP
    FROM app.assignments AS a
    WHERE s.school_id = ${schoolId}
      AND s.id = ${submissionId}
      AND a.id = s.assignment_id
      AND a.school_id = s.school_id
      AND (${mergedScore}::numeric IS NULL OR ${mergedScore}::numeric <= a.max_score)
    RETURNING s.id
  `;

  if (updated.length === 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.SUBMISSION_SCORE_EXCEEDS_MAX,
      "The score exceeds the maximum available for this assignment",
    );
  }

  const row = (await loadSubmission(tx, schoolId, submissionId))!;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "assignment_submissions",
    targetId: submissionId,
    oldValues: auditableFields(existing),
    newValues: auditableFields(row),
  });

  // Publication is the event, not marking. A draft save is a teacher's private working state and
  // announcing it would notify a student about a grade they cannot see.
  if (params.publish) {
    await emit(tx, DOMAIN_EVENTS.SUBMISSION_GRADED, {
      submissionId,
      assignmentId: row.assignment_id,
      studentId: row.student_id,
    });
  }

  return row;
}

// ---------------------------------------------------------------------------
// Support for the attachment service
// ---------------------------------------------------------------------------

/**
 * Load the fields the attachment flow needs to scope an upload.
 *
 * Separate from getSubmission because the attachment service needs the owning student and the
 * current attempt number and nothing else, and because it must distinguish "no such submission"
 * from "not yours" -- which getSubmission deliberately collapses.
 */
export async function resolveSubmissionForAttachment(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
): Promise<{
  id: string;
  student_id: string;
  assignment_id: string;
  attempt_number: number;
  status: SubmissionStatus;
}> {
  const [row] = await tx<
    {
      id: string;
      student_id: string;
      assignment_id: string;
      attempt_number: number;
      status: SubmissionStatus;
    }[]
  >`
    SELECT id, student_id, assignment_id, attempt_number, status
    FROM app.assignment_submissions
    WHERE school_id = ${schoolId} AND id = ${submissionId}
  `;

  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.SUBMISSION_NOT_FOUND, "Submission not found");
  }

  return row;
}
