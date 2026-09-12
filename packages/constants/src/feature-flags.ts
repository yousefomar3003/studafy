/**
 * Typed feature-flag registry.
 *
 * The single source of truth for which flags exist across the platform. `FlagName` is derived
 * from the registry keys, so an unknown flag fails `tsc --noEmit` at the call site — there is no
 * stringly-typed path into `createFlagsService.get()`.
 *
 * A flag's `defaultValue` is its in-code fallback: what the platform runs while no environment
 * variable and no per-tenant override says otherwise. The API service layers a deployment's env
 * defaults on top at bootstrap (`createFlagsService({ defaults })` in
 * apps/api/src/modules/flags/service.ts) and the database's per-tenant overrides
 * (app.feature_flags, migration 000109) on top of that — see
 * docs/database/feature-flags-data-model.md for the full precedence.
 *
 * Flags here are intentional product/operations state, evaluated per request. They are not
 * static, never-flipping toggles: a flag that will never move belongs in a constant, not here.
 */

export interface FeatureFlagDefinition {
  /** Why the flag exists and what flipping it changes. Sentences, not a slogan. */
  description: string;
  /** The fallback value when no env default and no per-tenant override is set. */
  defaultValue: boolean;
}

export const FEATURE_FLAGS = {
  /**
   * The LLM gateway (ST-164) and every synchronous AI surface that calls a model — generate,
   * ask, summarize, concepts, explain, quiz generation, flashcard generation. Off means the
   * routes still register and answer 503 AI_LLM_DISABLED. Its env default is
   * `AI_LLM_ENABLED`; a per-tenant `feature_flags` row can kill it for one school in under
   * the flag cache TTL without a deploy.
   */
  "ai.llm": {
    description:
      "Kill switch for the LLM gateway and all model-calling AI surfaces. Off answers 503 AI_LLM_DISABLED.",
    defaultValue: false,
  },
  /**
   * The cross-encoder re-ranking stage (ST-163) in hybrid retrieval. Off returns the raw RRF
   * ranking with no joint re-scoring. Its env default is `AI_RERANK_ENABLED`.
   */
  "ai.rerank": {
    description:
      "Cross-encoder re-ranking stage in hybrid retrieval. Off returns the fused RRF ranking untouched.",
    defaultValue: false,
  },
} as const satisfies Readonly<Record<string, FeatureFlagDefinition>>;

export type FlagName = keyof typeof FEATURE_FLAGS;

/**
 * The registry's default for one flag. Always the fallback: the API service's env layer and any
 * per-tenant override both outrank it (see docs/database/feature-flags-data-model.md).
 */
export function flagDefault(name: FlagName): boolean {
  return FEATURE_FLAGS[name].defaultValue;
}
