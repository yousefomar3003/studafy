/**
 * Reading back the AI output a student reports (ST-306), as the text a moderator reviews.
 *
 * The snapshot is always read server-side, never taken from the request: a report must show what
 * the model actually produced for this student, not what a client claims it produced. Every read
 * is scoped to the reporting student, so a student cannot report (and thereby copy into the queue)
 * another student's quiz or conversation. Runs inside the caller's tenant transaction.
 */

import { summaryCacheKey, summaryFingerprint, type SummaryCache } from "../summary/cache";
import { loadSummaryMaterial } from "../summary/materials";

import { toReportSnapshot, type ReportableContentType } from "./reports";

import type { AiSummaryLength } from "../config";
import type { TransactionSql } from "postgres";

export interface ContentSnapshotRequest {
  studentId: string;
  contentType: ReportableContentType;
  /** Message, quiz, deck, or (for a summary) material id. */
  contentId: string;
  /** Required for a summary: which length preset the student saw. */
  summaryLength?: AiSummaryLength;
}

/** @returns the snapshot text, or null when the item does not exist for this student. */
export async function loadContentSnapshot(
  tx: TransactionSql,
  summaryCache: SummaryCache,
  request: ContentSnapshotRequest,
): Promise<string | null> {
  const text = await readContent(tx, summaryCache, request);
  return text === null ? null : toReportSnapshot(text);
}

async function readContent(
  tx: TransactionSql,
  summaryCache: SummaryCache,
  { studentId, contentType, contentId, summaryLength }: ContentSnapshotRequest,
): Promise<string | null> {
  switch (contentType) {
    case "ask_answer":
      return readAskAnswer(tx, studentId, contentId);
    case "quiz":
      return readQuiz(tx, studentId, contentId);
    case "flashcard_deck":
      return readDeck(tx, studentId, contentId);
    case "summary":
      return readSummary(tx, summaryCache, studentId, contentId, summaryLength);
  }
}

async function readAskAnswer(
  tx: TransactionSql,
  studentId: string,
  messageId: string,
): Promise<string | null> {
  const [row] = await tx<{ question: string; answer: string }[]>`
    SELECT m.question, m.answer
    FROM app.ai_messages m
    JOIN app.ai_conversations c ON c.id = m.conversation_id AND c.school_id = m.school_id
    WHERE m.id = ${messageId}::uuid AND c.student_id = ${studentId}::uuid
  `;
  return row ? `Question: ${row.question}\n\nAnswer: ${row.answer}` : null;
}

async function readQuiz(
  tx: TransactionSql,
  studentId: string,
  quizId: string,
): Promise<string | null> {
  const rows = await tx<
    {
      question_order: number;
      prompt: string;
      correct_answer: string | null;
      correct_option_id: string | null;
      option_key: string | null;
      option_text: string | null;
    }[]
  >`
    SELECT qq.question_order, qq.prompt, qq.correct_answer, qq.correct_option_id,
           o.option_key, o.option_text
    FROM app.quizzes q
    JOIN app.quiz_questions qq ON qq.quiz_id = q.id AND qq.school_id = q.school_id
    LEFT JOIN app.quiz_question_options o
      ON o.quiz_question_id = qq.id AND o.school_id = qq.school_id
    WHERE q.id = ${quizId}::uuid AND q.student_id = ${studentId}::uuid
    ORDER BY qq.question_order, o.option_order
  `;
  if (rows.length === 0) return null;

  const lines: string[] = [];
  let currentOrder = -1;
  for (const row of rows) {
    if (row.question_order !== currentOrder) {
      currentOrder = row.question_order;
      lines.push(`${lines.length > 0 ? "\n" : ""}Q${row.question_order}. ${row.prompt}`);
      if (row.correct_answer !== null) lines.push(`  Answer: ${row.correct_answer}`);
    }
    if (row.option_key !== null) {
      const marker = row.option_key === row.correct_option_id ? " (correct)" : "";
      lines.push(`  ${row.option_key}) ${row.option_text}${marker}`);
    }
  }
  return lines.join("\n");
}

async function readDeck(
  tx: TransactionSql,
  studentId: string,
  deckId: string,
): Promise<string | null> {
  const rows = await tx<{ card_order: number; front: string; back: string }[]>`
    SELECT f.card_order, f.front, f.back
    FROM app.flashcard_decks d
    JOIN app.flashcards f ON f.deck_id = d.id AND f.school_id = d.school_id
    WHERE d.id = ${deckId}::uuid AND d.student_id = ${studentId}::uuid
    ORDER BY f.card_order
  `;
  if (rows.length === 0) return null;
  return rows
    .map((card) => `Card ${card.card_order}\n  Front: ${card.front}\n  Back: ${card.back}`)
    .join("\n\n");
}

/**
 * Summaries are never written to Postgres -- they live only in the Redis summary cache
 * (`summary/cache.ts`, 24h TTL) -- so the snapshot is the cached entry the student was served.
 * Once it has expired or the material was re-ingested there is nothing server-verified to
 * snapshot, and the report is refused as not found rather than trusting client-supplied text.
 */
async function readSummary(
  tx: TransactionSql,
  summaryCache: SummaryCache,
  studentId: string,
  materialId: string,
  length: AiSummaryLength | undefined,
): Promise<string | null> {
  if (!length) return null;
  const loaded = await loadSummaryMaterial(tx, materialId);
  if (loaded.status !== "ok") return null;

  const fingerprint = summaryFingerprint(materialId, loaded.material.chunks);
  let entry;
  try {
    entry = await summaryCache.get(summaryCacheKey(studentId, materialId, length, fingerprint));
  } catch {
    entry = null;
  }
  return entry ? entry.summary : null;
}
