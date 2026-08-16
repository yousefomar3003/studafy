import { flashcardGenerationSchema } from "./schema";

import type { FlashcardGeneration } from "./schema";

/**
 * Parse and validate the model's raw flashcard-deck response (ST-168).
 *
 * The provider (`llm/provider.ts`) has no JSON mode or tool-use support -- `generate()` returns
 * plain text -- so the model's compliance with the schema the prompt asked for is never guaranteed.
 * This is the enforcement point, on the same terms as `quiz/parser.ts`: a response that is not valid
 * JSON, does not match `flashcards/schema.ts` (a card with an empty face, a type other than
 * term_definition/q_a, and so on), or cites a `source_id` outside the sources it was actually given,
 * is rejected here as a {@link FlashcardGenerationInvalidError} rather than persisted or returned.
 * The caller (routes/flashcard-routes.ts) maps that to a distinct 503 and does not retry
 * server-side, exactly like quiz generation.
 */
export class FlashcardGenerationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlashcardGenerationInvalidError";
  }
}

/** Strip a ```json fenced block if the model wrapped its answer in one despite being told not to. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/**
 * @param sourceCount how many numbered sources the prompt actually offered, so a `source_id` the
 *   model invented (or copied from a different request) is caught as a hallucinated citation, the
 *   same bound `quiz/parser.ts` applies to quiz citations and `ask/citations.ts` to `[N]` answer
 *   citations.
 */
export function parseFlashcardGeneration(raw: string, sourceCount: number): FlashcardGeneration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new FlashcardGenerationInvalidError("flashcard generation response was not valid JSON");
  }

  const result = flashcardGenerationSchema.safeParse(parsed);
  if (!result.success) {
    throw new FlashcardGenerationInvalidError(
      `flashcard generation response failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const outOfRange = result.data.find((card) => card.source_id > sourceCount);
  if (outOfRange) {
    throw new FlashcardGenerationInvalidError(
      `flashcard cited source_id ${outOfRange.source_id}, but only ${sourceCount} source(s) ` +
        "were provided",
    );
  }

  return result.data;
}
