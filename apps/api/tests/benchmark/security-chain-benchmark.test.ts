// Measures the ST-067 acceptance target: the security middleware chain evaluates headers, validates
// the anti-forgery token, verifies the origin boundary, and passes execution down to routes in under
// 0.5 ms per request.
//
// The number asserted is a DELTA, not a wall-clock time, for the reason spelled out at length in
// request-context-benchmark.test.ts: an absolute per-request budget on a shared CI runner is mostly
// measuring Hono's dispatch and Bun's Request/Response construction, neither of which this ticket can
// spend or fix. Two apps identical but for the chain, subtracted, leaves this chain's own cost.
//
// The accept path is the one measured. A rejected request is cheaper -- it short-circuits before
// routing -- so budgeting against the path that actually reaches a handler is the conservative choice.
//
// Gated in-file as well as in CI: `bun test` in this app globs every directory, so without the skipIf
// a 3000-iteration benchmark would run on every local unit-test invocation.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";
import { Hono } from "hono";

import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { corsMiddleware } from "../../src/middleware/cors";
import { csrfMiddleware } from "../../src/middleware/csrf";
import { securityHeadersMiddleware } from "../../src/middleware/securityHeaders";

import type { AppEnv } from "../../src/middleware";

const benchmarkTest = test.skipIf(process.env.SECURITY_CHAIN_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1_000;
const MEASURED_ITERATIONS = 2_000;
const TARGET_MS = 0.5;

const ALLOWED_ORIGIN = "http://localhost:5173";
const CSRF_TOKEN = "YmVuY2htYXJrLXRva2VuLTMyLWJ5dGVzLWxvbmctcGFk";

/** Requests served, so the measured arm is proven to have done the work rather than skipped it. */
let served = 0;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/**
 * Two apps identical but for the security chain. The tracker and the route exist in both, so the
 * subtraction leaves only CORS origin validation, the header matrix, and the CSRF token comparison.
 */
function buildApp(withSecurity: boolean): Hono<AppEnv> {
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

  if (withSecurity) {
    app.use("*", corsMiddleware());
    app.use("*", securityHeadersMiddleware());
    app.use("/api/*", csrfMiddleware());
  }

  app.post("/api/echo", (c) => {
    served += 1;
    return c.json({ ok: true });
  });
  return app;
}

/**
 * A credentialed cross-origin mutation: the most expensive accept path the chain has. It exercises
 * origin validation, the full header matrix, and a constant-time token comparison that succeeds.
 */
async function measure(app: Hono<AppEnv>, iterations: number): Promise<number[]> {
  const samples: number[] = [];
  const init: RequestInit = {
    method: "POST",
    headers: {
      Origin: ALLOWED_ORIGIN,
      Cookie: `XSRF-TOKEN=${CSRF_TOKEN}`,
      "X-XSRF-TOKEN": CSRF_TOKEN,
    },
  };

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await app.request("/api/echo", init);
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
  `security middleware chain adds under ${TARGET_MS}ms to a request`,
  async () => {
    resetSecurityConfig();

    const baseline = buildApp(false);
    const measured = buildApp(true);

    // JSC needs real warmup before these numbers mean anything: the first hundred iterations measure
    // the interpreter, not the optimized code that serves production traffic.
    await measure(baseline, WARMUP_ITERATIONS);
    await measure(measured, WARMUP_ITERATIONS);

    served = 0;
    const baselineSamples = await measure(baseline, MEASURED_ITERATIONS);
    const measuredSamples = await measure(measured, MEASURED_ITERATIONS);

    // Proof both arms reached the handler: a chain that 403'd every request would otherwise "pass"
    // this benchmark by short-circuiting before doing the work it is supposed to be timed on.
    expect(served).toBe(MEASURED_ITERATIONS * 2);

    const baselineMedian = report("without security chain", baselineSamples);
    const measuredMedian = report("with security chain   ", measuredSamples);
    const overhead = measuredMedian - baselineMedian;
    console.log(`security chain overhead: ${overhead.toFixed(4)}ms (target < ${TARGET_MS}ms)`);

    expect(overhead).toBeLessThan(TARGET_MS);
  },
  30_000,
);
