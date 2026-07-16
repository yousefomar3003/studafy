import { createApp } from "./app";
import { checkDatabase, closeDatabase, createDatabase } from "./database";
import { loadEnv } from "./env";
import { createInflightTracker, gracefulShutdown } from "./lifecycle";
import { createLogger } from "./logger";

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
const app = createApp({
  isReady: async () => state.ready && (await checkDatabase(database)),
  tracker,
  logger,
});

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
});

logger.info(
  { host: server.hostname, port: server.port, database: database !== null },
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
    await closeDatabase(database);
    logger.info({ signal }, "shutdown complete");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
