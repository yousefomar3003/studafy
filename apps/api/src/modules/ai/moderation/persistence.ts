/**
 * Moderation persistence: the filter's audit trail and the content-report queue.
 *
 * ai_moderation_decisions: one row per blocked moderation check, recording the AI surface, the
 * phase (input or output), the matched category, and a sha256 hash of the checked text -- the
 * hash, not the text, so the audit trail never duplicates student content.
 *
 * ai_content_reports (migration 000118): the moderation queue. User reports of an AI output and
 * safety-filter escalations share it; `moderation/reports.ts` decides priority, deadline, and the
 * allowed status changes, this file only stores them.
 */

import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { AiContentType, ReportPriority, ReportReasonCategory, ReportStatus } from "./reports";
import type { TransactionSql } from "postgres";

export type ModerationSurface = "ask" | "quiz" | "flashcards" | "summary";

export interface PersistModerationDecisionInput {
  schoolId: string;
  studentId: string;
  messageId: string | null;
  surface: ModerationSurface;
  phase: "input" | "output";
  textHash: string;
  blocked: boolean;
  category: string | null;
}

/**
 * Write one moderation decision to the audit trail. The messageId is null whenever no Ask AI
 * message exists for the checked text (a blocked question, a blocked answer, or any non-Ask
 * surface).
 */
export async function persistModerationDecision(
  tx: TransactionSql,
  input: PersistModerationDecisionInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_moderation_decisions (
      school_id, student_id, message_id, surface, phase, text_hash, blocked, category
    ) VALUES (
      ${input.schoolId}::uuid,
      ${input.studentId}::uuid,
      ${input.messageId}::uuid,
      ${input.surface},
      ${input.phase},
      ${input.textHash},
      ${input.blocked},
      ${input.category}
    )
    RETURNING id
  `;
  return row!.id;
}

interface ReportDeadline {
  priority: ReportPriority;
  respondBy: Date;
}

export interface InsertUserReportInput extends ReportDeadline {
  schoolId: string;
  studentId: string;
  reporterId: string;
  contentType: AiContentType;
  contentId: string;
  contentSnapshot: string;
  reasonCategory: ReportReasonCategory;
  reason: string | null;
}

/**
 * File a user's report. A second report of the same item by the same user violates
 * uq_ai_content_reports_reporter_content and surfaces as {@link isUniqueViolation}; the route
 * maps it to 409.
 */
export async function insertUserReport(
  tx: TransactionSql,
  input: InsertUserReportInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_content_reports (
      school_id, student_id, content_type, content_id, content_snapshot, source, reporter_id,
      reason_category, reason, priority, respond_by
    ) VALUES (
      ${input.schoolId}::uuid,
      ${input.studentId}::uuid,
      ${input.contentType},
      ${input.contentId}::uuid,
      ${input.contentSnapshot},
      'user_report',
      ${input.reporterId}::uuid,
      ${input.reasonCategory},
      ${input.reason},
      ${input.priority},
      ${input.respondBy}
    )
    RETURNING id
  `;
  return row!.id;
}

export interface InsertFilterEscalationInput extends ReportDeadline {
  schoolId: string;
  studentId: string;
  contentType: AiContentType;
  moderationDecisionId: string;
  contentSnapshot: string;
}

/** File the safety filter's own report of a blocked, escalating category. */
export async function insertFilterEscalation(
  tx: TransactionSql,
  input: InsertFilterEscalationInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_content_reports (
      school_id, student_id, content_type, moderation_decision_id, content_snapshot, source,
      reason_category, priority, respond_by
    ) VALUES (
      ${input.schoolId}::uuid,
      ${input.studentId}::uuid,
      ${input.contentType},
      ${input.moderationDecisionId}::uuid,
      ${input.contentSnapshot},
      'safety_filter',
      'child_safety',
      ${input.priority},
      ${input.respondBy}
    )
    RETURNING id
  `;
  return row!.id;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code: unknown }).code === "23505";
}

// ---------------------------------------------------------------------------------------------------
// Moderation queue reads and review
// ---------------------------------------------------------------------------------------------------

export interface ContentReportRow {
  id: string;
  student_id: string;
  content_type: AiContentType;
  content_id: string | null;
  moderation_decision_id: string | null;
  source: "user_report" | "safety_filter";
  reporter_id: string | null;
  reason_category: ReportReasonCategory;
  reason: string | null;
  priority: ReportPriority;
  respond_by: Date;
  status: ReportStatus;
  resolution_note: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ContentReportDetailRow extends ContentReportRow {
  content_snapshot: string;
}

const REPORT_COLUMNS = `
  id, student_id, content_type, content_id, moderation_decision_id, source, reporter_id,
  reason_category, reason, priority, respond_by, status, resolution_note, reviewed_by,
  reviewed_at, created_at, updated_at
`;

export interface ListContentReportsInput {
  statuses: readonly ReportStatus[];
  priority: ReportPriority | null;
  limit: number;
  offset: number;
}

/**
 * One page of the queue, most urgent first, then soonest due. The snapshot is left out: a list
 * of possibly-harmful text is not something to render in bulk, the detail read returns it.
 */
export async function listContentReports(
  tx: TransactionSql,
  input: ListContentReportsInput,
): Promise<{ rows: ContentReportRow[]; total: number }> {
  const priorityFilter = input.priority ? tx`AND priority = ${input.priority}` : tx``;
  const rows = await tx<(ContentReportRow & { total: string })[]>`
    SELECT ${tx.unsafe(REPORT_COLUMNS)}, count(*) OVER () AS total
    FROM app.ai_content_reports
    WHERE status = ANY(${input.statuses as string[]}::text[])
    ${priorityFilter}
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
      respond_by ASC,
      id ASC
    LIMIT ${input.limit}
    OFFSET ${input.offset}
  `;
  const total = rows[0] ? Number(rows[0].total) : 0;
  return { rows: rows.map(({ total: _total, ...row }) => row), total };
}

export async function getContentReport(
  tx: TransactionSql,
  reportId: string,
): Promise<ContentReportDetailRow | null> {
  const [row] = await tx<ContentReportDetailRow[]>`
    SELECT ${tx.unsafe(REPORT_COLUMNS)}, content_snapshot
    FROM app.ai_content_reports
    WHERE id = ${reportId}::uuid
  `;
  return row ?? null;
}

export interface ReviewContentReportInput {
  reportId: string;
  fromStatus: ReportStatus;
  toStatus: ReportStatus;
  reviewerId: string;
  resolutionNote: string | null;
}

/**
 * Move a report to its next status and write the audit row in the same transaction. The update is
 * conditional on the status the caller validated the transition from, so two moderators acting on
 * the same report cannot both win: the loser gets null and the route answers 409.
 */
export async function reviewContentReport(
  tx: TransactionSql,
  input: ReviewContentReportInput,
): Promise<ContentReportDetailRow | null> {
  const [row] = await tx<ContentReportDetailRow[]>`
    UPDATE app.ai_content_reports
    SET status = ${input.toStatus},
        resolution_note = coalesce(${input.resolutionNote}, resolution_note),
        reviewed_by = ${input.reviewerId}::uuid,
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${input.reportId}::uuid AND status = ${input.fromStatus}
    RETURNING ${tx.unsafe(REPORT_COLUMNS)}, content_snapshot
  `;
  if (!row) return null;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "ai_content_reports",
    targetId: row.id,
    oldValues: { status: input.fromStatus },
    newValues: { status: row.status, resolution_note: row.resolution_note },
  });
  return row;
}
