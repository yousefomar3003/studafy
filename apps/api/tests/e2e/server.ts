/**
 * The live API process for the critical-journeys E2E suite (ST-246).
 *
 * A second composition root alongside `src/index.ts`, not a flag inside it: production's entrypoint
 * has no business knowing how to wire a fake payment provider, and a `stripeProvider` swap gated by
 * an env var is exactly the kind of "test-only branch in production code" this repo avoids elsewhere
 * (see AppOptions's own doc comments on why every seam here is constructor injection, not an
 * environment check inside `createApp`). Everything else — database, Redis, ERPNext, the mock OAuth
 * provider, the real `AnthropicProvider` class — is the real production wiring from `src/index.ts`,
 * copied rather than imported because `index.ts` runs its bootstrap at module load time (it is a
 * script, not a set of exported functions) and starts listening itself; there is nothing importable
 * to reuse.
 *
 * What is genuinely different from production, and why:
 *   - `stripeProvider` is always `FakeStripeProvider` (tests/mocks/fake-stripe-provider.ts) — a
 *     nightly suite must never depend on or bill against a live Stripe account. See the ST-246
 *     journey catalog for how a spec builds and signs a fake webhook against it.
 *   - `ANTHROPIC_BASE_URL` is expected to point at `tests/mocks/fake-anthropic.ts` (started
 *     alongside this process by the Playwright global setup, see e2e/critical/support/global-setup.ts)
 *     rather than the real Anthropic API — `AnthropicProvider` itself is unmodified real code; only
 *     the network endpoint is swapped, via the same env var production uses for a gateway/proxy.
 *   - `MOCK_OAUTH_ISSUER_URL`/`MOCK_OAUTH_REDIRECT_URI` are expected to be set, which is what mounts
 *     the "mock" login/activation provider and the mock IdP itself (mock-route.ts) — real Google and
 *     Microsoft OAuth stay unconfigured and unreachable.
 *   - Real Postgres, real Redis, and the real ERPNext client — see the ST-246 journey catalog for why
 *     invoice→payment runs against a genuine ERPNext sandbox rather than a fake.
 */

import { createApp } from "../../src/app";
import { checkDatabase, createDatabase, createReadDatabase } from "../../src/database";
import { loadEnv } from "../../src/env";
import { RedisCircuitBreaker } from "../../src/lib/circuit-breaker";
import { createStorageService } from "../../src/lib/storage";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { createAnthropicProvider, isTransientLlmFailure } from "../../src/modules/ai";
import { KeyStore } from "../../src/modules/auth";
import { startGradePublishedSubscriber } from "../../src/modules/grades/subscribers/grade-published.subscriber";
import { checkRedis, createRedisClient } from "../../src/redis";
import { buildFakeCheckoutCompletedEvent, FakeStripeProvider } from "../mocks/fake-stripe-provider";

import type { AiModelTier, LlmProvider } from "../../src/modules/ai";

const env = loadEnv();

if (!env.MOCK_OAUTH_ISSUER_URL) {
  throw new Error(
    "apps/api/tests/e2e/server.ts requires MOCK_OAUTH_ISSUER_URL — see " +
      "apps/web/e2e/critical/support/global-setup.ts for how it is set.",
  );
}

const logger = createLogger({
  level: env.LOG_LEVEL,
  base: { service: "studafy-api-e2e", env: env.NODE_ENV, release_version: env.RELEASE_VERSION },
});

const tracker = createInflightTracker();
const database = createDatabase(env);
const readDatabase = createReadDatabase(env, database);
const redis = env.REDIS_URL ? createRedisClient({ url: env.REDIS_URL, logger }) : null;
const storage = createStorageService(env);

// Required for correctness, not just parity with src/index.ts: the grade submit→approve→publish
// journey re-reads GET /api/grades/published/... immediately after publishing, and that route
// cache-aside reads through Redis (published/routes.ts). Without this subscriber the cache never
// invalidates on `grades.published` and the read can come back stale for the rest of the cache TTL.
const gradePublishedSubscriber = redis
  ? await startGradePublishedSubscriber({ redis, logger }).catch((err) => {
      logger.error({ err }, "failed to start grades.published cache subscriber");
      return null;
    })
  : null;
void gradePublishedSubscriber;

// Always the fake — see the file header. Exported on globalThis under a private-ish key so the
// Playwright global setup (running in a separate process) never needs to see it: a spec builds its
// webhook event via a direct HTTP call this same process answers (see the journey catalog's
// "subscription checkout" section), not by reaching into this module's memory.
export const stripeProvider = new FakeStripeProvider();

const aiLlmProvider: LlmProvider | null =
  env.AI_LLM_ENABLED && redis && env.ANTHROPIC_API_KEY
    ? createAnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL,
        timeoutMs: env.AI_LLM_TIMEOUT_MS,
        defaultMaxTokens: env.AI_LLM_MAX_TOKENS,
        zeroRetention: env.AI_LLM_ZERO_RETENTION,
        logger,
        circuitBreaker: new RedisCircuitBreaker(redis, logger, {
          keyPrefix: "cb:ai",
          component: "ai-circuit-breaker",
          isFailure: isTransientLlmFailure,
        }),
      })
    : null;

const aiLlmModelOverrides: Partial<Record<AiModelTier, string>> = {
  ...(env.AI_LLM_SMALL_MODEL ? { small: env.AI_LLM_SMALL_MODEL } : {}),
  ...(env.AI_LLM_LARGE_MODEL ? { large: env.AI_LLM_LARGE_MODEL } : {}),
};

const keyStore = new KeyStore(env.JWT_KEY_ROTATION_INTERVAL_MS, (kid) => {
  logger.info({ kid }, "jwt key rotated");
});
await keyStore.init();

const state = { ready: true };

const app = createApp({
  isReady: async () => state.ready && (await checkDatabase(database)) && (await checkRedis(redis)),
  tracker,
  logger,
  redis,
  database,
  readDatabase,
  keyStore,
  jwtIssuer: env.JWT_ISSUER,
  jwtAudience: env.JWT_AUDIENCE,
  jwtAccessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
  jwtRefreshTtlSeconds: env.JWT_REFRESH_TTL_SECONDS,
  storage,
  stripeProvider,
  docsEnabled: false,
  aiLlmProvider,
  aiLlmModelOverrides,
});

// Test-harness-only endpoint, outside /api/* (no bearer auth applies) and outside app.ts entirely —
// it exists only so the subscription-checkout spec, running in a separate process with no access to
// this process's in-memory `stripeProvider`, can ask this process to build the
// `checkout.session.completed` webhook event Stripe itself would have sent for one of the checkout
// sessions this process's own routes created (see FakeStripeProvider's doc comment for why the
// event's fields come from the real checkout-service call rather than being hand-guessed). The spec
// signs and POSTs the returned event to the real `/api/subscriptions/webhook/stripe` route itself —
// this endpoint only ever hands back a JSON body, never touches billing state on its own.
app.post("/__e2e__/fake-stripe/checkout-completed-event", async (c) => {
  const { sessionId } = (await c.req.json()) as { sessionId: string };
  return c.json(buildFakeCheckoutCompletedEvent(stripeProvider, sessionId));
});

const server = Bun.serve({ port: env.PORT, hostname: env.HOST, fetch: app.fetch });
logger.info({ host: server.hostname, port: server.port }, "e2e api listening");

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
