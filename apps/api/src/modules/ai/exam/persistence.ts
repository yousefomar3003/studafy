import type { ExamItemType } from "./grading";
import type { TransactionSql } from "postgres";

/**
 * Exam-session persistence (ST-171): the API side of the store the generation worker
 * (`apps/workers/src/queues/exam-generation/persistence.ts`) also writes to. This module never
 * inserts `app.exam_items` / `app.exam_item_options` -- that is the worker's job, once generation
 * succeeds -- it creates the session row the worker fills in, reads it back at every lifecycle
 * stage, and (at submit) writes what the student answered.
 */

export interface ExamItemCitation {
  chunkId: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
}

export type ExamSessionStatus = "generating" | "ready" | "in_progress" | "submitted" | "failed";

export interface ExamSessionRow {
  id: string;
  status: ExamSessionStatus;
  model: string;
  tier: string;
  questionCount: number;
  durationMinutes: number;
  startedAt: Date | null;
  expiresAt: Date | null;
  submittedAt: Date | null;
  correctCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  failureReason: string | null;
  createdAt: Date;
}

function toSessionRow(row: {
  id: string;
  status: string;
  model: string;
  tier: string;
  question_count: number;
  duration_minutes: number;
  started_at: Date | null;
  expires_at: Date | null;
  submitted_at: Date | null;
  correct_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  failure_reason: string | null;
  created_at: Date;
}): ExamSessionRow {
  return {
    id: row.id,
    status: row.status as ExamSessionStatus,
    model: row.model,
    tier: row.tier,
    questionCount: row.question_count,
    durationMinutes: row.duration_minutes,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    submittedAt: row.submitted_at,
    correctCount: row.correct_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

type SessionRowFromDb = Parameters<typeof toSessionRow>[0];

export interface CreateExamSessionInput {
  schoolId: string;
  studentId: string;
  model: string;
  tier: string;
  questionCount: number;
  durationMinutes: number;
}

export async function createExamSession(
  tx: TransactionSql,
  input: CreateExamSessionInput,
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await tx<{ id: string; created_at: Date }[]>`
    INSERT INTO app.exam_sessions (
      school_id, student_id, model, tier, question_count, duration_minutes
    ) VALUES (
      ${input.schoolId}::uuid, ${input.studentId}::uuid, ${input.model}, ${input.tier},
      ${input.questionCount}, ${input.durationMinutes}
    )
    RETURNING id, created_at
  `;
  return { id: row!.id, createdAt: row!.created_at };
}

/**
 * Fails a session that was created but never successfully enqueued -- the create route's own
 * failure path, distinct from the worker's identical-shaped guard in
 * `apps/workers/src/queues/exam-generation/persistence.ts`. Small enough (one guarded UPDATE) that
 * sharing it across the process boundary is not worth the cross-app plumbing; see
 * docs/rag/exam-mode.md.
 */
export async function failExamSessionEnqueue(
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

/**
 * Load a session, scoped to the student who owns it -- the same posture
 * `quiz/persistence.ts`'s `loadQuizForGrading` takes: RLS already fences the school, but nothing
 * fences the student, so a session generated for a different student in the same school must still
 * read as absent. Returns null when no such session exists for this student.
 */
export async function loadExamSession(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string; studentId: string },
): Promise<ExamSessionRow | null> {
  const [row] = await tx<SessionRowFromDb[]>`
    SELECT
      id, status, model, tier, question_count, duration_minutes, started_at, expires_at,
      submitted_at, correct_count, input_tokens, output_tokens, failure_reason, created_at
    FROM app.exam_sessions
    WHERE id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
      AND student_id = ${input.studentId}::uuid
  `;
  return row ? toSessionRow(row) : null;
}

export interface ExamItemView {
  id: string;
  order: number;
  type: ExamItemType;
  prompt: string;
  options: { id: string; text: string }[] | null;
  citation: ExamItemCitation;
}

/**
 * Load a session's items without the answer key, in item order -- what the start response and an
 * in-progress `GET` both render. Does not check the session's status; the caller decides when this
 * is the right thing to show.
 */
export async function loadExamItems(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string },
): Promise<ExamItemView[]> {
  const itemRows = await tx<
    {
      id: string;
      item_order: number;
      item_type: ExamItemType;
      prompt: string;
      material_chunk_id: string;
      material_id: string;
      material_title: string | null;
      page_number: number | null;
      section_title: string | null;
    }[]
  >`
    SELECT
      ei.id, ei.item_order, ei.item_type, ei.prompt,
      ei.material_chunk_id, mc.material_id, m.title AS material_title,
      mc.page_number, mc.section_title
    FROM app.exam_items ei
    JOIN app.material_chunks mc ON mc.id = ei.material_chunk_id
    JOIN app.materials m ON m.id = mc.material_id
    WHERE ei.exam_session_id = ${input.examSessionId}::uuid AND ei.school_id = ${input.schoolId}::uuid
    ORDER BY ei.item_order ASC
  `;

  const optionRows = await tx<
    { exam_item_id: string; option_order: number; option_key: string; option_text: string }[]
  >`
    SELECT eio.exam_item_id, eio.option_order, eio.option_key, eio.option_text
    FROM app.exam_item_options eio
    JOIN app.exam_items ei ON ei.id = eio.exam_item_id
    WHERE ei.exam_session_id = ${input.examSessionId}::uuid AND eio.school_id = ${input.schoolId}::uuid
    ORDER BY eio.exam_item_id, eio.option_order ASC
  `;
  const optionsByItem = new Map<string, { id: string; text: string }[]>();
  for (const option of optionRows) {
    const list = optionsByItem.get(option.exam_item_id) ?? [];
    list.push({ id: option.option_key, text: option.option_text });
    optionsByItem.set(option.exam_item_id, list);
  }

  return itemRows.map((row) => ({
    id: row.id,
    order: row.item_order,
    type: row.item_type,
    prompt: row.prompt,
    options: row.item_type === "mcq" ? (optionsByItem.get(row.id) ?? []) : null,
    citation: {
      chunkId: row.material_chunk_id,
      materialId: row.material_id,
      materialTitle: row.material_title,
      pageNumber: row.page_number,
      sectionTitle: row.section_title,
    },
  }));
}

/**
 * `ready -> in_progress`: sets `started_at`/`expires_at` atomically, guarded by the session still
 * being `ready` so a double `start` call (or one racing a duplicate request) cannot restart the
 * clock. Returns null when the guard fails to update any row -- the caller re-reads the session to
 * report the right reason (not found vs. wrong status).
 */
export async function startExamSession(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string },
): Promise<{ startedAt: Date; expiresAt: Date } | null> {
  // duration_minutes is read from the row itself (set once, at creation) rather than passed in, so
  // there is no separate read-then-write gap between learning the duration and applying it.
  const [row] = await tx<{ started_at: Date; expires_at: Date }[]>`
    UPDATE app.exam_sessions
    SET status = 'in_progress',
        started_at = clock_timestamp(),
        expires_at = clock_timestamp() + make_interval(mins => duration_minutes)
    WHERE id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
      AND status = 'ready'
    RETURNING started_at, expires_at
  `;
  return row ? { startedAt: row.started_at, expiresAt: row.expires_at } : null;
}

export interface GradableExamItemRow {
  id: string;
  order: number;
  type: ExamItemType;
  correctOptionId: string | null;
  correctAnswer: string | null;
}

/** Load a session's items WITH the answer key -- only the submit path calls this. */
export async function loadExamItemsForGrading(
  tx: TransactionSql,
  input: { examSessionId: string; schoolId: string },
): Promise<GradableExamItemRow[]> {
  const rows = await tx<
    {
      id: string;
      item_order: number;
      item_type: ExamItemType;
      correct_option_id: string | null;
      correct_answer: string | null;
    }[]
  >`
    SELECT id, item_order, item_type, correct_option_id, correct_answer
    FROM app.exam_items
    WHERE exam_session_id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
    ORDER BY item_order ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    order: row.item_order,
    type: row.item_type,
    correctOptionId: row.correct_option_id,
    correctAnswer: row.correct_answer,
  }));
}

export interface PersistExamAnswerInput {
  itemId: string;
  submittedAnswer: string | null;
  isCorrect: boolean;
}

/**
 * `in_progress -> submitted`: persists one `exam_item_answers` row per item, then flips the session,
 * atomically. Guarded by `status = 'in_progress'` so a double `submit` call cannot re-score (the
 * route checks status and expiry before calling this, but the guard is repeated here as the last
 * word, the same defense-in-depth `persistExamItemsAndMarkReady`'s worker-side guard takes).
 */
export async function submitExamAnswers(
  tx: TransactionSql,
  input: {
    examSessionId: string;
    schoolId: string;
    answers: readonly PersistExamAnswerInput[];
    correctCount: number;
  },
): Promise<boolean> {
  for (const answer of input.answers) {
    await tx`
      INSERT INTO app.exam_item_answers (school_id, exam_item_id, submitted_answer, is_correct)
      VALUES (
        ${input.schoolId}::uuid, ${answer.itemId}::uuid, ${answer.submittedAnswer},
        ${answer.isCorrect}
      )
    `;
  }

  const [row] = await tx<{ id: string }[]>`
    UPDATE app.exam_sessions
    SET status = 'submitted', submitted_at = clock_timestamp(), correct_count = ${input.correctCount}
    WHERE id = ${input.examSessionId}::uuid AND school_id = ${input.schoolId}::uuid
      AND status = 'in_progress'
    RETURNING id
  `;
  return row !== undefined;
}
