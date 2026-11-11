/**
 * Erasure of what a person wrote themselves (retention-registry.ts AUTHORED_CONTENT_TABLES): their
 * parent <-> teacher messages and everything the AI study assistant stored for them. The generic
 * walk cannot reach either -- a message body is not a personal-data-named column, and an Ask AI turn
 * hangs off a conversation, not off a SUBJECT_LINK_COLUMNS column -- so runTenantErasure calls in
 * here first, for one person or for a whole school.
 *
 * Messages (per person: the ones they sent, `sender_user_id`):
 *   - the body becomes AUTHORED_TEXT_ERASED_MARKER; the row stays, so the other participant's
 *     thread keeps its shape and their own messages still read in order;
 *   - the images are deleted, and their storage keys returned for the caller to remove once its
 *     transaction has committed;
 *   - the in-app notification each message raised for the recipient quotes it, so that preview is
 *     replaced too. A notification records its conversation, not its message: in a two-person thread
 *     every DIRECT_MESSAGE notification addressed to the other participant was raised by this one.
 *   - Safeguarding wins over erasure. A message an open report points at -- as the reported message,
 *     or in the snapshot filed with it -- is left exactly as it is, images and all, and recorded in
 *     `retained` with how many. An image a report's snapshot points at (open or closed) is kept,
 *     because the snapshot references the image rather than copying it. The report snapshots
 *     themselves are the school's safeguarding record (000136: no DELETE grant anywhere) and are
 *     not touched.
 *
 * AI study assistant (per person: their student record; a parent or teacher has none):
 *   deleted outright -- conversations, questions and answers with their citations, quizzes,
 *   flashcard decks with their cards and review schedule, practice exams with their items and
 *   answers. Nothing outside this content references it except app.ai_moderation_decisions'
 *   optional `message_id`, which is cleared: the decision (a hash, never the text) stays as the
 *   safety filter's audit trail. Reports of AI content (app.ai_content_reports) are kept; they carry
 *   their own snapshot of the reported text.
 *
 * A tenant closure (no subject) applies the same rules to everyone in the school.
 */

import { NOTIFICATION_TYPES } from "@studafy/constants";

import { AUTHORED_CONTENT_TABLES, AUTHORED_TEXT_ERASED_MARKER } from "./retention-registry";

import type { RedactedTableEntry, RetainedTableEntry } from "./dsr-types";
import type { SubjectIdentifiers } from "./subject-resolver";
import type { TransactionSql } from "postgres";

/** app.message_reports statuses (000136) a reviewer has not closed yet. */
export const OPEN_MESSAGE_REPORT_STATUSES: readonly string[] = ["pending", "in_review"];

/** The text columns a replace_text table has replaced. */
const REPLACED_TEXT_COLUMNS: ReadonlyMap<string, string[]> = new Map([
  ["messages", ["body"]],
  ["notifications", ["body"]],
]);

export const MESSAGES_HELD_BY_OPEN_REPORT_REASON =
  "message(s) kept unchanged: an open report to the school (safeguarding) points at them";

export const IMAGES_HELD_BY_REPORT_REASON =
  "image(s) kept: a report filed with the school includes them as evidence (safeguarding record)";

export const MESSAGE_REPORT_SNAPSHOT_REASON =
  "copies of messages filed with a report are the school's safeguarding record";

export const AI_CONTENT_REPORT_REASON =
  "reports of AI content, with the reported text, are the school's safeguarding record";

export interface AuthoredContentErasure {
  redacted: RedactedTableEntry[];
  retained: RetainedTableEntry[];
  /** Message images to delete once the erasure transaction has committed. */
  storageKeys: string[];
}

function entry(table: string, rows: number): RedactedTableEntry {
  const action = AUTHORED_CONTENT_TABLES.get(table);
  if (!action) throw new Error(`app.${table} is not an AUTHORED_CONTENT_TABLES table`);
  return action === "replace_text"
    ? { table, action: "redacted", columns: REPLACED_TEXT_COLUMNS.get(table) ?? [], rows }
    : { table, action: "hard_deleted", columns: [], rows };
}

export async function eraseAuthoredContent(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<AuthoredContentErasure> {
  const messages = await eraseMessages(tx, schoolId, subject);
  const ai = await eraseAiContent(tx, schoolId, subject);
  return {
    redacted: [...messages.redacted, ...ai.redacted].filter((item) => item.rows > 0),
    retained: [...messages.retained, ...ai.retained],
    storageKeys: messages.storageKeys,
  };
}

async function eraseMessages(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<AuthoredContentErasure> {
  const bySender = () => (subject ? tx`AND m.sender_user_id = ${subject.userId}::uuid` : tx``);
  const heldByOpenReport = () => tx`
    (EXISTS (
       SELECT 1 FROM app.message_reports AS r
       WHERE r.school_id = m.school_id AND r.message_id = m.id
         AND r.status = ANY(${OPEN_MESSAGE_REPORT_STATUSES as string[]}::text[])
     )
     OR EXISTS (
       SELECT 1 FROM app.message_report_messages AS rm
       JOIN app.message_reports AS r ON r.school_id = rm.school_id AND r.id = rm.report_id
       WHERE rm.school_id = m.school_id AND rm.message_id = m.id
         AND r.status = ANY(${OPEN_MESSAGE_REPORT_STATUSES as string[]}::text[])
     ))
  `;
  const erasable = () => tx`
    SELECT m.id FROM app.messages AS m
    WHERE m.school_id = ${schoolId}::uuid ${bySender()} AND NOT ${heldByOpenReport()}
  `;

  const images = await tx<{ storage_key: string }[]>`
    DELETE FROM app.message_attachments AS a
    WHERE a.school_id = ${schoolId}::uuid
      AND a.message_id IN (${erasable()})
      AND NOT EXISTS (
        SELECT 1 FROM app.message_report_attachments AS ra
        WHERE ra.school_id = a.school_id AND ra.attachment_id = a.id
      )
    RETURNING a.storage_key
  `;
  // What is left on an erasable message is exactly what a report's snapshot points at.
  const [evidence] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.message_attachments AS a
    WHERE a.school_id = ${schoolId}::uuid AND a.message_id IN (${erasable()})
  `;

  const bodies = await tx`
    UPDATE app.messages AS target
    SET body = ${AUTHORED_TEXT_ERASED_MARKER}
    WHERE target.school_id = ${schoolId}::uuid
      AND target.id IN (${erasable()})
      AND target.body <> ${AUTHORED_TEXT_ERASED_MARKER}
  `;

  const [held] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.messages AS m
    WHERE m.school_id = ${schoolId}::uuid ${bySender()} AND ${heldByOpenReport()}
  `;

  // The recipient's notification quotes the message (apps/api/src/modules/messaging/service.ts
  // notifyRecipient). Per person: notifications to the other participant of a thread this person is
  // in, which only this person's messages can have raised.
  const recipientOfSubject = () =>
    subject
      ? tx`
          AND n.user_id <> ${subject.userId}::uuid
          AND n.metadata ->> 'conversation_id' IN (
            SELECT c.id::text FROM app.message_conversations AS c
            WHERE c.school_id = ${schoolId}::uuid
              AND ${subject.userId}::uuid IN (c.parent_user_id, c.teacher_user_id)
          )
        `
      : tx``;
  const previews = await tx`
    UPDATE app.notifications AS n
    SET body = ${AUTHORED_TEXT_ERASED_MARKER}, updated_at = greatest(n.updated_at, clock_timestamp())
    WHERE n.school_id = ${schoolId}::uuid
      AND n.notification_type = ${NOTIFICATION_TYPES.DIRECT_MESSAGE}::app.notification_type
      AND n.body <> ${AUTHORED_TEXT_ERASED_MARKER}
      ${recipientOfSubject()}
  `;

  const [snapshots] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.message_report_messages AS rm
    WHERE rm.school_id = ${schoolId}::uuid
      ${subject ? tx`AND rm.sender_user_id = ${subject.userId}::uuid` : tx``}
  `;

  const retained: RetainedTableEntry[] = [];
  if (held!.n > 0) {
    retained.push({
      table: "messages",
      reason: `${held!.n} ${MESSAGES_HELD_BY_OPEN_REPORT_REASON}`,
    });
  }
  if (evidence!.n > 0) {
    retained.push({
      table: "message_attachments",
      reason: `${evidence!.n} ${IMAGES_HELD_BY_REPORT_REASON}`,
    });
  }
  if (snapshots!.n > 0) {
    retained.push({ table: "message_report_messages", reason: MESSAGE_REPORT_SNAPSHOT_REASON });
  }

  return {
    redacted: [
      entry("messages", bodies.count),
      entry("message_attachments", images.length),
      entry("notifications", previews.count),
    ],
    retained,
    storageKeys: images.map((row) => row.storage_key),
  };
}

async function eraseAiContent(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<Omit<AuthoredContentErasure, "storageKeys">> {
  // The AI study assistant is a student's: a person with no student record has nothing here.
  if (subject && !subject.studentId) return { redacted: [], retained: [] };
  const studentId = subject?.studentId ?? null;
  /** `AND <alias>.student_id = <the subject's student>`, or nothing for a whole school. */
  const owned = (alias: string) =>
    studentId ? tx`AND ${tx(alias)}.student_id = ${studentId}::uuid` : tx``;
  const counts: [string, number][] = [];
  const run = async (table: string, query: Promise<{ count: number }>) => {
    counts.push([table, (await query).count]);
  };

  // Ask AI. A moderation decision outlives the message it checked: it holds a hash, never the text.
  await tx`
    UPDATE app.ai_moderation_decisions AS d
    SET message_id = NULL
    FROM app.ai_messages AS m
    JOIN app.ai_conversations AS c ON c.school_id = m.school_id AND c.id = m.conversation_id
    WHERE d.school_id = ${schoolId}::uuid AND m.school_id = ${schoolId}::uuid
      AND d.message_id = m.id ${owned("c")}
  `;
  await run(
    "ai_message_citations",
    tx`
      DELETE FROM app.ai_message_citations AS ci
      USING app.ai_messages AS m, app.ai_conversations AS c
      WHERE ci.school_id = ${schoolId}::uuid AND m.school_id = ci.school_id
        AND m.id = ci.ai_message_id AND c.school_id = m.school_id AND c.id = m.conversation_id
        ${owned("c")}
    `,
  );
  await run(
    "ai_messages",
    tx`
      DELETE FROM app.ai_messages AS m
      USING app.ai_conversations AS c
      WHERE m.school_id = ${schoolId}::uuid AND c.school_id = m.school_id
        AND c.id = m.conversation_id ${owned("c")}
    `,
  );
  await run(
    "ai_conversations",
    tx`DELETE FROM app.ai_conversations AS c WHERE c.school_id = ${schoolId}::uuid ${owned("c")}`,
  );

  // Quizzes: questions are ON DELETE RESTRICT from their quiz, options cascade from a question.
  await run(
    "quiz_question_options",
    tx`
      DELETE FROM app.quiz_question_options AS o
      USING app.quiz_questions AS q, app.quizzes AS z
      WHERE o.school_id = ${schoolId}::uuid AND q.school_id = o.school_id
        AND q.id = o.quiz_question_id AND z.school_id = q.school_id AND z.id = q.quiz_id
        ${owned("z")}
    `,
  );
  await run(
    "quiz_questions",
    tx`
      DELETE FROM app.quiz_questions AS q
      USING app.quizzes AS z
      WHERE q.school_id = ${schoolId}::uuid AND z.school_id = q.school_id AND z.id = q.quiz_id
        ${owned("z")}
    `,
  );
  await run(
    "quizzes",
    tx`DELETE FROM app.quizzes AS z WHERE z.school_id = ${schoolId}::uuid ${owned("z")}`,
  );

  // Flashcards: the student's review schedule, then the cards of their decks, then the decks.
  await run(
    "flashcard_reviews",
    tx`
      DELETE FROM app.flashcard_reviews AS r
      WHERE r.school_id = ${schoolId}::uuid
        ${
          studentId
            ? tx`AND (r.student_id = ${studentId}::uuid OR r.card_id IN (
                SELECT f.id FROM app.flashcards AS f
                JOIN app.flashcard_decks AS d ON d.school_id = f.school_id AND d.id = f.deck_id
                WHERE f.school_id = ${schoolId}::uuid AND d.student_id = ${studentId}::uuid
              ))`
            : tx``
        }
    `,
  );
  await run(
    "flashcards",
    tx`
      DELETE FROM app.flashcards AS f
      USING app.flashcard_decks AS d
      WHERE f.school_id = ${schoolId}::uuid AND d.school_id = f.school_id AND d.id = f.deck_id
        ${owned("d")}
    `,
  );
  await run(
    "flashcard_decks",
    tx`DELETE FROM app.flashcard_decks AS d WHERE d.school_id = ${schoolId}::uuid ${owned("d")}`,
  );

  // Practice exams: items are ON DELETE RESTRICT from their session; options and answers cascade.
  await run(
    "exam_item_options",
    tx`
      DELETE FROM app.exam_item_options AS x
      USING app.exam_items AS i, app.exam_sessions AS s
      WHERE x.school_id = ${schoolId}::uuid AND i.school_id = x.school_id
        AND i.id = x.exam_item_id AND s.school_id = i.school_id AND s.id = i.exam_session_id
        ${owned("s")}
    `,
  );
  await run(
    "exam_item_answers",
    tx`
      DELETE FROM app.exam_item_answers AS x
      USING app.exam_items AS i, app.exam_sessions AS s
      WHERE x.school_id = ${schoolId}::uuid AND i.school_id = x.school_id
        AND i.id = x.exam_item_id AND s.school_id = i.school_id AND s.id = i.exam_session_id
        ${owned("s")}
    `,
  );
  await run(
    "exam_items",
    tx`
      DELETE FROM app.exam_items AS i
      USING app.exam_sessions AS s
      WHERE i.school_id = ${schoolId}::uuid AND s.school_id = i.school_id
        AND s.id = i.exam_session_id ${owned("s")}
    `,
  );
  await run(
    "exam_sessions",
    tx`DELETE FROM app.exam_sessions AS s WHERE s.school_id = ${schoolId}::uuid ${owned("s")}`,
  );

  const [reports] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM app.ai_content_reports AS r
    WHERE r.school_id = ${schoolId}::uuid ${owned("r")}
  `;

  return {
    redacted: counts.map(([table, rows]) => entry(table, rows)),
    retained:
      reports!.n > 0 ? [{ table: "ai_content_reports", reason: AI_CONTENT_REPORT_REASON }] : [],
  };
}
