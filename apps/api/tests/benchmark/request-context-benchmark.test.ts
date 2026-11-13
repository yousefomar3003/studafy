// Measures the ST-054 acceptance target: the request-context middleware generates the tracing context,
// serializes a structured line to stdout, and completes its lifecycle in under 1 ms.
//
// The number asserted is a DELTA, not a wall-clock time, and that distinction is the whole design of this
// file. An absolute per-request budget on a shared CI runner measures Hono's dispatch, Bun's Request and
// Response construction, and whatever else the runner happens to be doing -- none of which this ticket
// can spend or fix. The NFR-05 probe is the cautionary tale: its absolute budget was widened twice
// (500ms -> 600ms -> 1000ms) because it was asserting a number within ~2x of its real cost on a noisy
// host. Measuring two identical apps that differ only by this middleware, and subtracting, cancels the
// shared noise and leaves our own cost -- which has a ~100x margin against the budget.
//
// The sink counts lines instead of writing them, for the same reason the ST-046 benchmark charges
// transport to the host: JSON serialization is our cost and is measured, while the write(2) into the
// container's log pipe is the platform's and is not.
//
// Gated in-file as well as in CI: `bun test` in this app globs every directory, so without the skipIf a
// 3000-iteration benchmark would run on every local unit-test invocation.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";
import { Hono } from "hono";

import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { requestContext } from "../../src/request-context";

import type { AppEnv } from "../../src/request-context";

const benchmarkTest = test.skipIf(process.env.REQUEST_CONTEXT_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1_000;
const MEASURED_ITERATIONS = 2_000;
const TARGET_MS = 1;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** Lines emitted, so the measured arm is proven to have done the work rather than skipped it. */
let written = 0;

/**
 * Two apps identical but for the middleware under test. The tracker and route are present in both, so
 * the subtraction leaves only requestContext: id generation, child-logger construction, JSON
 * serialization, the header stamp, and the completion line.
 */
function buildApp(withContext: boolean): Hono<AppEnv> {
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

  if (withContext) {
    app.use(
      "*",
      requestContext({
        logger: createLogger({
          base: { service: "api", env: "test", release_version: "benchmark" },
          destination: () => {
            written += 1;
          },
        }),
      }),
    );
  }

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  return app;
}

async function measure(app: Hono<AppEnv>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await app.request("/healthz");
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
  `request-context middleware adds under ${TARGET_MS}ms to a request`,
  async () => {
    const baseline = buildApp(false);
    const measured = buildApp(true);

    // JSC needs real warmup before these numbers mean anything: the first hundred iterations measure
    // the interpreter, not the optimized code that serves production traffic.
    await measure(baseline, WARMUP_ITERATIONS);
    await measure(measured, WARMUP_ITERATIONS);

    written = 0;
    const baselineSamples = await measure(baseline, MEASURED_ITERATIONS);
    const measuredSamples = await measure(measured, MEASURED_ITERATIONS);

    // Proof the measured arm actually logged: one completion line per request. A silently disabled
    // logger would otherwise "pass" this benchmark by doing nothing.
    expect(written).toBe(MEASURED_ITERATIONS);

    const baselineMedian = report("without request-context", baselineSamples);
    const measuredMedian = report("with request-context   ", measuredSamples);
    const overhead = measuredMedian - baselineMedian;
    console.log(`request-context overhead: ${overhead.toFixed(4)}ms (target < ${TARGET_MS}ms)`);

    expect(overhead).toBeLessThan(TARGET_MS);
  },
  30_000,
);
