/**
 * Unwrap a JSON list the model returned inside a one-key object.
 *
 * Every JSON-producing surface (concepts, flashcards, quiz) asks for a top-level array. Providers
 * that enforce JSON output (`LlmGenerateInput.json` on an OpenAI-compatible host) only allow an
 * object at the top level, so the model is asked to wrap the array as `{"items": [...]}`
 * (`JSON_MODE_ENVELOPE` in ./openai-compatible.ts) and may pick a key of its own. An object with
 * exactly one property whose value is an array is read as that array; anything else is returned
 * unchanged for the schema to judge.
 */
export function unwrapJsonList(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const values = Object.values(parsed);
  return values.length === 1 && Array.isArray(values[0]) ? values[0] : parsed;
}
