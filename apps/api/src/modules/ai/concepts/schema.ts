import { z } from "zod";

/**
 * Key-concept schema (ST-169).
 *
 * This is the one schema three things share: what the prompt asks the model to produce, what
 * `concepts/parser.ts` validates the model's JSON response against before anything is returned,
 * and what `docs/rag/concepts-extraction.md` documents. A concept that does not satisfy this
 * schema -- an empty name, a multi-line explanation, or an empty `source_ids` list -- is never
 * returned, the deck-generation counterpart of the quiz acceptance criterion "questions validate
 * against schema".
 *
 * `source_ids` is the concept's citation: the 1-based positions of the source blocks
 * (`concepts/prompt.ts`, the same numbering `ask/prompt.ts`, `summary/prompt.ts`, `quiz/prompt.ts`,
 * and `flashcards/prompt.ts` use) the concept is grounded on. It is validated against the actual
 * source count by `concepts/parser.ts`, and its names are validated against the corpus by
 * `concepts/grounding.ts`, neither of which this schema can do because it has no access to the
 * sources a given request had.
 */

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/.test(value), "must be a single line");

export const conceptGeneratedItemSchema = z
  .object({
    /** The key term the concept is named after, as it appears in the sources. */
    name: singleLine(120),
    /** A one-line, faithful explanation of the concept, grounded in the sources. */
    explanation: singleLine(300),
    /** Every source (1-based position in the prompt) that mentions this concept. */
    source_ids: z.array(z.number().int().min(1)).min(1),
  })
  .strict();

/** The full shape the model must return: a non-empty JSON array of concepts, nothing else. */
export const conceptGenerationSchema = z.array(conceptGeneratedItemSchema).min(1);
export type ConceptGeneration = z.infer<typeof conceptGenerationSchema>;
