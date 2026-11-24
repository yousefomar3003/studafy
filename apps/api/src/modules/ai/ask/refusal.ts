import { AI_ASK_MIN_SEMANTIC_SIMILARITY } from "../config";

import type { HybridSearchHit, RetrievalMode } from "../retrieval/search";

/**
 * Grounding refusal for Ask AI (ST-165, ADR-024).
 *
 * The ask route refuses to answer when retrieval cannot establish that the student's question is
 * grounded in the school's own corpus, because answering from noise would make up an answer that
 * looks sourced. A question is grounded when either:
 *
 *   - some hit matched the keyword leg (`keywordRank !== null`): `websearch_to_tsquery` ANDs the
 *     question's content words, so every one of them appears in that chunk; or
 *   - hybrid mode only: some hit is at least {@link AI_ASK_MIN_SEMANTIC_SIMILARITY} similar to the
 *     question by a real embedding model -- the arm that answers a question asked in other words
 *     ("التمثيل الضوئي" for a book that says "البناء الضوئي"), a dialect, or the other language.
 *
 * Lexical mode (ADR-020; also any request whose question embedding failed) has only the keyword
 * arm. The semantic arm trusts the similarity because the semantic leg compares the question only
 * with chunks embedded by the same model (`HybridSearchInput.embeddingModel`), never with the mock.
 *
 * When the verdict refuses, the caller sends the refusal path's payload, which carries the nearest
 * topics the retrieval did find -- the materials that were closest to the question, so the student
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

export function assessGrounding(
  hits: readonly HybridSearchHit[],
  mode: RetrievalMode = "hybrid",
): GroundingVerdict {
  const keywordMatch = hits.some((hit) => hit.keywordRank !== null);
  const semanticMatch =
    mode === "hybrid" &&
    hits.some(
      (hit) =>
        hit.semanticSimilarity !== null && hit.semanticSimilarity >= AI_ASK_MIN_SEMANTIC_SIMILARITY,
    );
  const grounded = keywordMatch || semanticMatch;

  return { grounded, topics: grounded ? [] : nearestTopics(hits) };
}
