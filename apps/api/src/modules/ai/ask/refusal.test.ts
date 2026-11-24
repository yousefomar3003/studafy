// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { AI_ASK_MIN_SEMANTIC_SIMILARITY } from "../config";
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
    semanticSimilarity: 0.7,
    ...overrides,
  };
}

/** What the best hit of a lexical-only pass looks like: keyword rank 1, no semantic leg. */
const lexicalBest = hit({
  semanticRank: null,
  semanticSimilarity: null,
  keywordRank: 1,
  rrfScore: 1 / (HYBRID_RRF_K + 1),
});

/** A hit the semantic leg alone found: the question's words are not in it. */
function semanticOnly(similarity: number): HybridSearchHit {
  return hit({
    keywordRank: null,
    semanticSimilarity: similarity,
    rrfScore: 1 / (HYBRID_RRF_K + 1),
  });
}

describe("assessGrounding", () => {
  test("a keyword-matched hit is grounded in both modes", () => {
    expect(assessGrounding([lexicalBest], "lexical")).toEqual({ grounded: true, topics: [] });
    expect(assessGrounding([lexicalBest], "hybrid").grounded).toBe(true);
  });

  test("hybrid: a question asked in other words is grounded by a close enough meaning match", () => {
    expect(assessGrounding([semanticOnly(AI_ASK_MIN_SEMANTIC_SIMILARITY)], "hybrid").grounded).toBe(
      true,
    );
    expect(assessGrounding([semanticOnly(0.74)], "hybrid").grounded).toBe(true);
  });

  test("hybrid: an unrelated question is refused, with the nearest topics offered", () => {
    const verdict = assessGrounding(
      [semanticOnly(AI_ASK_MIN_SEMANTIC_SIMILARITY - 0.01)],
      "hybrid",
    );
    expect(verdict.grounded).toBe(false);
    expect(verdict.topics).toHaveLength(1);
  });

  test("lexical: similarity is never trusted, since no real embedding ran", () => {
    expect(assessGrounding([semanticOnly(0.9)], "lexical").grounded).toBe(false);
  });

  test("hybrid: any keyword-matched hit grounds the question, not only the first", () => {
    expect(assessGrounding([semanticOnly(0.3), lexicalBest], "hybrid").grounded).toBe(true);
  });

  test("both modes refuse with no hits and offer no topics", () => {
    expect(assessGrounding([], "lexical")).toEqual({ grounded: false, topics: [] });
    expect(assessGrounding([], "hybrid")).toEqual({ grounded: false, topics: [] });
  });
});
