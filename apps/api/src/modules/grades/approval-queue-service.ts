import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { approveTimetableVersion, rejectTimetableVersion } from "../academics/timetable-service";

import { decideSubmission } from "./grade-entry-service";
import { decideRevision } from "./grade-revision-service";

import type {
  BulkDecisionEntry,
  BulkDecisionResult,
  DecisionResult,
} from "./approval-queue-schemas";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalQueueRow {
  id: string;
  item_type: "grade_submission" | "grade_revision" | "timetable_version";
  status: string;
  summary: string;
  requested_by_user_id: string | null;
  requested_by_display_name: string | null;
  requested_at: Date | null;
  decided_at: Date | null;
  diff: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// List pending approvals
// ---------------------------------------------------------------------------

export async function listPendingApprovals(
  tx: TransactionSql,
  schoolId: string,
): Promise<{ items: ApprovalQueueRow[]; total: number }> {
  // ST-249: both arms cast status to text. app.grade_submission_status and
  // app.timetable_version_status are different enums with no cast between them, so a bare UNION ALL
  // of the two columns fails Postgres's type resolution for every call — not a data-dependent bug,
  // it never returned a result even with matching pending items. ApprovalQueueRow's `status: string`
  // was always the intended shape; the enums just never got cast to it.
  const rows = await tx<ApprovalQueueRow[]>`
    SELECT
      gs.id,
      'grade_submission' AS item_type,
      gs.status::text,
      concat(
        'Grade submission — ',
        coalesce(st.preferred_name, concat(st.first_name, ' ', st.last_name))
      ) AS summary,
      gs.submitted_by_user_id AS requested_by_user_id,
      u_sub.display_name AS requested_by_display_name,
      gs.submitted_at AS requested_at,
      gs.decided_at,
      jsonb_build_object(
        'gradebook_id', gb.id,
        'gradebook_class_code', c.code,
        'student_id', st.id,
        'student_name', coalesce(st.preferred_name, concat(st.first_name, ' ', st.last_name)),
        'grade_count', COALESCE(gr.grade_count, 0),
        'grades', COALESCE(gr.grades_json, '[]'::jsonb)
      ) AS diff
    FROM app.grade_submissions gs
    JOIN app.gradebooks gb ON gb.id = gs.gradebook_id AND gb.school_id = gs.school_id
    JOIN app.classes c ON c.id = gb.class_id AND c.school_id = gs.school_id
    JOIN app.students st ON st.id = gs.student_id AND st.school_id = gs.school_id
    LEFT JOIN app.users u_sub ON u_sub.id = gs.submitted_by_user_id AND u_sub.school_id = gs.school_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS grade_count,
        jsonb_agg(
          jsonb_build_object(
            'label', gr.label,
            'score', gr.score,
            'max_score', gr.max_score,
            'weight', gr.weight
          )
          ORDER BY gr.label
        ) AS grades_json
      FROM app.grades gr
      WHERE gr.grade_submission_id = gs.id AND gr.school_id = gs.school_id
    ) gr ON true
    WHERE gs.school_id = ${schoolId}::uuid
      AND gs.status = 'submitted'::app.grade_submission_status

    UNION ALL

    -- A teacher's correction to grades that are already published: the diff carries each changed
    -- assessment's published score next to the proposed one.
    SELECT
      rv.id,
      'grade_revision' AS item_type,
      rv.status,
      concat(
        'Grade correction — ',
        coalesce(st.preferred_name, concat(st.first_name, ' ', st.last_name))
      ) AS summary,
      rv.requested_by_user_id,
      u_req.display_name AS requested_by_display_name,
      rv.requested_at,
      rv.decided_at,
      jsonb_build_object(
        'gradebook_id', gb.id,
        'gradebook_class_code', c.code,
        'grade_submission_id', gs.id,
        'student_id', st.id,
        'student_name', coalesce(st.preferred_name, concat(st.first_name, ' ', st.last_name)),
        'reason', rv.reason,
        'changes', COALESCE(ch.changes_json, '[]'::jsonb)
      ) AS diff
    FROM app.grade_revisions rv
    JOIN app.grade_submissions gs ON gs.id = rv.grade_submission_id AND gs.school_id = rv.school_id
    JOIN app.gradebooks gb ON gb.id = gs.gradebook_id AND gb.school_id = gs.school_id
    JOIN app.classes c ON c.id = gb.class_id AND c.school_id = gs.school_id
    JOIN app.students st ON st.id = gs.student_id AND st.school_id = gs.school_id
    LEFT JOIN app.users u_req ON u_req.id = rv.requested_by_user_id AND u_req.school_id = rv.school_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'grade_id', g.id,
          'label', g.label,
          'max_score', g.max_score,
          'previous_score', item.previous_score,
          'new_score', item.new_score
        )
        ORDER BY g.label
      ) AS changes_json
      FROM app.grade_revision_items item
      JOIN app.grades g ON g.id = item.grade_id AND g.school_id = item.school_id
      WHERE item.grade_revision_id = rv.id AND item.school_id = rv.school_id
    ) ch ON true
    WHERE rv.school_id = ${schoolId}::uuid
      AND rv.status = 'pending'

    UNION ALL

    SELECT
      tv.id,
      'timetable_version' AS item_type,
      tv.status::text,
      concat('Timetable — ', tv.name) AS summary,
      tv.submitted_by_user_id AS requested_by_user_id,
      u_sub2.display_name AS requested_by_display_name,
      tv.submitted_at AS requested_at,
      tv.approved_at AS decided_at,
      jsonb_build_object(
        'version_name', tv.name,
        'term_name', t.name,
        'slot_count', COALESCE(ts.slot_count, 0)
      ) AS diff
    FROM app.timetable_versions tv
    JOIN app.terms t ON t.id = tv.term_id AND t.school_id = tv.school_id
    LEFT JOIN app.users u_sub2 ON u_sub2.id = tv.submitted_by_user_id AND u_sub2.school_id = tv.school_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS slot_count
      FROM app.timetable_slots ts
      WHERE ts.timetable_version_id = tv.id AND ts.school_id = tv.school_id
    ) ts ON true
    WHERE tv.school_id = ${schoolId}::uuid
      AND tv.status = 'pending'::app.timetable_version_status

    ORDER BY requested_at DESC NULLS LAST
  `;

  return { items: rows, total: rows.length };
}

// ---------------------------------------------------------------------------
// Bulk decision
// ---------------------------------------------------------------------------

/**
 * A grade publication the caller should notify the student and parents about once the transaction
 * commits: `eventId` is the idempotency key the notification dispatcher dedupes on -- the
 * submission id for a first publication, the revision id for an approved correction, so a
 * correction notifies again rather than being swallowed as a replay of the original publication.
 */
export interface PublishedGradeNotice {
  submissionId: string;
  eventId: string;
}

export async function bulkDecision(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  entries: BulkDecisionEntry[],
): Promise<BulkDecisionResult & { published: PublishedGradeNotice[] }> {
  const results: DecisionResult[] = [];
  const published: PublishedGradeNotice[] = [];

  for (const entry of entries) {
    try {
      if (entry.item_type === "grade_submission") {
        // Fetch current updated_at for concurrency guard.
        const [current] = await tx<{ updated_at: Date }[]>`
          SELECT updated_at
          FROM app.grade_submissions
          WHERE id = ${entry.id}::uuid AND school_id = ${schoolId}::uuid
        `;
        if (!current) {
          results.push({
            item_type: "grade_submission",
            id: entry.id,
            status: null,
            error: "Grade submission not found",
          });
          continue;
        }

        await decideSubmission(
          tx,
          schoolId,
          entry.id,
          entry.action as "approve" | "reject",
          current.updated_at.toISOString(),
          userId,
          entry.action === "reject" ? (entry.rejection_reason ?? null) : null,
        );

        if (entry.action === "approve") {
          published.push({ submissionId: entry.id, eventId: entry.id });
        }

        results.push({
          item_type: "grade_submission",
          id: entry.id,
          status: entry.action === "approve" ? "approved" : "rejected",
          error: null,
        });
      } else if (entry.item_type === "grade_revision") {
        const revision = await decideRevision(
          tx,
          schoolId,
          entry.id,
          entry.action,
          userId,
          entry.action === "reject" ? (entry.rejection_reason ?? null) : null,
        );

        if (revision.status === "approved") {
          published.push({ submissionId: revision.grade_submission_id, eventId: revision.id });
        }

        results.push({
          item_type: "grade_revision",
          id: entry.id,
          status: entry.action === "approve" ? "approved" : "rejected",
          error: null,
        });
      } else {
        if (entry.action === "approve") {
          await approveTimetableVersion(tx, schoolId, entry.id, userId);
        } else {
          await rejectTimetableVersion(tx, schoolId, entry.id, {
            reason: entry.rejection_reason ?? null,
          });
        }

        results.push({
          item_type: "timetable_version",
          id: entry.id,
          status: entry.action === "approve" ? "approved" : "rejected",
          error: null,
        });
      }
    } catch (err) {
      const message =
        err instanceof CodedHttpException || err instanceof HTTPException
          ? err.message
          : "Unexpected error processing decision";

      results.push({
        item_type: entry.item_type,
        id: entry.id,
        status: null,
        error: message,
      });
    }
  }

  const succeeded = results.filter((r) => r.error === null);
  const failed = results.filter((r) => r.error !== null);

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "approval_queue",
    // audit_logs.target_id is a NOT NULL uuid; the literal "bulk" this used to pass failed the cast
    // and rolled back every bulk decision. A batch has no single target row (each decision writes
    // its own audit row above), so the summary row targets the school whose queue was worked.
    targetId: schoolId,
    // ck_audit_logs_payload requires both sides of an `update`: before, these items were pending.
    oldValues: { pending: entries.map((entry) => ({ item_type: entry.item_type, id: entry.id })) },
    newValues: {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      results: results.map((r) => ({
        item_type: r.item_type,
        id: r.id,
        status: r.status,
        error: r.error,
      })),
    },
  });

  return {
    results,
    published,
    summary: {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
  };
}
