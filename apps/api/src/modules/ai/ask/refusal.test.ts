// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { AI_ASK_MIN_RELEVANCE_SCORE } from "../config";
import { HYBRID_RRF_K } from "../retrieval/search";

import { assessGrounding } from "./refusal";

import type { HybridSearchHit } from "../retrieval/search";

function hit(overrides: Partial<HybridSearchHit> = {}): HybridSearchHit {
  return {
    chunkId: "00000000-0000-4000-8000-000000000001",
    materialId: "00000000-0000-4000-8000-000000000100",
    materialTitle: "Biology 101",
    pageNumber: 1,
    sectionTitle: "Photosynthesis",
    content: "Photosynthesis converts light energy into chemical energy.",
    rrfScore: 2 / (HYBRID_RRF_K + 1),
    semanticRank: 1,
    keywordRank: 1,
    ...overrides,
  };
}

/** What the best hit of a lexical-only pass looks like: keyword rank 1, no semantic rank. */
const lexicalBest = hit({ semanticRank: null, keywordRank: 1, rrfScore: 1 / (HYBRID_RRF_K + 1) });

describe("assessGrounding", () => {
  test("the hybrid floor is unreachable by one leg — the reason lexical mode drops it (ADR-020)", () => {
    expect(1 / (HYBRID_RRF_K + 1)).toBeLessThan(AI_ASK_MIN_RELEVANCE_SCORE);
  });

  test("hybrid: answers when the best hit clears the floor and matched the keyword leg", () => {
    expect(assessGrounding([hit()], "hybrid").grounded).toBe(true);
  });

  test("hybrid (the default): a keyword-only best hit is refused on the score floor", () => {
    expect(assessGrounding([lexicalBest]).grounded).toBe(false);
  });

  test("lexical: a keyword-matched best hit is grounded despite its single-leg score", () => {
    const verdict = assessGrounding([lexicalBest], "lexical");
    expect(verdict.grounded).toBe(true);
    expect(verdict.topics).toEqual([]);
  });

  test("both modes refuse when the best hit missed the keyword leg", () => {
    const semanticOnly = hit({ keywordRank: null, rrfScore: 0.05 });
    expect(assessGrounding([semanticOnly], "hybrid").grounded).toBe(false);
    expect(assessGrounding([semanticOnly], "lexical").grounded).toBe(false);
  });

  test("both modes refuse with no hits and offer no topics", () => {
    expect(assessGrounding([], "lexical")).toEqual({ grounded: false, topics: [] });
    expect(assessGrounding([], "hybrid")).toEqual({ grounded: false, topics: [] });
  });
});
