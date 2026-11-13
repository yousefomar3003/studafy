/**
 * Cross-encoder re-ranking (ST-163): the second retrieval stage over the fused top-N from ST-162.
 *
 * Reciprocal Rank Fusion fuses *ranks*; it never re-scores — `docs/rag/hybrid-search-and-rag-storage.md`
 * names exactly that as the known gap this module closes. A cross-encoder scores a query and a passage
 * *jointly* (the two are concatenated into one scoring pass) rather than embedding each independently
 * like the retrieval bi-encoder, which is why a cross-encoder is the standard re-ranker on top of a
 * cheap first stage.
 *
 * The repository declares no ML runtime, so — exactly like `QueryEmbedder` in `embeddings.ts` and the
 * ingestion worker's `mockEmbedding` — the default here is an honest deterministic scorer under a
 * stable model id (`RERANK_MODEL`). It computes the joint (query, passage) score as the fraction of the
 * query's tokens the chunk contains: the lexical analogue of what a real cross-encoder's attention does
 * for a short query. A real model (e.g. `cross-encoder/ms-marco-MiniLM-L-12-v2` over ONNX, or an HTTP
 * endpoint) is a one-function swap behind the same {@link CrossEncoderReranker} contract, and
 * {@link rerankHits} is the whole surface the retrieval route depends on — the mirror of the
 * "one-function swap" pattern `embeddings.ts` established for the query embedder.
 *
 * `rerankHits` scores at most `RERANK_CANDIDATE_POOL` fused candidates (the retrieval route's max fused
 * limit, so the route asks the first stage for a full top-20 before this stage cuts) and returns the
 * top `RERANK_K`. Candidates that tie on the joint score keep their fusion order (the sort's second
 * key is `rrfScore` descending), so RRF remains the tie-break rather than being discarded.
 */

import { HYBRID_MAX_LIMIT } from "./search";

/** How many fused candidates the re-ranker scores: the route's max fused limit, unchanged. */
export const RERANK_CANDIDATE_POOL = HYBRID_MAX_LIMIT;

/** How many re-ranked hits the route returns. */
export const RERANK_K = 6;

/** The deterministic scorer's model id. A real cross-encoder reports its own model id here. */
export const RERANK_MODEL = "mock-cross-encoder@1";

/** The part of a retrieval hit the re-ranker reads: identity, text, and the fusion score. */
export interface Rerankable {
  chunkId: string;
  content: string;
  rrfScore: number;
}

/** One (query, chunk) pair handed to a cross-encoder for a joint score. */
export interface RerankCandidate {
  chunkId: string;
  content: string;
}

/** One cross-encoder score, parallel to the candidate list it was scored from. */
export interface RerankScore {
  chunkId: string;
  score: number;
}

/**
 * The re-ranker contract. {@link score} is the joint scoring primitive; ordering and cutting are
 * `rerankHits`' job, so a real cross-encoder only has to know how to score a pair.
 */
export interface CrossEncoderReranker {
  /** The model id that produced these scores. */
  readonly model: string;
  /** Score each candidate jointly against the query. One {@link RerankScore} per candidate, in order. */
  score(query: string, candidates: readonly RerankCandidate[]): Promise<RerankScore[]>;
}

export interface RerankHitsOptions {
  /** How many fused candidates to score. Defaults to `RERANK_CANDIDATE_POOL`. */
  candidates?: number;
  /** How many re-ranked hits to return. Defaults to `RERANK_K`. */
  keep?: number;
}

export interface RerankHitsResult<T extends Rerankable> {
  /** The surviving hits, re-ranked by joint score then fusion score. */
  hits: T[];
  /** The model id that scored these hits. */
  model: string;
  /** The joint score of every hit returned, keyed by chunk id. */
  scores: ReadonlyMap<string, number>;
  /** How many candidates were actually scored (≤ `candidates`). */
  poolSize: number;
}

/** Lowercase alphanumeric tokens; the same shape the FTS leg's `english` config approximates. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * The deterministic joint score: the fraction of the query's distinct tokens present in the chunk.
 *
 * This is the honest stand-in for a real cross-encoder — same input (a query and a passage together),
 * same output (a 0..1 relevance score), no learned parameters. The golden-set eval
 * (`rerank.eval.test.ts`) is the acceptance evidence that this score, as fused with RRF, lifts nDCG
 * over RRF alone on the same candidate pools. Known limitation, stated plainly: it is exact-token
 * match, not stem-aware, so "resisted" does not match "resistance".
 */
export function queryCoverage(query: string, chunk: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const chunkTokens = new Set(tokenize(chunk));
  const matched = queryTokens.filter((token) => chunkTokens.has(token)).length;
  return matched / queryTokens.length;
}

/**
 * The repository's default re-ranker: a deterministic scorer under `RERANK_MODEL`. The single
 * construction site is `app.ts`, gated on the `AI_RERANK_ENABLED` kill switch — the same shape as
 * `createDeterministicQueryEmbedder()`.
 */
export function createDeterministicCrossEncoderReranker(): CrossEncoderReranker {
  return {
    model: RERANK_MODEL,
    async score(query, candidates) {
      return candidates.map(({ chunkId, content }) => ({
        chunkId,
        score: queryCoverage(query, content),
      }));
    },
  };
}

/**
 * Re-rank the fused top-N and cut to top-k: score the pool, order by joint score with the fusion score
 * as tie-break, and return the top `keep`. When `hits` is empty nothing is scored.
 */
export async function rerankHits<T extends Rerankable>(
  query: string,
  hits: readonly T[],
  reranker: CrossEncoderReranker,
  options: RerankHitsOptions = {},
): Promise<RerankHitsResult<T>> {
  const candidates = options.candidates ?? RERANK_CANDIDATE_POOL;
  const keep = options.keep ?? RERANK_K;
  const pool = hits.slice(0, candidates);

  const scores = new Map<string, number>();
  if (pool.length > 0) {
    const scored = await reranker.score(
      query,
      pool.map(({ chunkId, content }) => ({ chunkId, content })),
    );
    for (const { chunkId, score } of scored) scores.set(chunkId, score);
  }

  const ranked = [...pool].sort((a, b) => {
    const byScore = (scores.get(b.chunkId) ?? 0) - (scores.get(a.chunkId) ?? 0);
    if (byScore !== 0) return byScore;
    return b.rrfScore - a.rrfScore;
  });

  return { hits: ranked.slice(0, keep), model: reranker.model, scores, poolSize: pool.length };
}
