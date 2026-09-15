import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emit } from "../../lib/events/emitter";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  assertCanManageGradebook,
  getGradebookByClassId,
  getGradebookById,
} from "./config/gradebook-config-service";
import { refreshStudentTermSummary } from "./published/service";

import type { UpdateGradeEntry } from "./config/schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GradeRow {
  id: string;
  school_id: string;
  grade_submission_id: string;
  score: string | null;
  max_score: string;
  weight: string;
  label: string;
  created_at: Date;
  updated_at: Date;
}

export interface GradeSubmissionRow {
  id: string;
  school_id: string;
  gradebook_id: string;
  student_id: string;
  submitted_by_user_id: string | null;
  decided_by_user_id: string | null;
  rejection_reason: string | null;
  status: string;
  submitted_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GradeSubmissionWithGrades {
  id: string;
  gradebook_id: string;
  student_id: string;
  status: string;
  submitted_by_user_id: string | null;
  decided_by_user_id: string | null;
  rejection_reason: string | null;
  submitted_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
  grades: GradeRow[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_LIMIT = 100;

// ---------------------------------------------------------------------------
// Authorization (re-exported for convenience)
// ---------------------------------------------------------------------------

export { assertCanManageGradebook, getGradebookByClassId, getGradebookById };

// ---------------------------------------------------------------------------
// Enrolled students
// ---------------------------------------------------------------------------

/**
 * Return all active student IDs enrolled in a class.
 */
export async function getEnrolledStudentIds(
  tx: TransactionSql,
  schoolId: string,
  classId: string,
): Promise<string[]> {
  const rows = await tx<{ student_id: string }[]>`
    SELECT student_id
    FROM app.enrollments
    WHERE school_id = ${schoolId}::uuid
      AND class_id = ${classId}::uuid
      AND status = 'active'
    ORDER BY student_id
  `;
  return rows.map((r) => r.student_id);
}

// ---------------------------------------------------------------------------
// Draft submission management
// ---------------------------------------------------------------------------

/**
 * Ensure every enrolled student has a draft grade submission. Students who
 * already have one (of any status) are skipped.
 *
 * Returns all existing (or newly created) submissions for the gradebook.
 */
export async function ensureDraftSubmissions(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  classId: string,
): Promise<GradeSubmissionRow[]> {
  const studentIds = await getEnrolledStudentIds(tx, schoolId, classId);

  if (studentIds.length === 0) {
    return tx<GradeSubmissionRow[]>`
      SELECT id, school_id, gradebook_id, student_id,
             submitted_by_user_id, decided_by_user_id,
             rejection_reason,
             status, submitted_at, decided_at,
             created_at, updated_at
      FROM app.grade_submissions
      WHERE school_id = ${schoolId}::uuid AND gradebook_id = ${gradebookId}::uuid
    `;
  }

  const existing = await tx<GradeSubmissionRow[]>`
    SELECT id, school_id, gradebook_id, student_id,
           submitted_by_user_id, decided_by_user_id,
           rejection_reason,
           status, submitted_at, decided_at,
           created_at, updated_at
    FROM app.grade_submissions
    WHERE school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
      AND student_id = ANY (${studentIds}::uuid[])
  `;

  const existingStudentIds = new Set(existing.map((s) => s.student_id));
  const missingIds = studentIds.filter((id) => !existingStudentIds.has(id));

  if (missingIds.length > 0) {
    // One multi-row INSERT for the whole roster gap rather than one round trip per missing
    // student — a class-opening gradebook can be missing dozens of drafts at once. ON CONFLICT
    // DO NOTHING still applies per row, so a student who was concurrently drafted by another
    // request is silently skipped, same as the single-row version this replaced.
    const created = await tx<GradeSubmissionRow[]>`
      INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id)
      SELECT ${schoolId}::uuid, ${gradebookId}::uuid, student_id
      FROM unnest(${missingIds}::uuid[]) AS student_id
      ON CONFLICT (school_id, gradebook_id, student_id) DO NOTHING
      RETURNING id, school_id, gradebook_id, student_id,
                submitted_by_user_id, decided_by_user_id,
                rejection_reason,
                status, submitted_at, decided_at,
                created_at, updated_at
    `;
    if (created.length > 0) {
      existing.push(...created);
      // Single audit log for the batch, matching the convention bulkUpdateGrades below already
      // uses: a lone insert keeps its own row as the audit target (so a submission's audit trail
      // is findable by its own id), a real batch targets the gradebook instead.
      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "grade_submissions",
        targetId: created.length === 1 ? created[0]!.id : gradebookId,
        newValues: { gradebook_id: gradebookId, student_ids: created.map((row) => row.student_id) },
      });
    }
  }

  return existing;
}

// ---------------------------------------------------------------------------
// Read gradebook entry
// ---------------------------------------------------------------------------

/**
 * Fetch all submissions for a gradebook, each populated with their grade
 * records. Does NOT auto-create submissions — call ensureDraftSubmissions
 * first if that is desired.
 */
export async function getSubmissionsWithGrades(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  status?: string,
): Promise<GradeSubmissionWithGrades[]> {
  const statusClause =
    status !== undefined ? tx`AND gs.status = ${status}::app.grade_submission_status` : tx``;

  const submissions = await tx<GradeSubmissionRow[]>`
    SELECT gs.id, gs.school_id, gs.gradebook_id, gs.student_id,
           gs.submitted_by_user_id, gs.decided_by_user_id,
           gs.rejection_reason,
           gs.status, gs.submitted_at, gs.decided_at,
           gs.created_at, gs.updated_at
    FROM app.grade_submissions AS gs
    WHERE gs.school_id = ${schoolId}::uuid
      AND gs.gradebook_id = ${gradebookId}::uuid
      ${statusClause}
    ORDER BY gs.student_id
  `;

  if (submissions.length === 0) {
    return [];
  }

  const submissionIds = submissions.map((s) => s.id);

  const grades = await tx<GradeRow[]>`
    SELECT id, school_id, grade_submission_id,
           score, max_score, weight, label,
           created_at, updated_at
    FROM app.grades
    WHERE school_id = ${schoolId}::uuid
      AND grade_submission_id = ANY (${submissionIds}::uuid[])
    ORDER BY label, created_at
  `;

  const gradesBySubmissionId = new Map<string, GradeRow[]>();
  for (const g of grades) {
    const list = gradesBySubmissionId.get(g.grade_submission_id);
    if (list) {
      list.push(g);
    } else {
      gradesBySubmissionId.set(g.grade_submission_id, [g]);
    }
  }

  return submissions.map((s) => ({
    id: s.id,
    gradebook_id: s.gradebook_id,
    student_id: s.student_id,
    status: s.status,
    submitted_by_user_id: s.submitted_by_user_id,
    decided_by_user_id: s.decided_by_user_id,
    rejection_reason: s.rejection_reason,
    submitted_at: s.submitted_at,
    decided_at: s.decided_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
    grades: gradesBySubmissionId.get(s.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Bulk grade update — the core grade entry operation
// ---------------------------------------------------------------------------

/**
 * Atomically update one or more grade scores within a gradebook.
 *
 * Each entry carries the `updated_at` the client observed on its last read.
 * If the row has been modified since then, the entire batch is rejected
 * with 409 (GRADE_CONCURRENT_EDIT) — last-write-wins with an optimistic
 * guard.
 *
 * Scores are validated against the persisted `max_score` of each grade
 * record. A score > max_score rejects the entire batch with 400
 * (GRADE_SCORE_EXCEEDS_MAX).
 *
 * Returns the updated grade rows in the same order as the input.
 */
export async function bulkUpdateGrades(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  entries: UpdateGradeEntry[],
): Promise<GradeRow[]> {
  if (entries.length > BATCH_LIMIT) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `Batch size must not exceed ${BATCH_LIMIT}. Got ${entries.length}`,
    );
  }

  // Pre-load all grade rows to validate existence and max_score.
  const gradeIds = entries.map((e) => e.id);
  const existingGrades = await tx<GradeRow[]>`
    SELECT id, school_id, grade_submission_id,
           score, max_score, weight, label,
           created_at, updated_at
    FROM app.grades
    WHERE school_id = ${schoolId}::uuid AND id = ANY (${gradeIds}::uuid[])
  `;

  const gradesById = new Map(existingGrades.map((g) => [g.id, g]));

  // Verify all grades exist.
  for (const id of gradeIds) {
    if (!gradesById.has(id)) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.GRADE_SHEET_ITEM_NOT_FOUND,
        `Grade record ${id} not found in this gradebook`,
      );
    }
  }

  // Verify all grades belong to this gradebook (through their submission).
  const submissionIds = [...new Set(existingGrades.map((g) => g.grade_submission_id))];
  const owningSubmissions = await tx<{ id: string; status: string }[]>`
    SELECT id, status
    FROM app.grade_submissions
    WHERE school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
      AND id = ANY (${submissionIds}::uuid[])
  `;

  if (owningSubmissions.length !== submissionIds.length) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "One or more grade records do not belong to this gradebook",
    );
  }

  if (owningSubmissions.some((submission) => submission.status !== "draft")) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_STATE_MISMATCH,
      "Grades can only be edited while their submission is in draft status",
    );
  }

  // Validate score ranges.
  for (const entry of entries) {
    const row = gradesById.get(entry.id)!;
    const maxScore = Number(row.max_score);

    if (entry.score !== null && (entry.score < 0 || entry.score > maxScore)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.GRADE_SCORE_EXCEEDS_MAX,
        `Score ${entry.score} exceeds max_score ${maxScore} for grade ${entry.id}`,
      );
    }
  }

  // Execute every score update as one statement instead of one round trip per grade cell -- the
  // same jsonb_to_recordset shape attendance-session-service.ts uses for its own batch insert,
  // which sidesteps the postgres.js VALUES-array helper's lack of a null-friendly column type.
  // The per-row optimistic-concurrency guard (WHERE ... updated_at matches the client's read)
  // still applies per row via the join, so a stale or missing entry simply comes back unmatched in
  // RETURNING rather than updated. Schema-level validation (bulkUpdateGradesBodySchema) already
  // rejects a batch with a repeated id, so each id joins at most one row.
  const updateRows = entries.map((entry) => ({
    id: entry.id,
    score: entry.score,
    expected_updated_at: entry.updated_at,
  }));

  const updatedRows =
    updateRows.length === 0
      ? []
      : await tx<GradeRow[]>`
          UPDATE app.grades AS g SET
            score = update_data.score::numeric(10,2),
            updated_at = CURRENT_TIMESTAMP
          FROM jsonb_to_recordset(${tx.json(updateRows)}::jsonb)
            AS update_data(id uuid, score numeric, expected_updated_at timestamptz)
          WHERE g.id = update_data.id
            AND g.school_id = ${schoolId}::uuid
            AND date_trunc('milliseconds', g.updated_at)
              = date_trunc('milliseconds', update_data.expected_updated_at)
          RETURNING g.id, g.school_id, g.grade_submission_id,
                    g.score, g.max_score, g.weight, g.label,
                    g.created_at, g.updated_at
        `;

  const updatedById = new Map(updatedRows.map((row) => [row.id, row]));
  const failedIds = entries.map((entry) => entry.id).filter((id) => !updatedById.has(id));

  if (failedIds.length > 0) {
    // Re-check existence for the entries that didn't update, in one query, rather than per entry.
    // Only the first failure (in the caller's order) is reported, matching the prior per-row loop,
    // which threw on the first mismatch instead of collecting every failure in the batch.
    const stillExisting = await tx<{ id: string }[]>`
      SELECT id FROM app.grades
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${failedIds}::uuid[])
    `;
    const stillExistingIds = new Set(stillExisting.map((row) => row.id));
    const firstFailedId = failedIds[0]!;

    if (stillExistingIds.has(firstFailedId)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.GRADE_CONCURRENT_EDIT,
        `Grade ${firstFailedId} was modified by another user. Reload and retry.`,
      );
    }

    throw new CodedHttpException(
      404,
      ERROR_CODES.GRADE_SHEET_ITEM_NOT_FOUND,
      `Grade record ${firstFailedId} was removed before the update`,
    );
  }

  const results = entries.map((entry) => updatedById.get(entry.id)!);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grades",
    targetId: entries.length === 1 ? entries[0]!.id : gradebookId,
    newValues: { updatedCount: entries.length, gradebookId },
  });

  return results;
}

// ---------------------------------------------------------------------------
// Assessment authoring — materialise one gradeable item across the roster
// ---------------------------------------------------------------------------

export interface CreateAssessmentInput {
  label: string;
  maxScore: number;
  weight: number;
}

/**
 * Add one assessment (a `label` + `max_score` + `weight`) to a gradebook by writing an ungraded
 * grade record into every enrolled student's draft submission.
 *
 * This is the authoring counterpart to {@link bulkUpdateGrades}: `bulkUpdateGrades` only edits
 * grade rows that already exist, and nothing else creates them. Draft submissions are seeded
 * first (via {@link ensureDraftSubmissions}) so a brand-new gradebook becomes enterable in one
 * call.
 *
 * Idempotent on `(submission, label)`: a submission that already carries a row with this label
 * is left untouched, so a retry — or a second assessment sharing a label with an earlier one —
 * never double-inserts. Locked submissions (anything past `draft`) are skipped; their grades are
 * frozen and a late assessment cannot be back-filled onto an already-submitted student.
 *
 * Returns the refreshed entry grid so the caller does not need a follow-up read.
 */
export async function createAssessment(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  classId: string,
  input: CreateAssessmentInput,
): Promise<GradeSubmissionWithGrades[]> {
  if (input.maxScore <= 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `max_score must be greater than 0. Got ${input.maxScore}`,
    );
  }
  if (input.weight <= 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      `weight must be greater than 0. Got ${input.weight}`,
    );
  }

  const submissions = await ensureDraftSubmissions(tx, schoolId, gradebookId, classId);
  const draftIds = submissions.filter((s) => s.status === "draft").map((s) => s.id);

  if (draftIds.length === 0) {
    return getSubmissionsWithGrades(tx, schoolId, gradebookId);
  }

  const alreadyLabelled = await tx<{ grade_submission_id: string }[]>`
    SELECT grade_submission_id
    FROM app.grades
    WHERE school_id = ${schoolId}::uuid
      AND grade_submission_id = ANY (${draftIds}::uuid[])
      AND label = ${input.label}
  `;
  const haveRow = new Set(alreadyLabelled.map((r) => r.grade_submission_id));
  const missing = draftIds.filter((id) => !haveRow.has(id));

  for (const submissionId of missing) {
    await tx`
      INSERT INTO app.grades (school_id, grade_submission_id, score, max_score, weight, label)
      VALUES (
        ${schoolId}::uuid,
        ${submissionId}::uuid,
        NULL,
        ${String(input.maxScore)}::numeric(10,2),
        ${String(input.weight)}::numeric(10,2),
        ${input.label}
      )
    `;
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "grades",
    targetId: gradebookId,
    newValues: {
      gradebookId,
      label: input.label,
      maxScore: input.maxScore,
      weight: input.weight,
      seededCount: missing.length,
    },
  });

  return getSubmissionsWithGrades(tx, schoolId, gradebookId);
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/**
 * Assert the current DB session user teaches the gradebook's class.
 */
export async function assertUserTeachesGradebook(
  tx: TransactionSql,
  gradebookId: string,
): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT app.teaches_gradebook(${gradebookId}) AS allowed
  `;
  if (!row?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only the assigned teacher can submit or unlock grades",
    );
  }
}

/**
 * Assert the current DB session user is a school admin.
 */
export async function assertUserIsSchoolAdmin(tx: TransactionSql): Promise<void> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT app.current_user_is_school_admin() AS allowed
  `;
  if (!row?.allowed) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "Only school administrators can approve or reject grades",
    );
  }
}

// ---------------------------------------------------------------------------
// State machine validation (app-level — complements DB trigger)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  draft: new Set(["submitted"]),
  submitted: new Set(["approved", "rejected"]),
  approved: new Set(["published"]),
  rejected: new Set(["draft"]),
  published: new Set(),
};

function assertValidTransition(from: string, to: string): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed?.has(to)) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.GRADE_INVALID_STATUS_TRANSITION,
      `Cannot transition submission from ${from} to ${to}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Concurrency guard helper
// ---------------------------------------------------------------------------

async function fetchSubmissionOrThrow(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
): Promise<GradeSubmissionRow> {
  const [row] = await tx<GradeSubmissionRow[]>`
    SELECT id, school_id, gradebook_id, student_id,
           submitted_by_user_id, decided_by_user_id,
           rejection_reason,
           status, submitted_at, decided_at,
           created_at, updated_at
    FROM app.grade_submissions
    WHERE id = ${submissionId}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!row) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.GRADE_SUBMISSION_NOT_FOUND,
      "Grade submission not found",
    );
  }
  return row;
}

function concurrencyConflict(submissionId: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.GRADE_CONCURRENT_EDIT,
    `Submission ${submissionId} was modified by another user. Reload and retry.`,
  );
}

// ---------------------------------------------------------------------------
// Workflow: submit (draft → submitted)
// ---------------------------------------------------------------------------

/**
 * Submit a draft grade submission for administrative review.
 *
 * Only the assigned teacher may submit. Emits a `grades.submitted` domain
 * event atomically within the transaction.
 */
export async function submitSubmission(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  submissionId: string,
  updatedAt: string,
  userId: string,
): Promise<GradeSubmissionRow> {
  await assertUserTeachesGradebook(tx, gradebookId);

  const before = await fetchSubmissionOrThrow(tx, schoolId, submissionId);
  assertValidTransition(before.status, "submitted");

  const [updated] = await tx<GradeSubmissionRow[]>`
    UPDATE app.grade_submissions SET
      status = 'submitted'::app.grade_submission_status,
      submitted_by_user_id = ${userId}::uuid,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${submissionId}::uuid
      AND school_id = ${schoolId}::uuid
      AND date_trunc('milliseconds', updated_at)
        = date_trunc('milliseconds', ${updatedAt}::timestamptz)
    RETURNING id, school_id, gradebook_id, student_id,
              submitted_by_user_id, decided_by_user_id,
              rejection_reason,
              status, submitted_at, decided_at,
              created_at, updated_at
  `;

  if (!updated) {
    await fetchSubmissionOrThrow(tx, schoolId, submissionId);
    concurrencyConflict(submissionId);
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_submissions",
    targetId: submissionId,
    oldValues: { status: before.status },
    newValues: { status: "submitted" },
  });

  await emit(tx, DOMAIN_EVENTS.GRADES_SUBMITTED, {
    submissionId,
    gradebookId,
    studentId: updated!.student_id,
  });

  return updated!;
}

// ---------------------------------------------------------------------------
// Workflow: decide (submitted → approved+published | submitted → rejected)
// ---------------------------------------------------------------------------

/**
 * Approve or reject a submitted grade.
 *
 * - **Approve** chains `submitted → approved → published` atomically.
 *   Emits a `grades.published` domain event.
 * - **Reject** transitions to `rejected` with a required rejection reason.
 *   The teacher may later unlock and resubmit.
 *
 * Only a school admin may decide.
 */
export async function decideSubmission(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
  action: "approve" | "reject",
  updatedAt: string,
  userId: string,
  rejectionReason?: string | null,
): Promise<GradeSubmissionRow> {
  await assertUserIsSchoolAdmin(tx);

  const before = await fetchSubmissionOrThrow(tx, schoolId, submissionId);
  assertValidTransition(before.status, action === "approve" ? "approved" : "rejected");

  if (action === "reject") {
    if (!rejectionReason) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "A rejection reason is required when rejecting a grade submission",
      );
    }

    const [updated] = await tx<GradeSubmissionRow[]>`
      UPDATE app.grade_submissions SET
        status = 'rejected'::app.grade_submission_status,
        decided_by_user_id = ${userId}::uuid,
        rejection_reason = ${rejectionReason},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${submissionId}::uuid
        AND school_id = ${schoolId}::uuid
        AND date_trunc('milliseconds', updated_at)
          = date_trunc('milliseconds', ${updatedAt}::timestamptz)
      RETURNING id, school_id, gradebook_id, student_id,
                submitted_by_user_id, decided_by_user_id,
                rejection_reason,
                status, submitted_at, decided_at,
                created_at, updated_at
    `;

    if (!updated) {
      await fetchSubmissionOrThrow(tx, schoolId, submissionId);
      concurrencyConflict(submissionId);
    }

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "grade_submissions",
      targetId: submissionId,
      oldValues: { status: before.status },
      newValues: { status: "rejected", rejection_reason: rejectionReason },
    });

    return updated!;
  }

  // Approve: chain submitted → approved → published within the same transaction.
  const [approved] = await tx<GradeSubmissionRow[]>`
    UPDATE app.grade_submissions SET
      status = 'approved'::app.grade_submission_status,
      decided_by_user_id = ${userId}::uuid,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${submissionId}::uuid
      AND school_id = ${schoolId}::uuid
      AND date_trunc('milliseconds', updated_at)
        = date_trunc('milliseconds', ${updatedAt}::timestamptz)
    RETURNING id, school_id, gradebook_id, student_id,
              submitted_by_user_id, decided_by_user_id,
              rejection_reason,
              status, submitted_at, decided_at,
              created_at, updated_at
  `;

  if (!approved) {
    await fetchSubmissionOrThrow(tx, schoolId, submissionId);
    concurrencyConflict(submissionId);
  }

  const [published] = await tx<GradeSubmissionRow[]>`
    UPDATE app.grade_submissions SET
      status = 'published'::app.grade_submission_status,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${approved!.id}::uuid
      AND school_id = ${schoolId}::uuid
      AND status = 'approved'::app.grade_submission_status
    RETURNING id, school_id, gradebook_id, student_id,
              submitted_by_user_id, decided_by_user_id,
              rejection_reason,
              status, submitted_at, decided_at,
              created_at, updated_at
  `;

  if (!published) {
    throw new CodedHttpException(
      500,
      ERROR_CODES.INTERNAL_ERROR,
      "Failed to publish approved submission",
    );
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_submissions",
    targetId: submissionId,
    oldValues: { status: before.status },
    newValues: { status: "published" },
  });

  await refreshStudentTermSummary(tx, schoolId, published.student_id, published.gradebook_id);

  await emit(tx, DOMAIN_EVENTS.GRADES_PUBLISHED, {
    submissionId,
    gradebookId: published.gradebook_id,
    studentId: published.student_id,
    approvedByUserId: userId,
  });

  return published;
}

// ---------------------------------------------------------------------------
// Workflow: unlock (rejected → draft)
// ---------------------------------------------------------------------------

/**
 * Unlock a rejected submission so the teacher can edit and resubmit.
 *
 * The DB trigger clears all audit columns and the rejection reason.
 * Only the assigned teacher may unlock.
 */
export async function unlockSubmission(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  submissionId: string,
  updatedAt: string,
): Promise<GradeSubmissionRow> {
  await assertUserTeachesGradebook(tx, gradebookId);

  const before = await fetchSubmissionOrThrow(tx, schoolId, submissionId);
  assertValidTransition(before.status, "draft");

  const [updated] = await tx<GradeSubmissionRow[]>`
    UPDATE app.grade_submissions SET
      status = 'draft'::app.grade_submission_status,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${submissionId}::uuid
      AND school_id = ${schoolId}::uuid
      AND date_trunc('milliseconds', updated_at)
        = date_trunc('milliseconds', ${updatedAt}::timestamptz)
    RETURNING id, school_id, gradebook_id, student_id,
              submitted_by_user_id, decided_by_user_id,
              rejection_reason,
              status, submitted_at, decided_at,
              created_at, updated_at
  `;

  if (!updated) {
    await fetchSubmissionOrThrow(tx, schoolId, submissionId);
    concurrencyConflict(submissionId);
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_submissions",
    targetId: submissionId,
    oldValues: { status: before.status },
    newValues: { status: "draft" },
  });

  return updated!;
}

/**
 * @deprecated Use submitSubmission, decideSubmission, or unlockSubmission instead.
 *   This generic function is kept for backward compatibility during the migration
 *   to the workflow-specific API and will be removed in a future release.
 */
export async function updateSubmissionStatus(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
  status: string,
  updatedAt: string,
  userId: string,
): Promise<GradeSubmissionRow> {
  const actorColumn = status === "submitted" ? "submitted_by_user_id" : "decided_by_user_id";

  const [updated] = await tx<GradeSubmissionRow[]>`
    UPDATE app.grade_submissions SET
      status = ${status}::app.grade_submission_status,
      ${tx(actorColumn)} = ${userId}::uuid,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${submissionId}::uuid
      AND school_id = ${schoolId}::uuid
      AND date_trunc('milliseconds', updated_at)
        = date_trunc('milliseconds', ${updatedAt}::timestamptz)
    RETURNING id, school_id, gradebook_id, student_id,
              submitted_by_user_id, decided_by_user_id,
              rejection_reason,
              status, submitted_at, decided_at,
              created_at, updated_at
  `;

  if (!updated) {
    await fetchSubmissionOrThrow(tx, schoolId, submissionId);
    concurrencyConflict(submissionId);
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_submissions",
    targetId: submissionId,
    newValues: { status },
  });

  return updated;
}
