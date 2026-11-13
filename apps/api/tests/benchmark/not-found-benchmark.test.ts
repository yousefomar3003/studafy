// Measures the ST-055 acceptance target: an unmatched route resolves to the problem+json envelope in
// under 1 ms.
//
// The number asserted is a DELTA, not a wall-clock time, for the reasons the ST-054 benchmark next to
// this file sets out at length: an absolute per-request budget on a shared CI runner measures Hono's
// dispatch and Bun's Request/Response construction, none of which this ticket can spend or fix. The two
// arms here differ only by app.notFound(problemNotFound) -- the baseline arm falls through to Hono's
// built-in text/plain 404 -- so subtracting cancels the shared noise and leaves what this ticket
// actually added: one buildProblem call and one JSON.stringify.
//
// Both arms carry requestContext, so its own (separately benchmarked) cost is in the baseline and
// subtracts out. What remains is the envelope, which is the only thing ST-055 put on this path.
//
// Gated in-file as well as in CI: `bun test` in this app globs every directory, so without the skipIf a
// 3000-iteration benchmark would run on every local unit-test invocation.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";
import { Hono } from "hono";

import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { problemNotFound } from "../../src/problem";
import { requestContext } from "../../src/request-context";

import type { AppEnv } from "../../src/request-context";

const benchmarkTest = test.skipIf(process.env.NOT_FOUND_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1_000;
const MEASURED_ITERATIONS = 2_000;
const TARGET_MS = 1;
const UNMATCHED_PATH = "/v1/invalid-route-path";

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Two apps identical but for the handler under test. The tracker, requestContext, and the one real
 * route are present in both, so the subtraction leaves only problemNotFound: the envelope construction
 * and its serialization.
 */
function buildApp(withNotFound: boolean): Hono<AppEnv> {
  const tracker = createInflightTracker();
  const app = new Hono<AppEnv>();

  app.use("*", async (_c, next) => {
    tracker.begin();
    try {
      await next();
    } finally {
      tracker.end();
    }
  });

  app.use(
    "*",
    requestContext({
      logger: createLogger({
        base: { service: "api", env: "test", release_version: "benchmark" },
        destination: () => undefined,
      }),
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  if (withNotFound) {
    app.notFound(problemNotFound);
  }

  return app;
}

async function measure(app: Hono<AppEnv>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await app.request(UNMATCHED_PATH);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

function report(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  console.log(
    `${label}: min=${sorted[0]!.toFixed(4)}ms median=${median.toFixed(4)}ms ` +
      `p95=${percentile(sorted, 0.95).toFixed(4)}ms max=${sorted[sorted.length - 1]!.toFixed(4)}ms`,
  );
  return median;
}

benchmarkTest(
  `the problem+json 404 adds under ${TARGET_MS}ms to an unmatched route`,
  async () => {
    const baseline = buildApp(false);
    const measured = buildApp(true);

    // Proof the two arms are actually the two things being compared: a silently unregistered handler
    // would otherwise "pass" this benchmark by measuring Hono's text/plain 404 twice.
    expect((await baseline.request(UNMATCHED_PATH)).headers.get("content-type")).not.toBe(
      "application/problem+json",
    );
    expect((await measured.request(UNMATCHED_PATH)).headers.get("content-type")).toBe(
      "application/problem+json",
    );

    // JSC needs real warmup before these numbers mean anything: the first hundred iterations measure
    // the interpreter, not the optimized code that serves production traffic.
    await measure(baseline, WARMUP_ITERATIONS);
    await measure(measured, WARMUP_ITERATIONS);

    const baselineSamples = await measure(baseline, MEASURED_ITERATIONS);
    const measuredSamples = await measure(measured, MEASURED_ITERATIONS);

    const baselineMedian = report("hono default 404 ", baselineSamples);
    const measuredMedian = report("problem+json 404 ", measuredSamples);
    const overhead = measuredMedian - baselineMedian;
    console.log(`problem+json 404 overhead: ${overhead.toFixed(4)}ms (target < ${TARGET_MS}ms)`);

    expect(overhead).toBeLessThan(TARGET_MS);
  },
  30_000,
);
