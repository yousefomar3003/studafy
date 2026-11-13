import type { AnthropicUsage } from "./anthropic-client";
import type { ExamGroundedSource } from "./prompt";
import type { ExamGeneratedItem } from "./schema";
import type { TransactionSql } from "postgres";

/**
 * Exam-session persistence for the generation worker (ST-171).
 *
 * Mirrors `apps/api/src/modules/ai/quiz/persistence.ts`'s insert shape (one `exam_items` row per
 * item, one `exam_item_options` row per MCQ choice, normalized rather than jsonb -- see migration
 * `000102`'s header for why) with one structural difference: `app.exam_sessions` already exists by
 * the time this runs (created `generating` by the API before enqueueing), so this module updates it
 * in place rather than inserting a fresh row the way `persistQuiz` does.
 */

export interface ClaimedExamSession {
  id: string;
  questionCount: number;
}

/**
 * Lock and verify the session is still claimable (`status = 'generating'`).
 *
 * Returns `null` when the row is missing or has already moved past `generating` -- a duplicate or
 * requeued job re-processing a session a previous attempt already settled. That is an idempotent
 * no-op, the same posture `ai-ingestion`'s material claim takes toward an already-`ready` material:
 * generation never runs twice for one session.
 */
export async function claimExamSession(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string },
): Promise<ClaimedExamSession | null> {
  const [row] = await tx<{ id: string; status: string; question_count: number }[]>`
    SELECT id, status, question_count
    FROM app.exam_sessions
    WHERE id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
    FOR UPDATE
  `;
  if (!row || row.status !== "generating") return null;
  return { id: row.id, questionCount: row.question_count };
}

export async function markExamSessionFailed(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string; reason: string },
): Promise<void> {
  await tx`
    UPDATE app.exam_sessions
    SET status = 'failed', failure_reason = ${input.reason}
    WHERE id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
      AND status = 'generating'
  `;
}

export interface PersistExamItemsInput {
  examSessionId: string;
  schoolId: string;
  /** Validated model output, in the order it will be numbered 1..N within the session. */
  items: readonly ExamGeneratedItem[];
  /** The numbered sources the prompt was built from; `item.source_id` indexes into this (1-based). */
  sources: readonly ExamGroundedSource[];
  usage: AnthropicUsage;
}

/**
 * Persist the generated item bank and flip the session to `ready`, atomically -- a crash between
 * inserting items and flipping status must not leave a session that looks `generating` forever with
 * orphaned items, or `ready` with none.
 */
export async function persistExamItemsAndMarkReady(
  tx: TransactionSql,
  input: PersistExamItemsInput,
): Promise<void> {
  // Sequential insert, one item (and, for mcq, its options) at a time -- the same bounded-loop shape
  // quiz/persistence.ts's persistQuiz uses.
  for (const [index, item] of input.items.entries()) {
    const order = index + 1;
    // Bounds-checked by parser.ts before this function is ever called: source_id is always in
    // [1, sources.length].
    const source = input.sources[item.source_id - 1]!;

    const correctOptionId = item.type === "mcq" ? item.correct_option_id : null;
    const correctAnswer = item.type === "short_answer" ? item.correct_answer : null;

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.exam_items (
        school_id, exam_session_id, item_order, item_type, prompt,
        correct_option_id, correct_answer, material_chunk_id
      ) VALUES (
        ${input.schoolId}::uuid,
        ${input.examSessionId}::uuid,
        ${order},
        ${item.type},
        ${item.prompt},
        ${correctOptionId},
        ${correctAnswer},
        ${source.chunkId}::uuid
      )
      RETURNING id
    `;
    const itemId = row!.id;

    if (item.type === "mcq") {
      for (const [optionIndex, option] of item.options.entries()) {
        await tx`
          INSERT INTO app.exam_item_options (
            school_id, exam_item_id, option_order, option_key, option_text
          ) VALUES (
            ${input.schoolId}::uuid,
            ${itemId}::uuid,
            ${optionIndex + 1},
            ${option.id},
            ${option.text}
          )
        `;
      }
    }
  }

  await tx`
    UPDATE app.exam_sessions
    SET status = 'ready', input_tokens = ${input.usage.inputTokens},
        output_tokens = ${input.usage.outputTokens}
    WHERE id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
      AND status = 'generating'
  `;
}
