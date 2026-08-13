import { AI_LLM_DEFAULT_LARGE_MODEL, AI_LLM_DEFAULT_SMALL_MODEL } from "../config";

/**
 * Model routing for the LLM gateway (ST-164).
 *
 * The routing table maps each AI surface to a model tier. Tier is the abstraction, model is the
 * implementation: the defaults below are the model ids at the time ST-164 shipped, and a deployment
 * overrides them with `AI_LLM_SMALL_MODEL` / `AI_LLM_LARGE_MODEL` (see the provider runbook). The
 * route never names a model directly — it asks {@link resolveAiModel} and calls whatever id comes
 * back, so flipping a model is an env change, not a code change.
 *
 * The split is cost over capability: long-form, open-ended answers (Ask AI, exam explanations) get
 * the reasoning-heavy large tier; short, repetitive generation (summaries, flashcard lists) gets
 * the fast cheap small tier. One feature is always one tier — the route has no per-request escape
 * hatch, so a client cannot spend the school's budget on the expensive model for a cheap surface.
 */

/** The AI surfaces the gateway serves, and the request body's `feature` values. */
export const AI_FEATURES = ["ask", "exam", "summary", "flashcards", "quiz"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_MODEL_TIERS = ["small", "large"] as const;
export type AiModelTier = (typeof AI_MODEL_TIERS)[number];

export const AI_ROUTING_TABLE: Readonly<Record<AiFeature, AiModelTier>> = {
  ask: "large",
  exam: "large",
  summary: "small",
  flashcards: "small",
  // Quiz generation (ST-167) mixes question types across multiple materials and must keep every
  // question's citation and answer key internally consistent -- the same reasoning load as exam
  // explanations, not the short, repetitive shape summary/flashcards get.
  quiz: "large",
};

export interface AiModelTierConfig {
  /** The model id used when no environment override is set. */
  defaultModel: string;
  /** Why a surface lands on this tier — documented on the model-routing doc's table. */
  description: string;
}

export const AI_LLM_MODEL_CATALOG: Readonly<Record<AiModelTier, AiModelTierConfig>> = {
  small: {
    defaultModel: AI_LLM_DEFAULT_SMALL_MODEL,
    description: "Fast, cheap workhorse for short-form generation: summaries and flashcard lists.",
  },
  large: {
    defaultModel: AI_LLM_DEFAULT_LARGE_MODEL,
    description:
      "Strongest reasoning for open-ended answers: Ask AI, exam explanations, and quiz generation.",
  },
};

export interface AiModelRoute {
  feature: AiFeature;
  tier: AiModelTier;
  /** The model id to call, after the environment override is applied. */
  model: string;
}

/**
 * Resolve the model id for one surface. `overrides` come from the environment
 * (`AI_LLM_SMALL_MODEL` / `AI_LLM_LARGE_MODEL`); a partial map leaves the untouched tier on its
 * catalog default.
 */
export function resolveAiModel(
  feature: AiFeature,
  overrides: Partial<Record<AiModelTier, string>> = {},
): AiModelRoute {
  const tier = AI_ROUTING_TABLE[feature];
  return {
    feature,
    tier,
    model: overrides[tier] ?? AI_LLM_MODEL_CATALOG[tier].defaultModel,
  };
}
