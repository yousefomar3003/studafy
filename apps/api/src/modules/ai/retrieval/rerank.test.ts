/**
 * ST-163 cross-encoder re-ranker — unit tests.
 *
 * These pin the deterministic scorer's contract (joint query/passage scoring) and the pipeline's
 * arithmetic (`rerankHits`: score the fused top-20, order by joint score with the fusion score as
 * tie-break, cut to 6). The quality claim — that this ordering beats RRF alone on judged queries — is
 * the golden-set eval in `rerank.eval.test.ts`, not an assertion one fixture can carry.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  createDeterministicCrossEncoderReranker,
  queryCoverage,
  RERANK_CANDIDATE_POOL,
  RERANK_K,
  RERANK_MODEL,
  rerankHits,
} from "./rerank";

import type { CrossEncoderReranker, Rerankable } from "./rerank";

function hit(chunkId: string, content: string, rrfScore: number): Rerankable {
  return { chunkId, content, rrfScore };
}

const query = "photosynthesis light energy chloroplast";

describe("queryCoverage", () => {
  test("scores a full query match 1 and a partial match its fraction", () => {
    expect(queryCoverage(query, "Photosynthesis converts light energy inside a chloroplast.")).toBe(
      1,
    );
    expect(queryCoverage(query, "Light is absorbed by plant leaves for growth.")).toBe(1 / 4);
    expect(queryCoverage(query, "Cells store energy in adenosine triphosphate molecules.")).toBe(
      1 / 4,
    );
  });

  test("scores an unrelated chunk 0", () => {
    expect(queryCoverage(query, "Zirconium metallurgical alloys resist corrosion.")).toBe(0);
  });

  test("is case- and punctuation-insensitive, like the FTS leg's tokenizer", () => {
    expect(queryCoverage("newton force", "Newton's second law: force equals mass.")).toBe(1);
  });

  test("is not stem-aware: a plural chunk does not satisfy a singular query token", () => {
    expect(queryCoverage("chloroplast", "Chloroplasts are green.")).toBe(0);
  });

  test("scores 0 for a query with no tokens", () => {
    expect(queryCoverage("??", "anything at all")).toBe(0);
  });
});

describe("rerankHits", () => {
  test("promotes the full-coverage chunk above an RRF-top partial match", async () => {
    const reranker = createDeterministicCrossEncoderReranker();
    const hits = [
      hit("d1", "Chloroplast pigments absorb light across the visible spectrum.", 0.054),
      hit("d2", "Plant leaves capture light for growth in summer months.", 0.052),
      hit(
        "r1",
        "Photosynthesis converts light energy into chemical energy inside a chloroplast.",
        0.05,
      ),
      hit("d3", "Chemical energy in cells is stored in adenosine triphosphate molecules.", 0.048),
    ];

    const result = await rerankHits(query, hits, reranker);

    expect(result.hits.map((h) => h.chunkId)).toEqual(["r1", "d1", "d2", "d3"]);
    expect(result.scores.get("r1")).toBe(1);
    expect(result.model).toBe(RERANK_MODEL);
  });

  test("scores at most RERANK_CANDIDATE_POOL candidates", async () => {
    let seen = 0;
    const spy: CrossEncoderReranker = {
      model: RERANK_MODEL,
      async score(_q, candidates) {
        seen = candidates.length;
        return candidates.map((c) => ({ chunkId: c.chunkId, score: 0 }));
      },
    };
    const hits = Array.from({ length: RERANK_CANDIDATE_POOL + 5 }, (_, index) =>
      hit(`c${index}`, `unrelated text ${index}`, 1 / (index + 1)),
    );

    const result = await rerankHits("query", hits, spy);

    expect(seen).toBe(RERANK_CANDIDATE_POOL);
    expect(result.poolSize).toBe(RERANK_CANDIDATE_POOL);
  });

  test("cuts the re-scored pool to RERANK_K", async () => {
    const reranker = createDeterministicCrossEncoderReranker();
    const hits = Array.from({ length: 12 }, (_, index) =>
      hit(`c${index}`, `the query words appear in chunk ${index}`, 1 / (index + 1)),
    );

    const result = await rerankHits("query words", hits, reranker);

    expect(result.hits).toHaveLength(RERANK_K);
  });

  test("returns fewer hits when the pool is smaller than keep", async () => {
    const reranker = createDeterministicCrossEncoderReranker();
    const hits = [hit("c1", "query words here", 0.05), hit("c2", "unrelated", 0.04)];

    const result = await rerankHits("query words", hits, reranker);

    expect(result.hits).toHaveLength(2);
  });

  test("breaks equal joint scores by fusion score, RRF order intact", async () => {
    const reranker = createDeterministicCrossEncoderReranker();
    // Both cover the whole query, so the joint score ties at 1; the higher RRF score must win.
    const hits = [
      hit("lower", "exact query match ranking lower", 0.04),
      hit("higher", "exact query match ranking higher", 0.06),
    ];

    const result = await rerankHits("exact query match ranking", hits, reranker);

    expect(result.hits.map((h) => h.chunkId)).toEqual(["higher", "lower"]);
  });

  test("returns nothing unchanged for an empty candidate pool", async () => {
    const reranker = createDeterministicCrossEncoderReranker();

    const result = await rerankHits("query", [], reranker);

    expect(result.hits).toEqual([]);
    expect(result.scores.size).toBe(0);
    expect(result.model).toBe(RERANK_MODEL);
  });

  test("honours an explicit keep smaller than the default", async () => {
    const reranker = createDeterministicCrossEncoderReranker();
    const hits = Array.from({ length: 10 }, (_, index) =>
      hit(`c${index}`, `query match ${index}`, 1 / (index + 1)),
    );

    const result = await rerankHits("query", hits, reranker, { keep: 2 });

    expect(result.hits).toHaveLength(2);
  });
});
