import { z } from "zod";

/**
 * Flashcard card schema (ST-168).
 *
 * This is the one schema three things share: what the prompt asks the model to produce, what
 * `flashcards/parser.ts` validates the model's JSON response against before anything is persisted,
 * and what `docs/rag/flashcards-and-spaced-repetition.md` (the "Flashcard schema doc" deliverable)
 * documents. A card that does not satisfy this schema is never stored and never reaches a client --
 * the deck-generation counterpart of the quiz acceptance criterion "questions validate against
 * schema".
 *
 * Two card types, discriminated on `type`:
 *   - `term_definition`: a term on the front, its definition on the back.
 *   - `q_a`: a question on the front, its answer on the back.
 *
 * `source_id` is the card's citation: the 1-based position of the source block (`flashcards/prompt.ts`,
 * the same numbering `quiz/prompt.ts`, `ask/prompt.ts`, and `summary/prompt.ts` use) the model
 * grounded the card on. It is validated against the actual source count by `flashcards/parser.ts`,
 * not by this schema, because this schema has no way to know how many sources a given request had.
 */

export const FLASHCARD_TYPES = ["term_definition", "q_a"] as const;
export type FlashcardType = (typeof FLASHCARD_TYPES)[number];

const nonEmptyTrimmed = z.string().trim().min(1);

export const flashcardGeneratedCardSchema = z
  .object({
    type: z.enum(FLASHCARD_TYPES),
    /** The term or question the student is prompted with. */
    front: nonEmptyTrimmed.max(500),
    /** The definition or answer the student flips to. */
    back: nonEmptyTrimmed.max(1000),
    source_id: z.number().int().min(1),
  })
  .strict();

/** The full shape the model must return: a non-empty JSON array of cards, nothing else. */
export const flashcardGenerationSchema = z.array(flashcardGeneratedCardSchema).min(1);
export type FlashcardGeneration = z.infer<typeof flashcardGenerationSchema>;
