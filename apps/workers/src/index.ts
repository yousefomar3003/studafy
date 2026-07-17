import postgres from "postgres";

import { createRedisConnection } from "./connection";
import { loadEnv } from "./env";
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
      logger: {
        info: (fields, msg) => console.log(JSON.stringify({ ...fields, msg })),
        warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg })),
        error: (fields, msg) => console.error(JSON.stringify({ ...fields, msg })),
      },
    });
  });
}

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

  void shutdownWorkers(workers, env.SHUTDOWN_TIMEOUT_MS).then(async () => {
    connection.disconnect();
    relayRedis.disconnect();
    await relayDb.end({ timeout: 5 });
    console.log("Shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
