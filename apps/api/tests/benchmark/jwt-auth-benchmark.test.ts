// Measures the ST-070 acceptance target: verifying a token's signature, checking the revocation
// denylist, and populating the downstream context variables stays under a 2 ms p95.
//
// Two things about what is being measured, both deliberate:
//
// 1. The number asserted is a DELTA, following security-chain-benchmark.test.ts and the reasoning
//    laid out at length in request-context-benchmark.test.ts. Two apps identical but for the auth
//    middleware, subtracted, leaves this middleware's own cost — an absolute per-request figure on a
//    shared CI runner is mostly measuring Hono's dispatch and Bun's Request/Response construction.
//
// 2. The denylist is in-process, not a real Redis client, so the figure excludes network round-trip
//    time. That is on purpose: RTT is a property of the deployment topology, not of this middleware,
//    and a co-located Redis contributes well under a millisecond. What the assertion does cover is
//    the part this ticket owns — RSA signature verification, claim validation, and context
//    hydration. Measured, that lands around 0.3 ms p95, and essentially all of it is the RSA
//    verification: the memoized JWKS in the key store saves roughly 6 µs per request, which is
//    real but not what makes the budget.
//
// The accept path is measured. A rejected token is cheaper (it short-circuits before the denylist
// lookup — see tests/auth/short-circuit.test.ts), so budgeting against the path that reaches a
// handler is the conservative choice.
//
// Gated in-file as well as in CI: `bun test` globs every directory, so without the skipIf a
// multi-thousand-iteration benchmark would run on every local unit-test invocation.

import { OpenAPIHono } from "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";

import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { requestIdMiddleware } from "../../src/middleware";
import { jwtAuthMiddleware } from "../../src/middleware/jwtAuth";
import { AUTH_CHANNELS, KeyStore, signAccessToken } from "../../src/modules/auth";

import type { AppEnv } from "../../src/middleware";
import type { JtiDenylist } from "../../src/modules/auth";
import type { Role } from "@studafy/constants";

const benchmarkTest = test.skipIf(process.env.JWT_AUTH_BENCHMARK !== "1");

const WARMUP_ITERATIONS = 1_000;
const MEASURED_ITERATIONS = 2_000;
const TARGET_MS = 2;

const ISSUER = "studafy-bench";
const AUDIENCE = "studafy-api-bench";

const logger = createLogger({ destination: () => undefined });

/** Requests served, so the measured arm is proven to have done the work rather than skipped it. */
let served = 0;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** An in-process denylist that always answers "not revoked" — one Map miss, no network. */
const denylist: JtiDenylist = {
  isRevoked: () => Promise.resolve(false),
  revoke: () => Promise.resolve(),
  revokeMany: () => Promise.resolve(0),
};

/**
 * Two apps identical but for the auth middleware. The tracker, the request-id middleware, and the
 * route exist in both, so the subtraction leaves only signature verification, claim validation,
 * the denylist check, and context hydration.
 */
function buildApp(keyStore: KeyStore, withAuth: boolean): OpenAPIHono<AppEnv> {
  const tracker = createInflightTracker();
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", async (_c, next) => {
    tracker.begin();
    try {
      await next();
    } finally {
      tracker.end();
    }
  });

  app.use("*", requestIdMiddleware({ logger }));

  if (withAuth) {
    app.use(
      "/api/*",
      jwtAuthMiddleware({ keyStore, denylist, issuer: ISSUER, audience: AUDIENCE }),
    );
  }

  app.get("/api/echo", (c) => {
    served += 1;
    return c.json({ ok: true });
  });
  return app;
}

async function measure(
  app: OpenAPIHono<AppEnv>,
  token: string,
  iterations: number,
): Promise<number[]> {
  const samples: number[] = [];
  const init: RequestInit = { method: "GET", headers: { Authorization: `Bearer ${token}` } };

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await app.request("/api/echo", init);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

function report(label: string, samples: number[]): { median: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  console.log(
    `${label}: min=${sorted[0]!.toFixed(4)}ms median=${median.toFixed(4)}ms ` +
      `p95=${p95.toFixed(4)}ms max=${sorted[sorted.length - 1]!.toFixed(4)}ms`,
  );
  return { median, p95 };
}

benchmarkTest(
  `JWT verification adds under ${TARGET_MS}ms at p95 under continuous load`,
  async () => {
    const keyStore = new KeyStore(3_600_000);
    await keyStore.init();

    const token = await signAccessToken(
      keyStore,
      {
        sub: "11111111-1111-1111-1111-111111111111",
        school_id: "22222222-2222-2222-2222-222222222222",
        roles: ["INSTRUCTOR", "ORG_ADMIN"] as Role[],
        entitlements_ver: 1,
        channel: AUTH_CHANNELS.WEB,
        subscription_status: "active",
      },
      { issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 86_400 },
    );

    const baseline = buildApp(keyStore, false);
    const measured = buildApp(keyStore, true);

    // JSC needs real warmup before these numbers mean anything: the first hundred iterations
    // measure the interpreter, not the optimized code that serves production traffic.
    await measure(baseline, token, WARMUP_ITERATIONS);
    await measure(measured, token, WARMUP_ITERATIONS);

    served = 0;
    const baselineSamples = await measure(baseline, token, MEASURED_ITERATIONS);
    const measuredSamples = await measure(measured, token, MEASURED_ITERATIONS);

    // Proof both arms reached the handler: a middleware that 401'd every request would otherwise
    // "pass" this benchmark by short-circuiting before doing the work it is supposed to be timed on.
    expect(served).toBe(MEASURED_ITERATIONS * 2);

    const baseline95 = report("without auth middleware", baselineSamples);
    const measured95 = report("with auth middleware   ", measuredSamples);

    const p95Overhead = measured95.p95 - baseline95.p95;
    console.log(`auth p95 overhead: ${p95Overhead.toFixed(4)}ms (target < ${TARGET_MS}ms)`);

    expect(p95Overhead).toBeLessThan(TARGET_MS);

    keyStore.destroy();
  },
  60_000,
);
