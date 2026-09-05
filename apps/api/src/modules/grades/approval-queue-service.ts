import { HTTPException } from "hono/http-exception";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { approveTimetableVersion, rejectTimetableVersion } from "../academics/timetable-service";

import { decideSubmission } from "./grade-entry-service";

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
  item_type: "grade_submission" | "timetable_version";
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

export async function bulkDecision(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  entries: BulkDecisionEntry[],
): Promise<BulkDecisionResult> {
  const results: DecisionResult[] = [];

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

        results.push({
          item_type: "grade_submission",
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
    targetId: "bulk",
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
    summary: {
      total: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
  };
}
