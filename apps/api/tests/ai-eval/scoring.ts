/**
 * RAG eval scoring functions (NFR-11).
 *
 * Four pure metrics, each returning a 0..1 score. No side effects, no I/O, no LLM calls.
 * The functions operate on the same data structures the production pipeline uses —
 * `HybridSearchHit`, `GroundingVerdict`, `Citation[]` — so the eval exercises the real
 * decision layer, not a test-specific reimplementation.
 *
 * Scoring philosophy:
 *   - Groundedness: can every sentence in the answer be traced to at least one source?
 *   - Citation accuracy: do the model's [N] tokens resolve to valid, relevant sources?
 *   - Refusal correctness: does the grounding verdict match the expected behavior?
 *   - Retrieval recall: are the relevant chunks present in the top-k results?
 */

import type { GroundingVerdict } from "../../src/modules/ai/ask/refusal";
import type { HybridSearchHit } from "../../src/modules/ai/retrieval/search";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function overlapRatio(source: string, target: string): number {
  const sourceTokens = new Set(tokenize(source));
  const targetTokens = tokenize(target);
  if (targetTokens.length === 0) return 0;
  let matches = 0;
  for (const token of targetTokens) {
    if (sourceTokens.has(token)) matches += 1;
  }
  return matches / targetTokens.length;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.replace(/\[\d+\]/g, "").trim())
    .filter((s) => s.length > 3);
}

const GROUNDED_THRESHOLD = 0.25;

/**
 * Fraction of answer sentences grounded in at least one source.
 *
 * A sentence is grounded when any source's token overlap with it exceeds the threshold.
 * The threshold is deliberately lenient — it catches "this sentence has nothing to do with
 * any source" without penalizing paraphrase.
 */
export function scoreGroundedness(answer: string, hits: readonly HybridSearchHit[]): number {
  const sentences = splitSentences(answer);
  if (sentences.length === 0) return 1;

  let grounded = 0;
  for (const sentence of sentences) {
    const bestOverlap = Math.max(...hits.map((hit) => overlapRatio(hit.content, sentence)));
    if (bestOverlap >= GROUNDED_THRESHOLD) grounded += 1;
  }
  return grounded / sentences.length;
}

/**
 * Fraction of the model's citations that resolve to a source containing relevant content.
 *
 * An invented [N] that does not map to any source is a miss. A valid [N] whose source's
 * content does not overlap with the cited sentence is also a miss.
 */
export function scoreCitationAccuracy(
  answer: string,
  sources: readonly { order: number; content: string }[],
): number {
  const pattern = /\[(\d+)\]/g;
  const citedOrders: number[] = [];
  const seen = new Set<number>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(answer)) !== null) {
    const order = Number(match[1]);
    if (!seen.has(order)) {
      seen.add(order);
      citedOrders.push(order);
    }
  }

  if (citedOrders.length === 0) return 1;

  const byOrder = new Map(sources.map((s) => [s.order, s]));
  const sentences = splitSentences(answer);

  let accurate = 0;
  for (const order of citedOrders) {
    const source = byOrder.get(order);
    if (!source) continue;

    const citedSentence = findCitedSentence(answer, order, sentences);
    if (citedSentence && overlapRatio(source.content, citedSentence) >= 0.15) {
      accurate += 1;
    }
  }

  return accurate / citedOrders.length;
}

function findCitedSentence(answer: string, order: number, sentences: string[]): string | null {
  for (const sentence of sentences) {
    if (answer.includes(sentence) && answer.includes(`[${order}]`)) {
      const sentenceEnd = answer.indexOf(sentence) + sentence.length;
      const citationPos = answer.indexOf(`[${order}]`);
      if (citationPos >= answer.indexOf(sentence) && citationPos <= sentenceEnd + 5) {
        return sentence;
      }
    }
  }
  return sentences[0] ?? null;
}

/**
 * Binary: 1.0 when the verdict matches the expectation, 0.0 otherwise.
 */
export function scoreRefusalCorrectness(verdict: GroundingVerdict, shouldRefuse: boolean): number {
  return verdict.grounded === !shouldRefuse ? 1 : 0;
}

/**
 * Fraction of relevant chunk ids present in the retrieval hits.
 */
export function scoreRetrievalRecall(
  hits: readonly HybridSearchHit[],
  relevantChunkIds: readonly string[],
): number {
  if (relevantChunkIds.length === 0) return 1;
  const hitIds = new Set(hits.map((h) => h.chunkId));
  let found = 0;
  for (const id of relevantChunkIds) {
    if (hitIds.has(id)) found += 1;
  }
  return found / relevantChunkIds.length;
}
