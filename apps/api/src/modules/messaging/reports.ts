/**
 * Messaging reports and the school's review queue (app.message_reports, migration 000136).
 *
 * A participant files a report against the other participant of a thread — one message, or the
 * user in general — and the database snapshots the evidence at that moment
 * (app.snapshot_message_report): reviewers are not participants and app.messages has no admin
 * escape hatch, so the snapshot is the only way a reviewer reads the conversation, and it shows
 * exactly what was there when the report was filed.
 *
 * Reviewers hold messageReport:review (ORG_ADMIN, SUPER_ADMIN, PRINCIPAL). The database applies the
 * same role list in its policies, so a report or its snapshot is never readable by anyone else
 * even through a route that forgot its guard.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  getBlockState,
  insertBlock,
  loadParticipants,
  otherParticipant,
  toAttachmentResponse,
} from "./service";

import type {
  CreateMessageReportInput,
  MessageReport,
  MessageReportDetail,
  MessageReportListQuery,
  MessageReportPriority,
  MessageReportReason,
  MessageReportReceipt,
  MessageReportStatus,
  UpdateMessageReportInput,
} from "./report-schemas";
import type { BlockState, MessageAttachmentContentType } from "./schemas";
import type { MessagingActor } from "./service";
import type { StorageService } from "../../lib/storage";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const PRIORITY_BY_REASON: Readonly<Record<MessageReportReason, MessageReportPriority>> = {
  safety_concern: "urgent",
  harassment: "high",
  inappropriate: "high",
  spam: "normal",
  other: "normal",
};

/** Response targets per priority, in hours — the same commitments as AI content reports. */
export const MESSAGE_REPORT_RESPONSE_HOURS: Readonly<Record<MessageReportPriority, number>> = {
  urgent: 24,
  high: 48,
  normal: 120,
};

export const OPEN_MESSAGE_REPORT_STATUSES: readonly MessageReportStatus[] = [
  "pending",
  "in_review",
];

const ALLOWED_TRANSITIONS: Readonly<Record<MessageReportStatus, readonly MessageReportStatus[]>> = {
  pending: ["in_review", "actioned", "dismissed"],
  in_review: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

export function messageReportPriority(reason: MessageReportReason): MessageReportPriority {
  // eslint-disable-next-line security/detect-object-injection -- `reason` is the closed MESSAGE_REPORT_REASONS union
  return PRIORITY_BY_REASON[reason];
}

export function canTransitionMessageReport(
  from: MessageReportStatus,
  to: MessageReportStatus,
): boolean {
  // eslint-disable-next-line security/detect-object-injection -- `from` is the closed MESSAGE_REPORT_STATUSES union
  return ALLOWED_TRANSITIONS[from].includes(to);
}

function reportNotFound(): CodedHttpException {
  return new CodedHttpException(
    404,
    ERROR_CODES.MESSAGE_REPORT_NOT_FOUND,
    "Message report not found",
  );
}

/** postgres.js surfaces a unique violation as SQLSTATE 23505 on `code`. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  reason_category: MessageReportReason;
  details: string | null;
  status: MessageReportStatus;
  priority: MessageReportPriority;
  respond_by: Date;
  created_at: Date;
}

/**
 * Files a report against the other participant of a thread, snapshots the evidence, and optionally
 * blocks them, all in one transaction. 404 for a non-participant or a message outside the thread;
 * 409 MESSAGE_REPORT_ALREADY_OPEN when the caller already has an open report on the same message
 * (or, for a general report, the same thread).
 */
export async function createMessageReport(
  tx: TransactionSql,
  actor: MessagingActor,
  conversationId: string,
  input: CreateMessageReportInput,
): Promise<{ report: MessageReportReceipt; block: BlockState }> {
  const participants = await loadParticipants(tx, actor, conversationId);
  const other = otherParticipant(participants, actor);
  const reporterRole = other.role === "teacher" ? "parent" : "teacher";

  if (input.message_id !== undefined) {
    const [message] = await tx<{ id: string }[]>`
      SELECT id FROM app.messages
      WHERE school_id = ${actor.schoolId}::uuid
        AND conversation_id = ${conversationId}::uuid
        AND id = ${input.message_id}::uuid
    `;
    if (!message) {
      throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Message not found");
    }
  }

  const priority = messageReportPriority(input.reason_category);
  // eslint-disable-next-line security/detect-object-injection -- `priority` is the closed MESSAGE_REPORT_PRIORITIES union
  const hours = MESSAGE_REPORT_RESPONSE_HOURS[priority];

  // A savepoint so a duplicate (unique violation on the open-report indexes) can be answered 409
  // without aborting the caller's transaction.
  let row: ReceiptRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<ReceiptRow[]>`
        INSERT INTO app.message_reports (
          school_id, conversation_id, student_id, message_id, reporter_user_id, reporter_role,
          reported_user_id, reason_category, details, priority, respond_by
        ) VALUES (
          ${actor.schoolId}::uuid, ${conversationId}::uuid, ${participants.student_id}::uuid,
          ${input.message_id ?? null}::uuid, ${actor.userId}::uuid, ${reporterRole},
          ${other.userId}::uuid, ${input.reason_category}, ${input.details ?? null}, ${priority},
          CURRENT_TIMESTAMP + make_interval(hours => ${hours}::int)
        )
        RETURNING id, conversation_id, message_id, reason_category, details, status, priority,
                  respond_by, created_at
      `,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.MESSAGE_REPORT_ALREADY_OPEN,
        "You have already reported this and the report is still open",
      );
    }
    throw error;
  }
  if (!row) throw new Error("INSERT INTO app.message_reports returned no row");

  const [snapshot] = await tx<{ captured: number }[]>`
    SELECT app.snapshot_message_report(${row.id}::uuid) AS captured
  `;

  // Like a message's audit row, the report's carries no free text: the details can quote the
  // conversation, and the audit explorer is not the place a private exchange is read.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "message_reports",
    targetId: row.id,
    newValues: {
      conversation_id: conversationId,
      message_id: row.message_id,
      reported_user_id: other.userId,
      reason_category: row.reason_category,
      priority: row.priority,
      snapshot_message_count: snapshot?.captured ?? 0,
    },
  });

  if (input.also_block === true) await insertBlock(tx, actor, other.userId);

  return {
    report: {
      id: row.id,
      conversation_id: row.conversation_id,
      message_id: row.message_id,
      reason_category: row.reason_category,
      details: row.details,
      status: row.status,
      priority: row.priority,
      respond_by: row.respond_by.toISOString(),
      created_at: row.created_at.toISOString(),
    },
    block: await getBlockState(tx, actor, other.userId),
  };
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

interface ReportRow {
  id: string;
  status: MessageReportStatus;
  priority: MessageReportPriority;
  respond_by: Date;
  is_overdue: boolean;
  reason_category: MessageReportReason;
  details: string | null;
  conversation_id: string;
  message_id: string | null;
  reporter_user_id: string;
  reporter_name: string;
  reporter_role: "parent" | "teacher";
  reported_user_id: string;
  reported_name: string;
  student_id: string;
  student_name: string | null;
  resolution_note: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  block_exists: boolean;
}

function toReport(row: ReportRow): MessageReport {
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    respond_by: row.respond_by.toISOString(),
    is_overdue: row.is_overdue,
    reason_category: row.reason_category,
    details: row.details,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    reporter: { id: row.reporter_user_id, name: row.reporter_name, role: row.reporter_role },
    reported: {
      id: row.reported_user_id,
      name: row.reported_name,
      role: row.reporter_role === "parent" ? "teacher" : "parent",
    },
    student: { id: row.student_id, name: row.student_name ?? "" },
    block_exists: row.block_exists,
    resolution_note: row.resolution_note,
    reviewed_by:
      row.reviewed_by !== null ? { id: row.reviewed_by, name: row.reviewed_by_name ?? "" } : null,
    reviewed_at: row.reviewed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function statusFilter(status: MessageReportListQuery["status"]): string[] | null {
  if (status === undefined) return null;
  if (status === "open") return [...OPEN_MESSAGE_REPORT_STATUSES];
  return [status];
}

async function selectReports(
  tx: TransactionSql,
  actor: MessagingActor,
  filter: { reportId?: string; statuses?: string[] | null; limit?: number; offset?: number },
): Promise<{ rows: ReportRow[]; total: number }> {
  const reportId = filter.reportId ?? null;
  const statuses = filter.statuses ?? null;
  const rows = await tx<(ReportRow & { total: number })[]>`
    SELECT
      mr.id,
      mr.status,
      mr.priority,
      mr.respond_by,
      (mr.status IN ('pending', 'in_review') AND mr.respond_by < CURRENT_TIMESTAMP) AS is_overdue,
      mr.reason_category,
      mr.details,
      mr.conversation_id,
      mr.message_id,
      mr.reporter_user_id,
      coalesce(ru.display_name, ru.email) AS reporter_name,
      mr.reporter_role,
      mr.reported_user_id,
      coalesce(du.display_name, du.email) AS reported_name,
      mr.student_id,
      coalesce(s.preferred_name, s.first_name) || ' ' || s.last_name AS student_name,
      mr.resolution_note,
      mr.reviewed_by,
      coalesce(vu.display_name, vu.email) AS reviewed_by_name,
      mr.reviewed_at,
      mr.created_at,
      mr.updated_at,
      app.message_block_between(mr.reporter_user_id, mr.reported_user_id) AS block_exists,
      count(*) OVER ()::int AS total
    FROM app.message_reports AS mr
    JOIN app.users AS ru ON ru.id = mr.reporter_user_id AND ru.school_id = mr.school_id
    JOIN app.users AS du ON du.id = mr.reported_user_id AND du.school_id = mr.school_id
    LEFT JOIN app.users AS vu ON vu.id = mr.reviewed_by AND vu.school_id = mr.school_id
    LEFT JOIN app.students AS s ON s.id = mr.student_id AND s.school_id = mr.school_id
    WHERE mr.school_id = ${actor.schoolId}::uuid
      AND app.current_user_can_review_message_reports()
      AND (${reportId}::uuid IS NULL OR mr.id = ${reportId}::uuid)
      AND (${statuses}::text[] IS NULL OR mr.status = ANY(${statuses}::text[]))
    ORDER BY
      (mr.status IN ('pending', 'in_review')) DESC,
      CASE mr.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
      mr.respond_by,
      mr.id
    LIMIT ${filter.limit ?? 1}
    OFFSET ${filter.offset ?? 0}
  `;
  return { rows, total: rows[0]?.total ?? 0 };
}

export async function listMessageReports(
  tx: TransactionSql,
  actor: MessagingActor,
  query: MessageReportListQuery,
): Promise<{ reports: MessageReport[]; total: number; limit: number; offset: number }> {
  const { rows, total } = await selectReports(tx, actor, {
    statuses: statusFilter(query.status),
    limit: query.limit,
    offset: query.offset,
  });
  // `total` comes from the window over the page's own rows; a page past the end has none, so
  // count separately only then.
  let count = total;
  if (rows.length === 0 && query.offset > 0) {
    const statuses = statusFilter(query.status);
    const [row] = await tx<{ total: number }[]>`
      SELECT count(*)::int AS total
      FROM app.message_reports
      WHERE school_id = ${actor.schoolId}::uuid
        AND app.current_user_can_review_message_reports()
        AND (${statuses}::text[] IS NULL OR status = ANY(${statuses}::text[]))
    `;
    count = row?.total ?? 0;
  }
  return {
    reports: rows.map(toReport),
    total: count,
    limit: query.limit,
    offset: query.offset,
  };
}

interface SnapshotMessageRow {
  id: string;
  message_id: string;
  sender_user_id: string;
  sender_name: string;
  body: string;
  message_created_at: Date;
  is_reported: boolean;
}

interface SnapshotAttachmentRow {
  report_message_id: string;
  attachment_id: string;
  mime_type: MessageAttachmentContentType;
  size_bytes: string;
  storage_key: string;
}

export async function getMessageReport(
  tx: TransactionSql,
  storage: StorageService | null,
  actor: MessagingActor,
  reportId: string,
): Promise<MessageReportDetail> {
  const {
    rows: [row],
  } = await selectReports(tx, actor, { reportId });
  if (!row) throw reportNotFound();

  const messages = await tx<SnapshotMessageRow[]>`
    SELECT id, message_id, sender_user_id, sender_name, body, message_created_at, is_reported
    FROM app.message_report_messages
    WHERE school_id = ${actor.schoolId}::uuid AND report_id = ${reportId}::uuid
    ORDER BY position
  `;
  // Storage keys reach a reviewer only through this review-gated SECURITY DEFINER lookup.
  const attachments = await tx<SnapshotAttachmentRow[]>`
    SELECT report_message_id, attachment_id, mime_type, size_bytes::text AS size_bytes, storage_key
    FROM app.message_report_attachment_objects(${reportId}::uuid)
  `;
  const byMessage = new Map<string, MessageReportDetail["messages"][number]["attachments"]>();
  for (const attachment of attachments) {
    const list = byMessage.get(attachment.report_message_id) ?? [];
    list.push(
      await toAttachmentResponse(storage, {
        id: attachment.attachment_id,
        storage_key: attachment.storage_key,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
      }),
    );
    byMessage.set(attachment.report_message_id, list);
  }

  return {
    ...toReport(row),
    messages: messages.map((message) => ({
      id: message.message_id,
      sender_id: message.sender_user_id,
      sender_name: message.sender_name,
      body: message.body,
      created_at: message.message_created_at.toISOString(),
      is_reported: message.is_reported,
      attachments: byMessage.get(message.id) ?? [],
    })),
  };
}

/**
 * Moves a report along the review workflow and writes the audit row in the same transaction. The
 * update is conditional on the status the transition was validated from, so two reviewers acting
 * at once cannot both move it: the loser gets 409.
 */
export async function updateMessageReport(
  tx: TransactionSql,
  actor: MessagingActor,
  reportId: string,
  input: UpdateMessageReportInput,
): Promise<MessageReport> {
  const {
    rows: [current],
  } = await selectReports(tx, actor, { reportId });
  if (!current) throw reportNotFound();

  const invalid = () =>
    new CodedHttpException(
      409,
      ERROR_CODES.MESSAGE_REPORT_INVALID_TRANSITION,
      `A ${current.status} report cannot move to ${input.status}`,
    );
  if (!canTransitionMessageReport(current.status, input.status)) throw invalid();

  const note = input.resolution_note ?? current.resolution_note;
  const updated = await tx<{ id: string }[]>`
    UPDATE app.message_reports
    SET status = ${input.status},
        resolution_note = ${note},
        reviewed_by = ${actor.userId}::uuid,
        reviewed_at = clock_timestamp(),
        updated_at = greatest(updated_at, clock_timestamp())
    WHERE school_id = ${actor.schoolId}::uuid
      AND id = ${reportId}::uuid
      AND status = ${current.status}
    RETURNING id
  `;
  if (updated.length === 0) throw invalid();

  await emitAuditLog(tx, {
    action: "update",
    targetTable: "message_reports",
    targetId: reportId,
    oldValues: { status: current.status },
    newValues: { status: input.status, resolution_note: note },
  });

  const {
    rows: [row],
  } = await selectReports(tx, actor, { reportId });
  if (!row) throw reportNotFound();
  return toReport(row);
}
