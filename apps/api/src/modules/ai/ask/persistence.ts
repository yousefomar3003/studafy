import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getLocalizedMessage } from "../../../middleware/locale";
import { AI_ASK_MESSAGE_RETENTION_DAYS } from "../config";

import type { Citation } from "./citations";
import type { SupportedLocale } from "../../../middleware/locale";
import type { TransactionSql } from "postgres";

/**
 * Conversation and message persistence for Ask AI (ST-165).
 *
 * One row in `app.ai_conversations` per chat session, one row in `app.ai_messages` per turn, and
 * one row in `app.ai_message_citations` per citation the answer actually resolves to (migration
 * 000021 + 000023). All three tables are tenant-isolated by RLS (the composite FKs make a
 * cross-school write physically impossible), and the message insert plus its citation rows are one
 * transaction, so a half-written answer can never land.
 *
 * The message row is also the interaction's audit record — the storage-upload precedent, where the
 * mutation's own record is the ledger rather than a parallel `app.audit_logs` row. Question,
 * answer, prompt/completion token counts, and the cited chunk ids all live in that one row, with a
 * 90-day `expires_at` matching `app.delete_expired_ai_messages()`.
 */

export interface ResolveConversationInput {
  schoolId: string;
  studentId: string;
  /**
   * The student's existing conversation, or null to start a new session. The model id is stamped
   * on a new conversation at creation so the session knows which model it began with.
   */
  conversationId: string | null;
  model: string;
  locale: SupportedLocale;
}

/**
 * Resolve the conversation this turn belongs to, or create it.
 *
 * A supplied `conversationId` must belong to this student within this school — the tenant GUC
 * handles the school half, `student_id` the rest — or the route answers 404
 * `AI_CONVERSATION_NOT_FOUND` rather than silently starting a new session the client did not ask
 * for. A missing id creates the session up front (before any tokens stream), so the `sources`
 * event can carry the conversation id the client will keep appending to.
 */
export async function resolveConversation(
  tx: TransactionSql,
  input: ResolveConversationInput,
): Promise<string> {
  if (input.conversationId) {
    const [row] = await tx<{ id: string }[]>`
      SELECT id
      FROM app.ai_conversations
      WHERE id = ${input.conversationId}::uuid AND student_id = ${input.studentId}::uuid
    `;
    if (!row) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.AI_CONVERSATION_NOT_FOUND,
        getLocalizedMessage(ERROR_CODES.AI_CONVERSATION_NOT_FOUND, input.locale),
      );
    }
    return row.id;
  }

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_conversations (school_id, student_id, model)
    VALUES (${input.schoolId}::uuid, ${input.studentId}::uuid, ${input.model})
    RETURNING id
  `;
  return row!.id;
}

export interface PersistAskMessageInput {
  schoolId: string;
  conversationId: string;
  question: string;
  answer: string;
  /** The answer's resolved citations, in first-appearance order. */
  citations: readonly Citation[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Persist one answered turn and its citations in the caller's tenant transaction.
 *
 * The citation rows carry a composite FK to `app.material_chunks (id, school_id)`, so a chunk that
 * vanished between retrieval and persistence fails the insert and rolls the message back with it —
 * the database half of the citation validator.
 *
 * @returns the new `app.ai_messages.id`.
 */
export async function persistAskMessage(
  tx: TransactionSql,
  input: PersistAskMessageInput,
): Promise<string> {
  const expiresAt = new Date(Date.now() + AI_ASK_MESSAGE_RETENTION_DAYS * 86_400_000);
  const [message] = await tx<{ id: string }[]>`
    INSERT INTO app.ai_messages (
      school_id, conversation_id, question, answer,
      prompt_tokens, completion_tokens, total_tokens, expires_at
    ) VALUES (
      ${input.schoolId}::uuid,
      ${input.conversationId}::uuid,
      ${input.question},
      ${input.answer},
      ${input.promptTokens},
      ${input.completionTokens},
      ${input.totalTokens},
      ${expiresAt}
    )
    RETURNING id
  `;

  // At most AI_ASK_SOURCE_LIMIT citations; a bounded sequential insert keeps the query shapes
  // identical to the rest of the codebase instead of threading postgres.js's multi-row helper.
  for (const [index, citation] of input.citations.entries()) {
    await tx`
      INSERT INTO app.ai_message_citations (
        school_id, ai_message_id, material_chunk_id, citation_order
      ) VALUES (
        ${input.schoolId}::uuid,
        ${message!.id}::uuid,
        ${citation.chunkId}::uuid,
        ${index + 1}
      )
    `;
  }

  return message!.id;
}
