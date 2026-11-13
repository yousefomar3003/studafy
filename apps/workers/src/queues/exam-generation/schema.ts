import { z } from "zod";

/**
 * Exam item schema (ST-171).
 *
 * Deliberately identical in shape to `apps/api/src/modules/ai/quiz/schema.ts` — the item-bank
 * validator ST-171 asks for is the same three-layer pattern quiz generation already established
 * (Zod here, `source_id` bounds-checking in `parser.ts`, the mcq/short_answer CHECK constraint in
 * migration `000102`) — reimplemented locally rather than imported because `apps/workers` cannot
 * depend on `apps/api/src` across the process boundary. See `docs/rag/exam-mode.md`.
 *
 * Two item types, discriminated on `type`:
 *   - `mcq`: 2-6 options, each with a distinct id and distinct (case-insensitive) text, and a
 *     `correct_option_id` naming one of them.
 *   - `short_answer`: a single non-empty `correct_answer`, graded by normalized string equality
 *     (`grading.ts`) — deterministic, not semantic.
 *
 * `source_id` is the item's citation: the 1-based position of the source block (`prompt.ts`) the
 * model grounded the item on. Bounds-checked against the real source count by `parser.ts`, not
 * here, because this schema has no way to know how many sources a given request had.
 */

export const EXAM_ITEM_TYPES = ["mcq", "short_answer"] as const;
export type ExamItemType = (typeof EXAM_ITEM_TYPES)[number];

const MIN_MCQ_OPTIONS = 2;
const MAX_MCQ_OPTIONS = 6;

const nonEmptyTrimmed = z.string().trim().min(1);

export const examOptionSchema = z.object({
  /** Short label the model and the student both reference, e.g. "A". Unique within an item. */
  id: nonEmptyTrimmed.max(8),
  text: nonEmptyTrimmed.max(500),
});
export type ExamOption = z.infer<typeof examOptionSchema>;

const examMcqItemSchema = z
  .object({
    type: z.literal("mcq"),
    prompt: nonEmptyTrimmed.max(1000),
    source_id: z.number().int().min(1),
    options: z.array(examOptionSchema).min(MIN_MCQ_OPTIONS).max(MAX_MCQ_OPTIONS),
    correct_option_id: nonEmptyTrimmed.max(8),
  })
  .strict()
  .superRefine((item, ctx) => {
    const ids = item.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "option ids must be unique within an item",
      });
    }

    const labels = item.options.map((option) => option.text.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "option text must be unique within an item",
      });
    }

    if (!ids.includes(item.correct_option_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["correct_option_id"],
        message: "correct_option_id must name one of the item's options",
      });
    }
  });

const examShortAnswerItemSchema = z
  .object({
    type: z.literal("short_answer"),
    prompt: nonEmptyTrimmed.max(1000),
    source_id: z.number().int().min(1),
    correct_answer: nonEmptyTrimmed.max(300),
  })
  .strict();

export const examGeneratedItemSchema = z.discriminatedUnion("type", [
  examMcqItemSchema,
  examShortAnswerItemSchema,
]);
export type ExamGeneratedItem = z.infer<typeof examGeneratedItemSchema>;

/** The full shape the model must return: a non-empty JSON array of items, nothing else. */
export const examGenerationSchema = z.array(examGeneratedItemSchema).min(1);
export type ExamGeneration = z.infer<typeof examGenerationSchema>;
