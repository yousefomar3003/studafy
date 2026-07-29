import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertCanManageGradebook, getGradebookById } from "./config/gradebook-config-service";

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

export { assertCanManageGradebook, getGradebookById };

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
    FROM app.class_enrollments
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
             status, submitted_at, decided_at,
             created_at, updated_at
      FROM app.grade_submissions
      WHERE school_id = ${schoolId}::uuid AND gradebook_id = ${gradebookId}::uuid
    `;
  }

  const existing = await tx<GradeSubmissionRow[]>`
    SELECT id, school_id, gradebook_id, student_id,
           submitted_by_user_id, decided_by_user_id,
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
    for (const studentId of missingIds) {
      const [created] = await tx<GradeSubmissionRow[]>`
        INSERT INTO app.grade_submissions (school_id, gradebook_id, student_id)
        VALUES (${schoolId}::uuid, ${gradebookId}::uuid, ${studentId}::uuid)
        ON CONFLICT (school_id, gradebook_id, student_id) DO NOTHING
        RETURNING id, school_id, gradebook_id, student_id,
                  submitted_by_user_id, decided_by_user_id,
                  status, submitted_at, decided_at,
                  created_at, updated_at
      `;
      if (created) {
        existing.push(created);
        await emitAuditLog(tx, {
          action: "insert",
          targetTable: "grade_submissions",
          targetId: created.id,
          newValues: { gradebook_id: gradebookId, student_id: studentId },
        });
      }
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
  const [submissionsExist] = await tx<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM app.grade_submissions
    WHERE school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
      AND id = ANY (${submissionIds}::uuid[])
  `;

  if (Number(submissionsExist?.count ?? 0) !== submissionIds.length) {
    throw new CodedHttpException(
      403,
      ERROR_CODES.AUTHZ_FORBIDDEN,
      "One or more grade records do not belong to this gradebook",
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

  // Execute updates with optimistic concurrency guard.
  const results: GradeRow[] = [];

  for (const entry of entries) {
    const [updated] = await tx<GradeRow[]>`
      UPDATE app.grades SET
        score = ${entry.score != null ? String(entry.score) : null}::numeric(10,2),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${entry.id}::uuid
        AND school_id = ${schoolId}::uuid
        AND updated_at = ${entry.updated_at}::timestamptz
      RETURNING id, school_id, grade_submission_id,
                score, max_score, weight, label,
                created_at, updated_at
    `;

    if (!updated) {
      const current = await tx<{ updated_at: Date | null }[]>`
        SELECT updated_at FROM app.grades
        WHERE id = ${entry.id}::uuid AND school_id = ${schoolId}::uuid
      `;

      if (current.length > 0) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.GRADE_CONCURRENT_EDIT,
          `Grade ${entry.id} was modified by another user. Reload and retry.`,
        );
      }

      throw new CodedHttpException(
        404,
        ERROR_CODES.GRADE_SHEET_ITEM_NOT_FOUND,
        `Grade record ${entry.id} was removed before the update`,
      );
    }

    results.push(updated);
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grades",
    targetId: entries.length === 1 ? entries[0]!.id : gradebookId,
    newValues: { updatedCount: entries.length, gradebookId },
  });

  return results;
}

// ---------------------------------------------------------------------------
// Submission status transitions
// ---------------------------------------------------------------------------

/**
 * Transition a grade submission's status. The actual state machine is
 * enforced by the `enforce_grade_submission_transition` DB trigger.
 *
 * This function sets `status` and `updated_at` only; the trigger
 * populates the audit columns (submitted_by_user_id, submitted_at,
 * decided_by_user_id, decided_at).
 *
 * Uses the same `updated_at` concurrency guard as bulkUpdateGrades.
 */
export async function updateSubmissionStatus(
  tx: TransactionSql,
  schoolId: string,
  submissionId: string,
  status: string,
  updatedAt: string,
  userId: string,
): Promise<GradeSubmissionRow> {
  // Determine which actor column to set based on target status per trigger.
  const actorColumn = status === "submitted" ? "submitted_by_user_id" : "decided_by_user_id";

  const [updated] = await tx<GradeSubmissionRow[]>`
    UPDATE app.grade_submissions SET
      status = ${status}::app.grade_submission_status,
      ${tx(actorColumn)} = ${userId}::uuid,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${submissionId}::uuid
      AND school_id = ${schoolId}::uuid
      AND updated_at = ${updatedAt}::timestamptz
    RETURNING id, school_id, gradebook_id, student_id,
              submitted_by_user_id, decided_by_user_id,
              status, submitted_at, decided_at,
              created_at, updated_at
  `;

  if (!updated) {
    const [current] = await tx<GradeSubmissionRow[]>`
      SELECT id, school_id, gradebook_id, student_id,
             submitted_by_user_id, decided_by_user_id,
             status, submitted_at, decided_at,
             created_at, updated_at
      FROM app.grade_submissions
      WHERE id = ${submissionId}::uuid AND school_id = ${schoolId}::uuid
    `;

    if (current) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.GRADE_CONCURRENT_EDIT,
        `Submission ${submissionId} was modified by another user. Reload and retry.`,
      );
    }

    throw new CodedHttpException(
      404,
      ERROR_CODES.GRADE_SUBMISSION_NOT_FOUND,
      "Grade submission not found",
    );
  }

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_submissions",
    targetId: submissionId,
    newValues: { status },
  });

  return updated;
}
