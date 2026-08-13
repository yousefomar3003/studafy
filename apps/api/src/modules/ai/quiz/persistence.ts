import type { QuizGeneratedQuestion, QuizOption, QuizQuestionType } from "./schema";
import type { GroundedSource } from "../ask/prompt";
import type { TransactionSql } from "postgres";

/**
 * Quiz persistence (ST-167).
 *
 * One row in `app.quizzes` per generation, one row in `app.quiz_questions` per question (plus one
 * row per MCQ choice in `app.quiz_question_options` -- normalized, not a jsonb array; see migration
 * 000099's header for why), each question carrying its citation (`material_chunk_id`, a composite
 * FK to `app.material_chunks`) and its answer key (`correct_option_id` or `correct_answer`,
 * mutually exclusive by `question_type` -- `ck_quiz_questions_shape` in migration 000099). The
 * insert runs in the caller's tenant transaction, so a half-written quiz can never land.
 *
 * The answer key is written here but never read back by {@link PersistedQuizQuestion} -- the
 * generation route's response is built from this return value and therefore cannot leak it. Only
 * `loadQuizForGrading` reads `correct_option_id` / `correct_answer`, and only the grading route calls
 * it.
 */

export interface PersistQuizInput {
  schoolId: string;
  studentId: string;
  model: string;
  /** Validated model output, in the order it will be numbered 1..N within the quiz. */
  questions: readonly QuizGeneratedQuestion[];
  /** The numbered sources the prompt was built from; `question.source_id` indexes into this (1-based). */
  sources: readonly GroundedSource[];
}

export interface PersistedQuestionCitation {
  chunkId: string;
  materialId: string;
  materialTitle: string | null;
  pageNumber: number | null;
  sectionTitle: string | null;
}

export interface PersistedQuizQuestion {
  id: string;
  /** The question's 1-based position within the quiz. */
  order: number;
  type: QuizQuestionType;
  prompt: string;
  /** Present for `mcq`, null for `short_answer`. Never carries which option is correct. */
  options: QuizOption[] | null;
  citation: PersistedQuestionCitation;
}

export interface PersistedQuiz {
  quizId: string;
  questions: PersistedQuizQuestion[];
}

export async function persistQuiz(
  tx: TransactionSql,
  input: PersistQuizInput,
): Promise<PersistedQuiz> {
  const [quiz] = await tx<{ id: string }[]>`
    INSERT INTO app.quizzes (school_id, student_id, model, question_count)
    VALUES (${input.schoolId}::uuid, ${input.studentId}::uuid, ${input.model}, ${input.questions.length})
    RETURNING id
  `;
  const quizId = quiz!.id;

  const questions: PersistedQuizQuestion[] = [];

  // Sequential insert, one question (and, for mcq, its options) at a time -- the same bounded-loop
  // shape ask/persistence.ts uses for citations, kept identical rather than reaching for postgres.js's
  // multi-row helper.
  for (const [index, question] of input.questions.entries()) {
    const order = index + 1;
    // Bounds-checked by quiz/parser.ts before this function is ever called: source_id is always in
    // [1, sources.length].
    const source = input.sources[question.source_id - 1]!;

    const options = question.type === "mcq" ? question.options : null;
    const correctOptionId = question.type === "mcq" ? question.correct_option_id : null;
    const correctAnswer = question.type === "short_answer" ? question.correct_answer : null;

    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.quiz_questions (
        school_id, quiz_id, question_order, question_type, prompt,
        correct_option_id, correct_answer, material_chunk_id
      ) VALUES (
        ${input.schoolId}::uuid,
        ${quizId}::uuid,
        ${order},
        ${question.type},
        ${question.prompt},
        ${correctOptionId},
        ${correctAnswer},
        ${source.chunkId}::uuid
      )
      RETURNING id
    `;
    const questionId = row!.id;

    if (options !== null) {
      for (const [optionIndex, option] of options.entries()) {
        await tx`
          INSERT INTO app.quiz_question_options (
            school_id, quiz_question_id, option_order, option_key, option_text
          ) VALUES (
            ${input.schoolId}::uuid,
            ${questionId}::uuid,
            ${optionIndex + 1},
            ${option.id},
            ${option.text}
          )
        `;
      }
    }

    questions.push({
      id: questionId,
      order,
      type: question.type,
      prompt: question.prompt,
      options,
      citation: {
        chunkId: source.chunkId,
        materialId: source.materialId,
        materialTitle: source.materialTitle,
        pageNumber: source.pageNumber,
        sectionTitle: source.sectionTitle,
      },
    });
  }

  return { quizId, questions };
}

// ---------------------------------------------------------------------------------------------------
// Grading read path
// ---------------------------------------------------------------------------------------------------

export interface QuizQuestionForGrading {
  id: string;
  order: number;
  type: QuizQuestionType;
  correctOptionId: string | null;
  correctAnswer: string | null;
  citation: PersistedQuestionCitation;
}

export interface LoadedQuizForGrading {
  quizId: string;
  questions: QuizQuestionForGrading[];
}

/**
 * Load a quiz and its full answer key for grading, scoped to the student who owns it.
 *
 * `student_id` is filtered explicitly, the same posture `ask/persistence.ts`'s
 * `resolveConversation` takes for `ai_conversations`: RLS already fences the school, but nothing
 * fences the student, so a quiz generated for a different student in the same school must still read
 * as absent here. Returns null when no such quiz exists for this student in this school -- the route
 * maps that to 404 `AI_QUIZ_NOT_FOUND`.
 *
 * Does not join `app.quiz_question_options`: grading compares a submitted answer against
 * `correct_option_id` / `correct_answer` directly (`quiz/grading.ts`) and never needs to re-render
 * the option list.
 */
export async function loadQuizForGrading(
  tx: TransactionSql,
  input: { quizId: string; studentId: string },
): Promise<LoadedQuizForGrading | null> {
  const [quiz] = await tx<{ id: string }[]>`
    SELECT id FROM app.quizzes
    WHERE id = ${input.quizId}::uuid AND student_id = ${input.studentId}::uuid
  `;
  if (!quiz) return null;

  const rows = await tx<
    {
      id: string;
      question_order: number;
      question_type: QuizQuestionType;
      correct_option_id: string | null;
      correct_answer: string | null;
      material_chunk_id: string;
      material_id: string;
      material_title: string | null;
      page_number: number | null;
      section_title: string | null;
    }[]
  >`
    SELECT
      qq.id, qq.question_order, qq.question_type,
      qq.correct_option_id, qq.correct_answer,
      qq.material_chunk_id, mc.material_id, m.title AS material_title,
      mc.page_number, mc.section_title
    FROM app.quiz_questions qq
    JOIN app.material_chunks mc ON mc.id = qq.material_chunk_id
    JOIN app.materials m ON m.id = mc.material_id
    WHERE qq.quiz_id = ${quiz.id}::uuid
    ORDER BY qq.question_order ASC
  `;

  return {
    quizId: quiz.id,
    questions: rows.map((row) => ({
      id: row.id,
      order: row.question_order,
      type: row.question_type,
      correctOptionId: row.correct_option_id,
      correctAnswer: row.correct_answer,
      citation: {
        chunkId: row.material_chunk_id,
        materialId: row.material_id,
        materialTitle: row.material_title,
        pageNumber: row.page_number,
        sectionTitle: row.section_title,
      },
    })),
  };
}
