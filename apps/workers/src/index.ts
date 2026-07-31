import postgres from "postgres";

import { createRedisConnection } from "./connection";
import { databaseUrlFrom, loadEnv } from "./env";
import { workerLogger } from "./log";
import {
  createSesSender,
  scheduleDigestJob,
  startEmailDispatcher,
  TokenBucket,
} from "./queues/notifications/email";
import { startRelay } from "./queues/outbox-relay";
import { QUEUE_REGISTRY } from "./registry";
import { shutdownWorkers, startWorkers } from "./worker";

import type { RelayHandle } from "./queues/outbox-relay/relay";

// Fail fast: an invalid environment throws EnvValidationError here, before any Redis connection opens.
const env = loadEnv();

const connection = createRedisConnection(env);
const workers = startWorkers(QUEUE_REGISTRY, connection);

// Outbox relay: separate polling loop alongside BullMQ workers. Uses its own postgres and Redis
// connections because the BullMQ connection is tied to the queue DB and the relay needs pub/sub.
const schoolIds = env.SCHOOL_IDS.split(",").filter(Boolean);
const relayDb = postgres(env.DATABASE_URL, { max: 2, idle_timeout: 20, prepare: false });
const relayRedis = createRedisConnection(env);

let relayHandle: RelayHandle | null = null;

if (schoolIds.length > 0) {
  void relayRedis.connect().then(() => {
    relayHandle = startRelay({
      db: relayDb,
      redis: relayRedis,
      config: { batchSize: 100, pollIntervalMs: 1_000, schoolIds },
      logger: workerLogger,
    });
  });
}

// Email channel: a second polling loop that consumes email-relevant outbox events directly, on its
// own postgres pool, pacing sends through an in-process token bucket. databaseUrlFrom() — not the
// raw DATABASE_URL default — so a deployed worker honours the discrete production DB settings.
const emailDb = postgres(databaseUrlFrom(env), { max: 4, idle_timeout: 20, prepare: false });
const emailLogger = {
  info: (fields: Record<string, unknown>, msg: string) =>
    console.log(JSON.stringify({ ...fields, msg })),
  warn: (fields: Record<string, unknown>, msg: string) =>
    console.warn(JSON.stringify({ ...fields, msg })),
  error: (fields: Record<string, unknown>, msg: string) =>
    console.error(JSON.stringify({ ...fields, msg })),
};
const emailDispatcher = startEmailDispatcher({
  db: emailDb,
  sender: createSesSender(env, emailLogger),
  limiter: new TokenBucket(env.EMAIL_MAX_RATE_PER_SECOND),
  config: {
    batchSize: env.EMAIL_BATCH_SIZE,
    pollIntervalMs: env.EMAIL_POLL_INTERVAL_MS,
    ratePerSecond: env.EMAIL_MAX_RATE_PER_SECOND,
    frontendUrl: env.FRONTEND_URL,
  },
  logger: emailLogger,
});

// Digest scheduler: idempotently register the daily 06:00 parent-digest on the notifications
// queue. Its own Redis connection so the upsert never contends with worker polling.
const digestRedis = createRedisConnection(env);
void scheduleDigestJob(digestRedis).then(() => digestRedis.disconnect());

console.log(
  `Workers started for queues: ${QUEUE_REGISTRY.map((definition) => definition.name).join(", ")} (${env.NODE_ENV})`,
);

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`Received ${signal}, waiting for active jobs to finish…`);

  relayHandle?.stop();
  emailDispatcher.stop();

  void shutdownWorkers(workers, env.SHUTDOWN_TIMEOUT_MS).then(async () => {
    connection.disconnect();
    relayRedis.disconnect();
    await relayDb.end({ timeout: 5 });
    await emailDb.end({ timeout: 5 });
    console.log("Shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
