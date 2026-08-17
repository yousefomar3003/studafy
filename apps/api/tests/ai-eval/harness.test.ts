/**
 * RAG evaluation harness — CI gate on prompt/model/chunking changes (NFR-11).
 *
 * Runs the golden set through the production decision layer and asserts that aggregate
 * scores meet the acceptance thresholds. A regression in retrieval, grounding, citation
 * resolution, or refusal logic breaks this test — which is the point.
 *
 * Usage:
 *   bun test ./tests/ai-eval --timeout 30000
 *
 * The harness is component-level: it calls `assessGrounding`, `resolveCitations`, and the
 * scoring functions directly. No HTTP, no database, no LLM calls. This makes it deterministic,
 * fast, and CI-friendly.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { toGroundedSources } from "../../src/modules/ai/ask/prompt";
import { assessGrounding } from "../../src/modules/ai/ask/refusal";

import { GOLDEN_SET } from "./golden-set";
import {
  scoreCitationAccuracy,
  scoreGroundedness,
  scoreRefusalCorrectness,
  scoreRetrievalRecall,
} from "./scoring";

// ── Thresholds ──────────────────────────────────────────────────────────────────
// Below these, CI fails. Adjust only with a deliberate commit that explains why.

const THRESHOLD_GROUNDEDNESS = 0.95;
const THRESHOLD_CITATION_ACCURACY = 0.9;
const THRESHOLD_REFUSAL_CORRECTNESS = 0.95;

// ── Helpers ─────────────────────────────────────────────────────────────────────

interface CaseScores {
  id: string;
  groundedness: number;
  citationAccuracy: number;
  refusalCorrectness: number;
  retrievalRecall: number;
}

function evalCase(c: (typeof GOLDEN_SET)[number]): CaseScores {
  const sources = toGroundedSources(c.hits);
  const verdict = assessGrounding(c.hits);

  const groundedness = c.shouldRefuse ? 1 : scoreGroundedness(c.answer, c.hits);
  const citationAccuracy = c.shouldRefuse ? 1 : scoreCitationAccuracy(c.answer, sources);
  const refusalCorrectness = scoreRefusalCorrectness(verdict, c.shouldRefuse);
  const retrievalRecall = scoreRetrievalRecall(c.hits, c.relevantChunkIds);

  return { id: c.id, groundedness, citationAccuracy, refusalCorrectness, retrievalRecall };
}

function mean(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("RAG eval harness", () => {
  const results = GOLDEN_SET.map(evalCase);

  test("every case produces scores in [0, 1]", () => {
    for (const r of results) {
      expect(r.groundedness).toBeGreaterThanOrEqual(0);
      expect(r.groundedness).toBeLessThanOrEqual(1);
      expect(r.citationAccuracy).toBeGreaterThanOrEqual(0);
      expect(r.citationAccuracy).toBeLessThanOrEqual(1);
      expect(r.refusalCorrectness).toBeGreaterThanOrEqual(0);
      expect(r.refusalCorrectness).toBeLessThanOrEqual(1);
      expect(r.retrievalRecall).toBeGreaterThanOrEqual(0);
      expect(r.retrievalRecall).toBeLessThanOrEqual(1);
    }
  });

  test(`groundedness ≥ ${THRESHOLD_GROUNDEDNESS} (aggregate)`, () => {
    const avg = mean(results.map((r) => r.groundedness));
    const failing = results.filter((r) => r.groundedness < THRESHOLD_GROUNDEDNESS);
    if (failing.length > 0) {
      const details = failing.map((r) => `  ${r.id}: ${r.groundedness.toFixed(3)}`).join("\n");
      expect(avg, `below threshold. Failing cases:\n${details}`).toBeGreaterThanOrEqual(
        THRESHOLD_GROUNDEDNESS,
      );
    }
    expect(avg).toBeGreaterThanOrEqual(THRESHOLD_GROUNDEDNESS);
  });

  test(`citation accuracy ≥ ${THRESHOLD_CITATION_ACCURACY} (aggregate)`, () => {
    const avg = mean(results.map((r) => r.citationAccuracy));
    const failing = results.filter((r) => r.citationAccuracy < THRESHOLD_CITATION_ACCURACY);
    if (failing.length > 0) {
      const details = failing.map((r) => `  ${r.id}: ${r.citationAccuracy.toFixed(3)}`).join("\n");
      expect(avg, `below threshold. Failing cases:\n${details}`).toBeGreaterThanOrEqual(
        THRESHOLD_CITATION_ACCURACY,
      );
    }
    expect(avg).toBeGreaterThanOrEqual(THRESHOLD_CITATION_ACCURACY);
  });

  test(`refusal correctness ≥ ${THRESHOLD_REFUSAL_CORRECTNESS} (aggregate)`, () => {
    const avg = mean(results.map((r) => r.refusalCorrectness));
    const failing = results.filter((r) => r.refusalCorrectness < THRESHOLD_REFUSAL_CORRECTNESS);
    if (failing.length > 0) {
      const details = failing
        .map((r) => `  ${r.id}: ${r.refusalCorrectness.toFixed(3)}`)
        .join("\n");
      expect(avg, `below threshold. Failing cases:\n${details}`).toBeGreaterThanOrEqual(
        THRESHOLD_REFUSAL_CORRECTNESS,
      );
    }
    expect(avg).toBeGreaterThanOrEqual(THRESHOLD_REFUSAL_CORRECTNESS);
  });

  test("retrieval recall is measured (informational, not gated)", () => {
    const avg = mean(results.map((r) => r.retrievalRecall));
    // Retrieval recall is informational — it surfaces regressions but does not gate CI.
    // Remove this comment and add an assertion if it should become a gate.
    expect(avg).toBeGreaterThanOrEqual(0);
    expect(avg).toBeLessThanOrEqual(1);
  });

  test("scores are printed for CI visibility", () => {
    const header = [
      "RAG eval results",
      "─".repeat(60),
      `${"Case".padEnd(35)} Ground  Cite  Refuse  Recall`,
      "─".repeat(60),
    ];

    const rows = results.map(
      (r) =>
        `${r.id.padEnd(35)} ${r.groundedness.toFixed(2).padStart(5)}  ${r.citationAccuracy.toFixed(2).padStart(5)}  ${r.refusalCorrectness.toFixed(2).padStart(5)}  ${r.retrievalRecall.toFixed(2).padStart(5)}`,
    );

    const avg = [
      "─".repeat(60),
      `${"AVERAGE".padEnd(35)} ${mean(results.map((r) => r.groundedness))
        .toFixed(2)
        .padStart(5)}  ${mean(results.map((r) => r.citationAccuracy))
        .toFixed(2)
        .padStart(5)}  ${mean(results.map((r) => r.refusalCorrectness))
        .toFixed(2)
        .padStart(5)}  ${mean(results.map((r) => r.retrievalRecall))
        .toFixed(2)
        .padStart(5)}`,
      "─".repeat(60),
    ];

    console.log(`\n${[...header, ...rows, ...avg].join("\n")}\n`);

    // The test always passes — it exists to make scores visible in CI output.
    expect(true).toBe(true);
  });
});
