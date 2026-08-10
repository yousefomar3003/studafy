import { createApp } from "./app";
import { checkDatabase, closeDatabasePools, createDatabase, createReadDatabase } from "./database";
import { loadEnv } from "./env";
import { createSecurityEventSink } from "./lib/security/securityEventSink";
import { createStorageService } from "./lib/storage";
import { createInflightTracker, gracefulShutdown } from "./lifecycle";
import { createLogger } from "./logger";
import { KeyStore } from "./modules/auth";
import { startGradePublishedSubscriber } from "./modules/grades/subscribers/grade-published.subscriber";
import { startEntitlementInvalidationSubscriber, StripeAdapter } from "./modules/subscriptions";
import { checkRedis, closeRedis, createRedisClient } from "./redis";

// Fail fast: an invalid environment throws EnvValidationError here, before the server binds a port.
const env = loadEnv();

// The root logger. Every line this process writes descends from it, so stdout is uniformly NDJSON —
// a single unparseable line would break JSON filters across the whole log group.
const logger = createLogger({
  level: env.LOG_LEVEL,
  base: {
    service: env.SERVICE_NAME,
    env: env.NODE_ENV,
    release_version: env.RELEASE_VERSION,
  },
});

const state = { ready: true };
const tracker = createInflightTracker();
const database = createDatabase(env);
const readDatabase = createReadDatabase(env, database);
const redis = env.REDIS_URL ? createRedisClient({ url: env.REDIS_URL, logger }) : null;
const gradePublishedSubscriber = redis
  ? await startGradePublishedSubscriber({ redis, logger }).catch((err) => {
      logger.error({ err }, "failed to start grades.published cache subscriber");
      return null;
    })
  : null;
// The fast half of ST-133's invalidation. The durable half is the workers-side poller; a failure to
// start here degrades propagation to that poller's interval rather than breaking correctness, so it
// is logged and swallowed exactly as the grades subscriber above is.
const entitlementInvalidationSubscriber = redis
  ? await startEntitlementInvalidationSubscriber({ redis, logger }).catch((err) => {
      logger.error({ err }, "failed to start entitlement invalidation subscriber");
      return null;
    })
  : null;

// Persists CORS/CSRF rejections off the request path. Returns a no-op sink when no database is
// configured, so nothing downstream has to branch on that.
const securityEventSink = createSecurityEventSink({ database, logger });

// Object storage for assignment attachments. Null when the S3_* variables are absent, which is the
// normal state in development — the attachment endpoints then answer 503 rather than the process
// refusing to start over a feature the developer may not be touching.
const storage = createStorageService(env);

// Stripe billing adapter. Null when STRIPE_SECRET_KEY is absent — the checkout and webhook routes
// still register but answer 503 at request time.
const stripeProvider =
  env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? new StripeAdapter({
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      })
    : null;

const keyStore = new KeyStore(env.JWT_KEY_ROTATION_INTERVAL_MS, (kid) => {
  logger.info({ kid }, "jwt key rotated");
});
await keyStore.init();

const app = createApp({
  isReady: async () =>
    state.ready &&
    (await checkDatabase(database)) &&
    (await checkDatabase(readDatabase)) &&
    (await checkRedis(redis)),
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
  securityEventSink,
  storage,
  stripeProvider,
  // The reference site is a development and staging affordance. Production does not serve it: its
  // page loads a bundle from a CDN, and an API contract is not something production needs to render.
  docsEnabled: env.NODE_ENV !== "production",
  aiRerankEnabled: env.AI_RERANK_ENABLED,
});

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
});

logger.info(
  { host: server.hostname, port: server.port, database: database !== null, redis: redis !== null },
  "api listening",
);

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  void gracefulShutdown(server, {
    onStart: () => {
      state.ready = false;
      logger.info({ signal }, "draining in-flight requests");
    },
    tracker,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  }).then(async () => {
    keyStore.destroy();
    // Drains buffered security events. Must run before closeDatabase, which it writes through.
    await securityEventSink.close();
    await gradePublishedSubscriber?.close();
    await entitlementInvalidationSubscriber?.close();
    await closeRedis(redis);
    await closeDatabasePools(database, readDatabase);
    logger.info({ signal }, "shutdown complete");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
