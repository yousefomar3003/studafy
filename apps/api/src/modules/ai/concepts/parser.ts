import { conceptGenerationSchema } from "./schema";

import type { ConceptGeneration } from "./schema";

/**
 * Parse and validate the model's raw concept-extraction response (ST-169).
 *
 * The provider (`llm/provider.ts`) has no JSON mode or tool-use support -- `generate()` returns
 * plain text -- so the model's compliance with the schema the prompt asked for is never guaranteed.
 * This is the enforcement point, on the same terms as `quiz/parser.ts` and
 * `flashcards/parser.ts`: a response that is not valid JSON, does not match
 * `concepts/schema.ts` (an empty name, a multi-line explanation, a concept with no sources, and so
 * on), or cites a `source_id` outside the sources it was actually given, is rejected here as a
 * {@link ConceptGenerationInvalidError} rather than returned. The caller
 * (routes/concepts-routes.ts) maps that to a distinct 503 and does not retry server-side, exactly
 * like quiz and flashcard generation.
 */
export class ConceptGenerationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptGenerationInvalidError";
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
export function parseConceptGeneration(raw: string, sourceCount: number): ConceptGeneration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ConceptGenerationInvalidError("concept generation response was not valid JSON");
  }

  const result = conceptGenerationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConceptGenerationInvalidError(
      `concept generation response failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const outOfRange = result.data.find((concept) =>
    concept.source_ids.some((id) => id > sourceCount),
  );
  if (outOfRange) {
    throw new ConceptGenerationInvalidError(
      `concept "${outOfRange.name}" cited source_id outside 1..${sourceCount}`,
    );
  }

  return result.data;
}
