/**
 * The third-party AI data-sharing disclosure (ST-305): who receives a user's AI inputs and what
 * those inputs are. The single source of truth for both the consent modal (served verbatim by
 * GET /api/ai/consent) and the consent record (snapshotted onto every grant row).
 *
 * Every category below is something a model-calling /api/ai/* route really sends to the provider
 * (see llm/provider.ts and the per-feature prompt assemblers):
 *   - questions:          text the user types -- Ask AI questions and /generate prompts.
 *   - study_materials:    extracted text of the materials a feature is run on (summaries, key
 *                         concepts, explanations, quizzes, flashcards, exams), plus the title for
 *                         summaries. This can include names or other personal details written in
 *                         the material.
 *   - account_identifier: the user's opaque Studafy user id, sent as the provider's abuse-monitoring
 *                         `metadata.user_id` unless the deployment runs zero-retention. Never a name
 *                         or email.
 *
 * Changing the provider or the categories changes what a user agreed to, so it MUST bump `version`:
 * the gate only honours a consent granted against the current version, which re-prompts everyone.
 */
export const AI_DATA_CATEGORIES = ["questions", "study_materials", "account_identifier"] as const;
export type AiDataCategory = (typeof AI_DATA_CATEGORIES)[number];

export const AI_DATA_SHARING_DISCLOSURE = {
  version: "2026-09-28",
  provider: {
    id: "anthropic",
    name: "Anthropic",
    privacyPolicyUrl: "https://www.anthropic.com/legal/privacy",
  },
  dataCategories: AI_DATA_CATEGORIES,
} as const;

/**
 * Route suffixes under /api/ai/students/{studentId}/ whose handler sends user data to the model
 * provider (exam create enqueues the worker that does). The consent gate refuses these without a
 * live consent; app.ts also sizes their quota hold from this list.
 */
const AI_MODEL_CALL_PATH_SUFFIXES = [
  "/generate",
  "/ask",
  "/summarize",
  "/concepts",
  "/explain",
  "/quizzes",
  "/decks",
  "/exams",
] as const;

export function isAiModelCallPath(path: string): boolean {
  return AI_MODEL_CALL_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix));
}
