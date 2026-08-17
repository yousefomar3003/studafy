/**
 * Moderation persistence: audit trail for moderation decisions and teacher-visible answer reports.
 *
 * ai_moderation_decisions: one row per moderation check (input or output), recording whether the
 * check blocked or allowed the text, the matched category (if blocked), and a sha256 hash of the
 * checked text. The full text already lives in app.ai_messages.question or .answer, so the hash
 * avoids duplicating PII while still allowing dedup and lookup.
 *
 * ai_answer_reports: one row per student report. A student can report an answer that passed
 * auto-moderation but they believe is inappropriate or incorrect. Unique on (message_id,
 * reporter_id) prevents double-reports.
 */

import type { TransactionSql } from "postgres";

export interface PersistModerationDecisionInput {
  schoolId: string;
  studentId: string;
  messageId: string | null;
  phase: "input" | "output";
  textHash: string;
  blocked: boolean;
  category: string | null;
}

/**
 * Write one moderation decision to the audit trail. Called for every check, whether it blocked or
 * allowed the content. The messageId is null for input-only checks that never produced a message
 * (i.e., the question was blocked before any answer was generated).
 */
export async function persistModerationDecision(
  tx: TransactionSql,
  input: PersistModerationDecisionInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_moderation_decisions (
      school_id, student_id, message_id, phase, text_hash, blocked, category
    ) VALUES (
      ${input.schoolId}::uuid,
      ${input.studentId}::uuid,
      ${input.messageId ? input.messageId : null}::uuid,
      ${input.phase},
      ${input.textHash},
      ${input.blocked},
      ${input.category}
    )
    RETURNING id
  `;
  return row!.id;
}

export interface PersistAnswerReportInput {
  schoolId: string;
  studentId: string;
  messageId: string;
  reporterId: string;
  reason: string;
}

/**
 * Write one answer report. Throws a raw postgres error on duplicate (message_id, reporter_id),
 * which the route catches and maps to a client-friendly response.
 *
 * @returns the new `app.ai_answer_reports.id`.
 */
export async function persistAnswerReport(
  tx: TransactionSql,
  input: PersistAnswerReportInput,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_answer_reports (
      school_id, student_id, message_id, reporter_id, reason
    ) VALUES (
      ${input.schoolId}::uuid,
      ${input.studentId}::uuid,
      ${input.messageId}::uuid,
      ${input.reporterId}::uuid,
      ${input.reason}
    )
    RETURNING id
  `;
  return row!.id;
}
