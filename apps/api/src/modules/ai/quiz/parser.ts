import { quizGenerationSchema } from "./schema";

import type { QuizGeneration } from "./schema";

/**
 * Parse and validate the model's raw quiz-generation response (ST-167).
 *
 * The provider (`llm/provider.ts`) has no JSON mode or tool-use support -- `generate()` returns
 * plain text -- so the model's compliance with the schema the prompt asked for is never guaranteed.
 * This is the enforcement point: a response that is not valid JSON, does not match
 * `quiz/schema.ts` (malformed options, a duplicate option id, a `correct_option_id` that does not
 * name a real option, and so on), or cites a `source_id` outside the sources it was actually given,
 * is rejected here as a {@link QuizGenerationInvalidError} rather than persisted or returned. The
 * caller (routes/quiz-routes.ts) maps that to a distinct 503 and does not retry server-side -- see
 * config.ts for why a repair retry was deliberately not added.
 */
export class QuizGenerationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizGenerationInvalidError";
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
 *   same bound `ask/citations.ts` applies to `[N]` answer citations.
 */
export function parseQuizGeneration(raw: string, sourceCount: number): QuizGeneration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new QuizGenerationInvalidError("quiz generation response was not valid JSON");
  }

  const result = quizGenerationSchema.safeParse(parsed);
  if (!result.success) {
    throw new QuizGenerationInvalidError(
      `quiz generation response failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const outOfRange = result.data.find((question) => question.source_id > sourceCount);
  if (outOfRange) {
    throw new QuizGenerationInvalidError(
      `quiz question cited source_id ${outOfRange.source_id}, but only ${sourceCount} source(s) ` +
        "were provided",
    );
  }

  return result.data;
}
