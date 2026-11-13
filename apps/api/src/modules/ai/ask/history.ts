import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { getLocalizedMessage } from "../../../middleware/locale";

import { parseCitationOrders, type Citation } from "./citations";

import type { SupportedLocale } from "../../../middleware/locale";
import type { TransactionSql } from "postgres";

/**
 * Read side of Ask AI conversation persistence: the student's chat history list and one
 * conversation's turns, so a client can reopen an earlier chat and keep asking in it.
 *
 * Both reads see only unexpired messages, the same rule `loadRecentTurns` and
 * `app.delete_expired_ai_messages()` apply, so a conversation whose turns have all aged out drops
 * off the list. A conversation row with no messages at all (the turn that created it failed
 * before persisting) never lists either. Tenant isolation is RLS's job; `student_id` scopes the
 * rest, so another student's conversation reads as not found rather than forbidden.
 */

/** The longest conversation title the list returns; the first question is cut to this. */
export const AI_ASK_CONVERSATION_TITLE_MAX_CHARS = 200;

/** The most turns one conversation read returns, oldest first. */
export const AI_ASK_CONVERSATION_TURN_LIMIT = 200;

export interface ConversationSummary {
  id: string;
  /** The conversation's first question, cut to {@link AI_ASK_CONVERSATION_TITLE_MAX_CHARS}. */
  title: string;
  messageCount: number;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface ListConversationsInput {
  studentId: string;
  limit: number;
  /** Keyset cursor: only conversations whose last message is older than this. */
  before: Date | null;
}

/**
 * The student's conversations, most recently active first. Fetches one row past [limit] so the
 * caller can tell whether another page exists without a count query.
 */
export async function listConversations(
  tx: TransactionSql,
  input: ListConversationsInput,
): Promise<{ conversations: ConversationSummary[]; hasMore: boolean }> {
  const rows = await tx<
    {
      id: string;
      title: string;
      message_count: number;
      created_at: Date;
      last_message_at: Date;
    }[]
  >`
    SELECT c.id, first_turn.title, stats.message_count, c.created_at, stats.last_message_at
    FROM app.ai_conversations c
    JOIN LATERAL (
      SELECT max(m.created_at) AS last_message_at, count(*)::int AS message_count
      FROM app.ai_messages m
      WHERE m.conversation_id = c.id AND m.expires_at > now()
    ) stats ON stats.message_count > 0
    JOIN LATERAL (
      SELECT left(m.question, ${AI_ASK_CONVERSATION_TITLE_MAX_CHARS}) AS title
      FROM app.ai_messages m
      WHERE m.conversation_id = c.id AND m.expires_at > now()
      ORDER BY m.created_at, m.id
      LIMIT 1
    ) first_turn ON true
    WHERE c.student_id = ${input.studentId}::uuid
      AND (${input.before}::timestamptz IS NULL OR stats.last_message_at < ${input.before}::timestamptz)
    ORDER BY stats.last_message_at DESC, c.id DESC
    LIMIT ${input.limit + 1}
  `;

  return {
    conversations: rows.slice(0, input.limit).map((row) => ({
      id: row.id,
      title: row.title,
      messageCount: row.message_count,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
    })),
    hasMore: rows.length > input.limit,
  };
}

export interface ConversationMessage {
  id: string;
  question: string;
  answer: string;
  createdAt: Date;
  citations: Citation[];
}

interface CitationRow {
  ai_message_id: string;
  chunk_id: string;
  material_id: string;
  material_title: string | null;
  page_number: number | null;
  section_title: string | null;
}

export interface LoadConversationInput {
  studentId: string;
  conversationId: string;
  locale: SupportedLocale;
}

/**
 * One conversation's unexpired turns, oldest first, each with its citations. Answers 404
 * `AI_CONVERSATION_NOT_FOUND` for a conversation that is not this student's, the same refusal the
 * ask route gives for continuing one.
 */
export async function loadConversation(
  tx: TransactionSql,
  input: LoadConversationInput,
): Promise<{ id: string; createdAt: Date; messages: ConversationMessage[] }> {
  const [conversation] = await tx<{ id: string; created_at: Date }[]>`
    SELECT id, created_at
    FROM app.ai_conversations
    WHERE id = ${input.conversationId}::uuid AND student_id = ${input.studentId}::uuid
  `;
  if (!conversation) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.AI_CONVERSATION_NOT_FOUND,
      getLocalizedMessage(ERROR_CODES.AI_CONVERSATION_NOT_FOUND, input.locale),
    );
  }

  const messages = await tx<{ id: string; question: string; answer: string; created_at: Date }[]>`
    SELECT id, question, answer, created_at
    FROM app.ai_messages
    WHERE conversation_id = ${conversation.id}::uuid AND expires_at > now()
    ORDER BY created_at, id
    LIMIT ${AI_ASK_CONVERSATION_TURN_LIMIT}
  `;

  const citationRows: CitationRow[] =
    messages.length === 0
      ? []
      : await tx<CitationRow[]>`
          SELECT mc.ai_message_id, ch.id AS chunk_id, ch.material_id,
                 mat.title AS material_title, ch.page_number, ch.section_title
          FROM app.ai_message_citations mc
          JOIN app.material_chunks ch
            ON ch.id = mc.material_chunk_id AND ch.school_id = mc.school_id
          JOIN app.materials mat ON mat.id = ch.material_id AND mat.school_id = ch.school_id
          WHERE mc.ai_message_id = ANY(${messages.map((m) => m.id)}::uuid[])
          ORDER BY mc.ai_message_id, mc.citation_order
        `;

  const byMessage = new Map<string, CitationRow[]>();
  for (const row of citationRows) {
    const list = byMessage.get(row.ai_message_id) ?? [];
    list.push(row);
    byMessage.set(row.ai_message_id, list);
  }

  return {
    id: conversation.id,
    createdAt: conversation.created_at,
    messages: messages.map((message) => {
      const rows = byMessage.get(message.id) ?? [];
      const orders = restoreCitationOrders(message.answer, rows.length);
      return {
        id: message.id,
        question: message.question,
        answer: message.answer,
        createdAt: message.created_at,
        citations: rows.map((row, index) => ({
          order: orders.at(index) ?? index + 1,
          chunkId: row.chunk_id,
          materialId: row.material_id,
          materialTitle: row.material_title,
          pageNumber: row.page_number,
          sectionTitle: row.section_title,
        })),
      };
    }),
  };
}

/**
 * The `[N]` each persisted citation row was written as. `citation_order` is the row's 1-based
 * first-appearance position, not the model's source number, but the answer text still carries the
 * original markers. `resolveCitations` only drops ids past the source count, so every dropped id is
 * larger than every kept one: the [count] smallest distinct ids in the text are exactly the kept
 * set, and their first-appearance order is the row order. Falls back to `1..count` if the text and
 * the rows ever disagree (an answer edited by sanitization, say).
 */
export function restoreCitationOrders(answer: string, count: number): number[] {
  const appearance = parseCitationOrders(answer);
  const kept = new Set([...appearance].sort((a, b) => a - b).slice(0, count));
  const orders = appearance.filter((order) => kept.has(order));
  if (orders.length !== count) return Array.from({ length: count }, (_, index) => index + 1);
  return orders;
}
