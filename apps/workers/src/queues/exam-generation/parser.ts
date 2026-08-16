import { examGenerationSchema } from "./schema";

import type { ExamGeneration } from "./schema";

/**
 * Parse and validate the model's raw exam-generation response (ST-171).
 *
 * Mirrors `apps/api/src/modules/ai/quiz/parser.ts` exactly: the provider has no JSON mode or
 * tool-use, so the model's compliance with the schema the prompt asked for is never guaranteed.
 * This is the enforcement point — a response that is not valid JSON, does not match `schema.ts`, or
 * cites a `source_id` outside the sources it was actually given is rejected here as an
 * {@link ExamGenerationInvalidError} rather than persisted. The worker (`worker.ts`) treats this the
 * same way quiz generation's synchronous path treats a validation failure: no repair retry — see
 * `docs/rag/exam-mode.md`'s "Grounded item-bank validator" section for why.
 */
export class ExamGenerationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExamGenerationInvalidError";
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
 *   model invented (or copied from a different request) is caught as a hallucinated citation.
 */
export function parseExamGeneration(raw: string, sourceCount: number): ExamGeneration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ExamGenerationInvalidError("exam generation response was not valid JSON");
  }

  const result = examGenerationSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExamGenerationInvalidError(
      `exam generation response failed schema validation: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const outOfRange = result.data.find((item) => item.source_id > sourceCount);
  if (outOfRange) {
    throw new ExamGenerationInvalidError(
      `exam item cited source_id ${outOfRange.source_id}, but only ${sourceCount} source(s) ` +
        "were provided",
    );
  }

  return result.data;
}
