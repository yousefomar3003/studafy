/**
 * ST-163 re-ranker latency — the "added latency < 300 ms p95" acceptance gate.
 *
 * Measures the worst-case shape the retrieval route actually produces: a full `RERANK_CANDIDATE_POOL`
 * candidate pool of realistic chunk length, scored end-to-end through `rerankHits` (the exact call the
 * route makes), one async await per iteration. Warm-up iterations run before any timing so the JIT
 * does not count against the budget. The budget itself is the ticket's: 300 ms p95, an order of
 * magnitude above what the deterministic scorer needs, and the same number a real ONNX cross-encoder
 * must stay under when it is swapped in behind the same contract.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  createDeterministicCrossEncoderReranker,
  RERANK_CANDIDATE_POOL,
  rerankHits,
} from "./rerank";

import type { Rerankable } from "./rerank";

const TARGET_P95_MS = 300;
const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 1_000;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

const query =
  "mitosis separates chromosomes during cell division to produce identical daughter cells";

/** Realistic chunk-length content; every candidate shares some query tokens so scoring discriminates. */
const candidates: Rerankable[] = Array.from({ length: RERANK_CANDIDATE_POOL }, (_, index) => ({
  chunkId: `chunk-${index}`,
  content:
    `The nucleus of a living cell holds the genetic material of the organism. Mitosis separates ` +
    `chromosomes during division so that two identical daughter cells are produced, each with a full ` +
    `copy of the genome. The stages of the cycle include prophase, metaphase, anaphase, and telophase, ` +
    `and errors in this process can lead to serious problems in the tissue that depends on it. ` +
    `When the process is disturbed the cell may divide out of control. ${index}`,
  rrfScore: 1 / (60 + index + 1),
}));

describe("rerankHits latency", () => {
  test(`re-ranks a full ${RERANK_CANDIDATE_POOL}-candidate pool under ${TARGET_P95_MS}ms p95`, async () => {
    const reranker = createDeterministicCrossEncoderReranker();

    for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
      await rerankHits(query, candidates, reranker);
    }

    const timings: number[] = [];
    for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
      const start = performance.now();
      await rerankHits(query, candidates, reranker);
      timings.push(performance.now() - start);
    }

    const p95 = percentile(
      timings.sort((a, b) => a - b),
      0.95,
    );
    expect(p95, `p95 over ${MEASURED_ITERATIONS} reranks`).toBeLessThan(TARGET_P95_MS);
  });
});
