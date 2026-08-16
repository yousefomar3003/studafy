// The ST-164 acceptance criterion: a config test pins the routing table, so a future model migration
// changes the defaults in exactly one place and this file proves the table still covers every surface.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  AI_FEATURES,
  AI_LLM_MODEL_CATALOG,
  AI_MODEL_TIERS,
  AI_ROUTING_TABLE,
  resolveAiModel,
} from "./routing";

import type { AiFeature, AiModelTier } from "./routing";

describe("AI model routing table", () => {
  test("every feature maps to exactly one of the two tiers", () => {
    for (const feature of Object.keys(AI_ROUTING_TABLE)) {
      const tier = AI_ROUTING_TABLE[feature as AiFeature];
      expect(AI_MODEL_TIERS).toContain(tier);
    }
    // And the table is exhaustive over the request body's feature enum.
    expect(Object.keys(AI_ROUTING_TABLE).sort()).toEqual([...AI_FEATURES].sort());
  });

  test("ask, exam, quiz, and explain route to the large tier; summary, concepts, and flashcards to the small tier", () => {
    expect(AI_ROUTING_TABLE.ask).toBe("large");
    expect(AI_ROUTING_TABLE.exam).toBe("large");
    expect(AI_ROUTING_TABLE.quiz).toBe("large");
    expect(AI_ROUTING_TABLE.explain).toBe("large");
    expect(AI_ROUTING_TABLE.summary).toBe("small");
    expect(AI_ROUTING_TABLE.concepts).toBe("small");
    expect(AI_ROUTING_TABLE.flashcards).toBe("small");
  });

  test("both tiers name a real model id", () => {
    for (const tier of AI_MODEL_TIERS) {
      expect(AI_LLM_MODEL_CATALOG[tier].defaultModel).toMatch(/^claude-[a-z0-9-]+$/);
    }
  });

  test("resolveAiModel returns the tier default without overrides", () => {
    const route = resolveAiModel("summary");
    expect(route).toEqual({
      feature: "summary",
      tier: "small",
      model: AI_LLM_MODEL_CATALOG.small.defaultModel,
    });
  });

  test("resolveAiModel applies an environment override per tier", () => {
    const overrides: Partial<Record<AiModelTier, string>> = {
      small: "claude-small-custom",
      large: "claude-large-custom",
    };
    expect(resolveAiModel("summary", overrides).model).toBe("claude-small-custom");
    expect(resolveAiModel("ask", overrides).model).toBe("claude-large-custom");
    // A partial override leaves the untouched tier on its default.
    expect(resolveAiModel("ask", { large: "claude-large-custom" }).model).toBe(
      "claude-large-custom",
    );
    expect(resolveAiModel("summary", { large: "claude-large-custom" }).model).toBe(
      AI_LLM_MODEL_CATALOG.small.defaultModel,
    );
  });

  test("the tier is a property of the feature, not the request", () => {
    // No per-request escape hatch: a client cannot ask for the expensive model on a cheap surface.
    for (const feature of AI_FEATURES) {
      expect(resolveAiModel(feature).tier).toBe(AI_ROUTING_TABLE[feature]);
    }
  });
});
