import { createRedisConnection } from "./connection";
import { loadEnv } from "./env";
import { QUEUE_REGISTRY } from "./registry";
import { shutdownWorkers, startWorkers } from "./worker";

// Fail fast: an invalid environment throws EnvValidationError here, before any Redis connection opens.
const env = loadEnv();

const connection = createRedisConnection(env);
const workers = startWorkers(QUEUE_REGISTRY, connection);

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

  void shutdownWorkers(workers, env.SHUTDOWN_TIMEOUT_MS).then(() => {
    connection.disconnect();
    console.log("Shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
