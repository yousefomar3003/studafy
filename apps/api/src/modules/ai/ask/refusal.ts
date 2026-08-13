import { AI_ASK_MIN_RELEVANCE_SCORE } from "../config";

import type { HybridSearchHit } from "../retrieval/search";

/**
 * Grounding refusal for Ask AI (ST-165).
 *
 * The ask route refuses to answer when retrieval cannot establish that the student's question is
 * grounded in the school's own corpus, because answering from noise would make up an answer that
 * looks sourced. The verdict is deliberately conservative and AND-ed:
 *
 *   - the best hit's fused RRF score must clear {@link AI_ASK_MIN_RELEVANCE_SCORE}, AND
 *   - that same hit must have matched the keyword leg (`keywordRank !== null`).
 *
 * The keyword-leg arm is load-bearing, not a nicety. The semantic leg in this repository is a
 * deterministic mock embedder (see `retrieval/embeddings.ts`), so a semantic-only hit means only
 * the mock's cosine distance said "nearby" — which cannot carry a relevance verdict on its own.
 * The keyword leg is real PostgreSQL full-text search: a hit it found genuinely mentions the
 * question's words. Requiring both keeps a mock-embedding false positive from producing a
 * confident-looking answer.
 *
 * When the verdict refuses, the caller sends the refusal path's payload, which carries the nearest
 * topics the retrieval did find — the materials that were closest to the question, so the student
 * is handed a concrete next step instead of a dead end.
 */

/** How many distinct nearest topics the refusal payload carries. */
export const AI_ASK_REFUSAL_TOPIC_LIMIT = 5;

export interface NearestTopic {
  /** A real chunk that was nearest but below the grounding bar; its id anchors the topic. */
  chunkId: string;
  materialTitle: string | null;
  sectionTitle: string | null;
}

export interface GroundingVerdict {
  /** True when the route may answer from the retrieved sources. */
  grounded: boolean;
  /**
   * The nearest topics to offer the student when `grounded` is false. Always empty when the answer
   * is allowed, so a caller can treat "refused" as "topics populated" without a second look.
   */
  topics: NearestTopic[];
}

/** The distinct nearest materials in rank order — the refusal payload's "try one of these". */
export function nearestTopics(
  hits: readonly HybridSearchHit[],
  limit: number = AI_ASK_REFUSAL_TOPIC_LIMIT,
): NearestTopic[] {
  const seen = new Set<string>();
  const topics: NearestTopic[] = [];
  for (const hit of hits) {
    if (seen.has(hit.materialId)) continue;
    seen.add(hit.materialId);
    topics.push({
      chunkId: hit.chunkId,
      materialTitle: hit.materialTitle,
      sectionTitle: hit.sectionTitle,
    });
    if (topics.length >= limit) break;
  }
  return topics;
}

export function assessGrounding(hits: readonly HybridSearchHit[]): GroundingVerdict {
  const best = hits[0];
  const grounded =
    best !== undefined && best.rrfScore >= AI_ASK_MIN_RELEVANCE_SCORE && best.keywordRank !== null;

  return { grounded, topics: grounded ? [] : nearestTopics(hits) };
}
