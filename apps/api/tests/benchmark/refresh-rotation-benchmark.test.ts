// Measures the ST-071 acceptance target: a full token rotation — validation, the transactional
// state transition, and minting the replacement pair — completes in under 5 ms under parallel load.
//
// What is measured, and why it is an absolute figure rather than a delta:
//
// The benchmarks next door (jwt-auth, security-chain, request-context) all assert a *delta* between
// two apps identical but for the middleware under test, because subtracting cancels the shared cost
// of Hono dispatch and Bun's Request/Response construction on a noisy CI runner. That technique does
// not apply here. Rotation has no baseline arm: there is no "app without rotation" that still does
// the work, and the cost being budgeted is dominated by database round trips rather than by
// per-request framework overhead. So this follows the other precedent in the repo — the absolute
// budgets in packages/db/tests (see docs/database/attendance.md) — and measures the service call
// directly rather than through HTTP.
//
// Consequently the figure covers: parsing the presented token, one SHA-256 digest, the locator
// resolution round trip, the tenant transaction that reads the session, inserts the child, and
// consumes the parent, and the RSA signature that mints the new access token. It excludes client
// network RTT, which is a property of deployment topology rather than of this code.
//
// The measured path is the *accepting* one. Every rejection is cheaper — a malformed token never
// reaches the database at all — so budgeting against the path that actually rotates is the
// conservative choice, and `rotations` below proves the loop really took it.
//
// "Parallel stress" is read literally: the measured phase runs CONCURRENCY rotations at a time
// against the connection pool, so the number includes contention for pool slots and the row-level
// lock the consuming UPDATE takes. A serial loop would report a friendlier number that no real
// deployment ever sees.
//
// Gated in-file as well as in CI: `bun test` globs every directory, so without the skipIf this would
// run on every local unit-test invocation.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { expect, test } from "bun:test";

import { DATABASE_MAX_CONNECTIONS } from "../../src/db/client";
import { AUTH_CHANNELS, KeyStore } from "../../src/modules/auth";
import {
  createFullTenant,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { SessionTokenConfig } from "../../src/modules/auth";

const benchmarkEnabled = integrationEnabled && process.env.REFRESH_ROTATION_BENCHMARK === "1";
const benchmarkTest = test.skipIf(!benchmarkEnabled);

const WARMUP_ITERATIONS = 200;
const MEASURED_ITERATIONS = 1_000;
const CONCURRENCY = 16;
const TARGET_MS = 5;

/** Rotations that actually completed, so a run that 401'd everything cannot pass. */
let rotations = 0;

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
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
  `refresh rotation completes in under ${TARGET_MS}ms under parallel load`,
  async () => {
    const database = await createTestDatabase({ maxConnections: DATABASE_MAX_CONNECTIONS });
    const keyStore = new KeyStore(3_600_000);

    try {
      await migrateDatabase(database.url);
      const sql = database.sql;
      const tenant = await createFullTenant(sql);
      await keyStore.init();

      const { issueTokenPair, rotateRefreshToken } = await import("../../src/modules/auth");
      const { withTenantTx } = await import("../../src/db/tenant-tx");

      const config: SessionTokenConfig = {
        keyStore,
        issuer: "studafy-bench",
        audience: "studafy-api-bench",
        accessTtlSeconds: 900,
        refreshTtlSeconds: 30 * 24 * 60 * 60,
      };

      const userId = tenant.users.INSTRUCTOR.id;
      const tenantContext = { schoolId: tenant.schoolId, userId };

      /** Start an independent session, so concurrent rotations contend for the pool, not one row. */
      const newSession = async (): Promise<string> => {
        const issued = await withTenantTx(sql, tenantContext, (tx) =>
          issueTokenPair(tx, config, {
            userId,
            schoolId: tenant.schoolId,
            channel: AUTH_CHANNELS.MOBILE,
          }),
        );
        return issued.refreshToken;
      };

      /**
       * Rotate `count` tokens, CONCURRENCY at a time, timing each rotation individually.
       *
       * Each worker owns its own chain: a rotation consumes its input, so a shared token would make
       * every iteration after the first a reuse breach rather than a rotation.
       */
      const measure = async (count: number): Promise<number[]> => {
        const samples: number[] = [];
        const workers = Math.min(CONCURRENCY, count);
        const perWorker = Math.floor(count / workers);

        await Promise.all(
          Array.from({ length: workers }, async () => {
            let token = await newSession();

            for (let i = 0; i < perWorker; i += 1) {
              const started = performance.now();
              const issued = await rotateRefreshToken(sql, config, { presentedToken: token });
              samples.push(performance.now() - started);

              token = issued.refreshToken;
              rotations += 1;
            }
          }),
        );

        return samples;
      };

      // JSC needs real warmup before these numbers mean anything, and so does PostgreSQL: the first
      // iterations measure cold caches and an unplanned query, not the steady state.
      await measure(WARMUP_ITERATIONS);

      rotations = 0;
      const samples = await measure(MEASURED_ITERATIONS);

      const workers = Math.min(CONCURRENCY, MEASURED_ITERATIONS);
      const expected = workers * Math.floor(MEASURED_ITERATIONS / workers);
      expect(rotations).toBe(expected);
      expect(samples).toHaveLength(expected);

      const { median } = report(`rotation @${CONCURRENCY} concurrent`, samples);
      console.log(`rotation median: ${median.toFixed(4)}ms (target < ${TARGET_MS}ms)`);

      // The median is the gated figure. p95 is reported but not asserted: at this concurrency the
      // tail is dominated by connection-pool queueing, which is a function of the pool size and the
      // runner's core count rather than of the rotation path, and gating on it would make the build
      // fail for reasons this ticket does not control.
      expect(median).toBeLessThan(TARGET_MS);
    } finally {
      keyStore.destroy();
      await database.cleanup();
    }
  },
  180_000,
);
