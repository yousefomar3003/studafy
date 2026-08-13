import { z } from "zod";

/**
 * Quiz question schema (ST-167).
 *
 * This is the one schema three things share: what the prompt asks the model to produce, what
 * `quiz/parser.ts` validates the model's JSON response against before anything is persisted, and
 * what `docs/rag/quiz-generation-and-grading.md` (the "Quiz schema doc" deliverable) documents. A
 * question that does not satisfy this schema is never stored and never reaches a client -- that is
 * the acceptance criterion "questions validate against schema (no malformed options)".
 *
 * Two question types, discriminated on `type`:
 *   - `mcq`: 2-6 options, each with a distinct id and distinct (case-insensitive) text, and a
 *     `correct_option_id` that names one of them. An option set with a duplicate id, a duplicate
 *     label, or a correct id that does not resolve is malformed and fails validation here.
 *   - `short_answer`: a single non-empty `correct_answer`, graded by normalized string equality
 *     (`quiz/grading.ts`) -- deterministic, not semantic.
 *
 * `source_id` is the question's citation: the 1-based position of the source block (`quiz/prompt.ts`,
 * the same numbering `ask/prompt.ts` and `summary/prompt.ts` use) the model grounded the question on.
 * It is validated against the actual source count by `quiz/parser.ts`, not by this schema, because
 * this schema has no way to know how many sources a given request had.
 */

export const QUIZ_QUESTION_TYPES = ["mcq", "short_answer"] as const;
export type QuizQuestionType = (typeof QUIZ_QUESTION_TYPES)[number];

const MIN_MCQ_OPTIONS = 2;
const MAX_MCQ_OPTIONS = 6;

const nonEmptyTrimmed = z.string().trim().min(1);

export const quizOptionSchema = z.object({
  /** Short label the model and the student both reference, e.g. "A". Unique within a question. */
  id: nonEmptyTrimmed.max(8),
  text: nonEmptyTrimmed.max(500),
});
export type QuizOption = z.infer<typeof quizOptionSchema>;

const quizMcqQuestionSchema = z
  .object({
    type: z.literal("mcq"),
    prompt: nonEmptyTrimmed.max(1000),
    source_id: z.number().int().min(1),
    options: z.array(quizOptionSchema).min(MIN_MCQ_OPTIONS).max(MAX_MCQ_OPTIONS),
    correct_option_id: nonEmptyTrimmed.max(8),
  })
  .strict()
  .superRefine((question, ctx) => {
    const ids = question.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "option ids must be unique within a question",
      });
    }

    const labels = question.options.map((option) => option.text.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "option text must be unique within a question",
      });
    }

    if (!ids.includes(question.correct_option_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["correct_option_id"],
        message: "correct_option_id must name one of the question's options",
      });
    }
  });

const quizShortAnswerQuestionSchema = z
  .object({
    type: z.literal("short_answer"),
    prompt: nonEmptyTrimmed.max(1000),
    source_id: z.number().int().min(1),
    correct_answer: nonEmptyTrimmed.max(300),
  })
  .strict();

export const quizGeneratedQuestionSchema = z.discriminatedUnion("type", [
  quizMcqQuestionSchema,
  quizShortAnswerQuestionSchema,
]);
export type QuizGeneratedQuestion = z.infer<typeof quizGeneratedQuestionSchema>;

/** The full shape the model must return: a non-empty JSON array of questions, nothing else. */
export const quizGenerationSchema = z.array(quizGeneratedQuestionSchema).min(1);
export type QuizGeneration = z.infer<typeof quizGenerationSchema>;
