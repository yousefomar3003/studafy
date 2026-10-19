import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emit } from "../../lib/events/emitter";
import { emitAuditLog } from "../../middleware/auditEmitter";

import { assertUserIsSchoolAdmin, assertUserTeachesGradebook } from "./grade-entry-service";
import { refreshStudentTermSummary } from "./published/service";

import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One score change, as stored in app.grade_revision_items. */
export interface GradeRevisionChange {
  grade_id: string;
  previous_score: number | null;
  new_score: number | null;
}

export interface GradeRevisionRow {
  id: string;
  school_id: string;
  grade_submission_id: string;
  changes: GradeRevisionChange[];
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  requested_by_user_id: string;
  requested_at: Date;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RequestRevisionInput {
  reason: string;
  changes: { grade_id: string; score: number | null }[];
}

/**
 * The revision's columns plus its items folded into `changes`. The items are aggregated with a
 * correlated subquery so the same list serves SELECT and UPDATE ... RETURNING (an UPDATE never
 * writes items, so RETURNING's snapshot already holds them). Two literal copies rather than one
 * builder: `tx.unsafe` only ever takes constant SQL (CONTRIBUTING.md › SQL safety).
 */
const REVISION_COLUMNS = `app.grade_revisions.id, app.grade_revisions.school_id, app.grade_revisions.grade_submission_id, app.grade_revisions.reason, app.grade_revisions.status,
  app.grade_revisions.requested_by_user_id, app.grade_revisions.requested_at, app.grade_revisions.decided_by_user_id, app.grade_revisions.decided_at,
  app.grade_revisions.rejection_reason, app.grade_revisions.created_at, app.grade_revisions.updated_at,
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'grade_id', item.grade_id,
          'previous_score', item.previous_score,
          'new_score', item.new_score
        )
        ORDER BY item.created_at, item.grade_id
      ),
      '[]'::jsonb
    )
    FROM app.grade_revision_items AS item
    WHERE item.grade_revision_id = app.grade_revisions.id AND item.school_id = app.grade_revisions.school_id
  ) AS changes`;

/** {@link REVISION_COLUMNS} for a query that aliases app.grade_revisions as `gr`. */
const REVISION_COLUMNS_GR = `gr.id, gr.school_id, gr.grade_submission_id, gr.reason, gr.status,
  gr.requested_by_user_id, gr.requested_at, gr.decided_by_user_id, gr.decided_at,
  gr.rejection_reason, gr.created_at, gr.updated_at,
  (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'grade_id', item.grade_id,
          'previous_score', item.previous_score,
          'new_score', item.new_score
        )
        ORDER BY item.created_at, item.grade_id
      ),
      '[]'::jsonb
    )
    FROM app.grade_revision_items AS item
    WHERE item.grade_revision_id = gr.id AND item.school_id = gr.school_id
  ) AS changes`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function revisionNotFound(): never {
  throw new CodedHttpException(
    404,
    ERROR_CODES.GRADE_REVISION_NOT_FOUND,
    "Grade revision not found",
  );
}

function notPending(status: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.GRADE_INVALID_STATUS_TRANSITION,
    `Grade revision is ${status}, not pending`,
  );
}

async function fetchRevisionForUpdate(
  tx: TransactionSql,
  schoolId: string,
  revisionId: string,
): Promise<GradeRevisionRow> {
  // FOR UPDATE: a concurrent approve and withdraw of the same revision serialise here, so the second
  // one sees the first one's status instead of both acting on `pending`.
  const [row] = await tx<GradeRevisionRow[]>`
    SELECT ${tx.unsafe(REVISION_COLUMNS)}
    FROM app.grade_revisions
    WHERE id = ${revisionId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!row) revisionNotFound();
  return row;
}

function scoreOf(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * The most recent non-withdrawn revision of each submission in a gradebook, keyed by submission id.
 * The entry grid carries it so the teacher sees "correction pending" or why the last one was
 * rejected, next to the published scores it would change.
 */
export async function getLatestRevisionsForGradebook(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
): Promise<Map<string, GradeRevisionRow>> {
  const rows = await tx<GradeRevisionRow[]>`
    SELECT DISTINCT ON (gr.grade_submission_id) ${tx.unsafe(REVISION_COLUMNS_GR)}
    FROM app.grade_revisions AS gr
    JOIN app.grade_submissions AS gs
      ON gs.id = gr.grade_submission_id AND gs.school_id = gr.school_id
    WHERE gr.school_id = ${schoolId}::uuid
      AND gs.gradebook_id = ${gradebookId}::uuid
      AND gr.status <> 'withdrawn'
    ORDER BY gr.grade_submission_id, gr.requested_at DESC, gr.id DESC
  `;
  return new Map(rows.map((row) => [row.grade_submission_id, row]));
}

// ---------------------------------------------------------------------------
// Workflow: request (teacher files a correction to published grades)
// ---------------------------------------------------------------------------

/**
 * File a revision of a published submission's scores. The published grades are not touched: they
 * stay what students and parents see until an administrator approves the revision.
 *
 * Only the gradebook's own teacher may file. Changes that leave a score as it is are dropped; a
 * revision that changes nothing is refused. At most one revision per submission may be pending.
 */
export async function requestRevision(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  submissionId: string,
  userId: string,
  input: RequestRevisionInput,
): Promise<GradeRevisionRow> {
  await assertUserTeachesGradebook(tx, gradebookId);

  const [submission] = await tx<{ id: string; status: string }[]>`
    SELECT id, status
    FROM app.grade_submissions
    WHERE id = ${submissionId}::uuid
      AND school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
  `;
  if (!submission) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.GRADE_SUBMISSION_NOT_FOUND,
      "Grade submission not found",
    );
  }
  if (submission.status !== "published") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.GRADE_INVALID_STATUS_TRANSITION,
      "Only published grades are revised through approval; edit a draft submission directly",
    );
  }

  const grades = await tx<{ id: string; score: string | null; max_score: string }[]>`
    SELECT id, score, max_score
    FROM app.grades
    WHERE school_id = ${schoolId}::uuid AND grade_submission_id = ${submissionId}::uuid
  `;
  const gradesById = new Map(grades.map((grade) => [grade.id, grade]));

  const changes: GradeRevisionChange[] = [];
  for (const change of input.changes) {
    const grade = gradesById.get(change.grade_id);
    if (!grade) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.GRADE_SHEET_ITEM_NOT_FOUND,
        `Grade record ${change.grade_id} not found in this submission`,
      );
    }
    const maxScore = Number(grade.max_score);
    if (change.score !== null && (change.score < 0 || change.score > maxScore)) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.GRADE_SCORE_EXCEEDS_MAX,
        `Score ${change.score} exceeds max_score ${maxScore} for grade ${change.grade_id}`,
      );
    }
    const previous = scoreOf(grade.score);
    if (previous === change.score) continue;
    changes.push({ grade_id: change.grade_id, previous_score: previous, new_score: change.score });
  }

  if (changes.length === 0) {
    throw new CodedHttpException(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      "The revision does not change any published score",
    );
  }

  // The partial unique index uq_grade_revisions_pending is the real guard; this read only turns the
  // common case into a clear 409 instead of a unique-violation 500.
  const [pending] = await tx<{ id: string }[]>`
    SELECT id FROM app.grade_revisions
    WHERE school_id = ${schoolId}::uuid
      AND grade_submission_id = ${submissionId}::uuid
      AND status = 'pending'
  `;
  if (pending) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.GRADE_REVISION_ALREADY_PENDING,
      "A revision of these grades is already awaiting approval; withdraw it to file another",
    );
  }

  const [inserted] = await tx<{ id: string }[]>`
    INSERT INTO app.grade_revisions (school_id, grade_submission_id, reason, requested_by_user_id)
    VALUES (${schoolId}::uuid, ${submissionId}::uuid, ${input.reason}, ${userId}::uuid)
    RETURNING id
  `;
  await tx`
    INSERT INTO app.grade_revision_items (
      school_id, grade_revision_id, grade_id, previous_score, new_score
    )
    SELECT ${schoolId}::uuid, ${inserted!.id}::uuid, change.grade_id,
           change.previous_score::numeric(10,2), change.new_score::numeric(10,2)
    FROM jsonb_to_recordset(${tx.json(changes as never)}::jsonb)
      AS change(grade_id uuid, previous_score numeric, new_score numeric)
  `;
  const [created] = await tx<GradeRevisionRow[]>`
    SELECT ${tx.unsafe(REVISION_COLUMNS)}
    FROM app.grade_revisions
    WHERE id = ${inserted!.id}::uuid AND school_id = ${schoolId}::uuid
  `;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "grade_revisions",
    targetId: created!.id,
    newValues: { grade_submission_id: submissionId, reason: input.reason, changes },
  });

  return created!;
}

// ---------------------------------------------------------------------------
// Workflow: withdraw (teacher takes back a pending revision)
// ---------------------------------------------------------------------------

export async function withdrawRevision(
  tx: TransactionSql,
  schoolId: string,
  gradebookId: string,
  revisionId: string,
): Promise<GradeRevisionRow> {
  await assertUserTeachesGradebook(tx, gradebookId);

  const before = await fetchRevisionForUpdate(tx, schoolId, revisionId);
  const [owner] = await tx<{ id: string }[]>`
    SELECT id FROM app.grade_submissions
    WHERE id = ${before.grade_submission_id}::uuid
      AND school_id = ${schoolId}::uuid
      AND gradebook_id = ${gradebookId}::uuid
  `;
  if (!owner) revisionNotFound();
  if (before.status !== "pending") notPending(before.status);

  const [updated] = await tx<GradeRevisionRow[]>`
    UPDATE app.grade_revisions SET
      status = 'withdrawn',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${revisionId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(REVISION_COLUMNS)}
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_revisions",
    targetId: revisionId,
    oldValues: { status: before.status },
    newValues: { status: "withdrawn" },
  });

  return updated!;
}

// ---------------------------------------------------------------------------
// Workflow: decide (school admin / principal approves or rejects)
// ---------------------------------------------------------------------------

/**
 * Approve or reject a pending revision.
 *
 * - **Approve** writes every new score onto app.grades, refreshes the student's term summary and
 *   emits `grades.published`, so the cached published view and the student's notification follow
 *   exactly as they do for a first publication. A score that moved since the revision was filed is
 *   a 409: the reviewer approved an old -> new they were shown, not whatever is there now.
 * - **Reject** records the reason and leaves the published grades untouched.
 */
export async function decideRevision(
  tx: TransactionSql,
  schoolId: string,
  revisionId: string,
  action: "approve" | "reject",
  userId: string,
  rejectionReason?: string | null,
): Promise<GradeRevisionRow> {
  await assertUserIsSchoolAdmin(tx);

  const before = await fetchRevisionForUpdate(tx, schoolId, revisionId);
  if (before.status !== "pending") notPending(before.status);

  if (action === "reject") {
    if (!rejectionReason) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "A rejection reason is required when rejecting a grade revision",
      );
    }

    const [rejected] = await tx<GradeRevisionRow[]>`
      UPDATE app.grade_revisions SET
        status = 'rejected',
        decided_by_user_id = ${userId}::uuid,
        decided_at = CURRENT_TIMESTAMP,
        rejection_reason = ${rejectionReason},
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${revisionId}::uuid AND school_id = ${schoolId}::uuid
      RETURNING ${tx.unsafe(REVISION_COLUMNS)}
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "grade_revisions",
      targetId: revisionId,
      oldValues: { status: before.status },
      newValues: { status: "rejected", rejection_reason: rejectionReason },
    });

    return rejected!;
  }

  const [submission] = await tx<
    { id: string; gradebook_id: string; student_id: string; status: string }[]
  >`
    SELECT id, gradebook_id, student_id, status
    FROM app.grade_submissions
    WHERE id = ${before.grade_submission_id}::uuid AND school_id = ${schoolId}::uuid
  `;
  if (!submission || submission.status !== "published") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.GRADE_INVALID_STATUS_TRANSITION,
      "The revised submission is no longer published",
    );
  }

  const gradeIds = before.changes.map((change) => change.grade_id);
  const current = await tx<{ id: string; score: string | null }[]>`
    SELECT id, score
    FROM app.grades
    WHERE school_id = ${schoolId}::uuid
      AND grade_submission_id = ${submission.id}::uuid
      AND id = ANY (${gradeIds}::uuid[])
    FOR UPDATE
  `;
  const currentById = new Map(current.map((row) => [row.id, scoreOf(row.score)]));
  for (const change of before.changes) {
    if (!currentById.has(change.grade_id)) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.GRADE_SHEET_ITEM_NOT_FOUND,
        `Grade record ${change.grade_id} was removed after the revision was filed`,
      );
    }
    if (currentById.get(change.grade_id) !== change.previous_score) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.GRADE_CONCURRENT_EDIT,
        `Grade ${change.grade_id} changed after the revision was filed. Reload and retry.`,
      );
    }
  }

  await tx`
    UPDATE app.grades AS g SET
      score = change.new_score::numeric(10,2),
      updated_at = CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${tx.json(before.changes as never)}::jsonb)
      AS change(grade_id uuid, new_score numeric)
    WHERE g.id = change.grade_id
      AND g.school_id = ${schoolId}::uuid
      AND g.grade_submission_id = ${submission.id}::uuid
  `;

  const [approved] = await tx<GradeRevisionRow[]>`
    UPDATE app.grade_revisions SET
      status = 'approved',
      decided_by_user_id = ${userId}::uuid,
      decided_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${revisionId}::uuid AND school_id = ${schoolId}::uuid
    RETURNING ${tx.unsafe(REVISION_COLUMNS)}
  `;

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "grade_revisions",
    targetId: revisionId,
    oldValues: { status: before.status },
    newValues: { status: "approved", changes: before.changes },
  });

  await refreshStudentTermSummary(tx, schoolId, submission.student_id, submission.gradebook_id);

  await emit(tx, DOMAIN_EVENTS.GRADES_PUBLISHED, {
    submissionId: submission.id,
    gradebookId: submission.gradebook_id,
    studentId: submission.student_id,
    approvedByUserId: userId,
  });

  return approved!;
}
