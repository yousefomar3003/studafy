import { createApp } from "./app";
import { loadEnv } from "./env";
import { createInflightTracker, gracefulShutdown } from "./lifecycle";

// Fail fast: an invalid environment throws EnvValidationError here, before the server binds a port.
const env = loadEnv();

const state = { ready: true };
const tracker = createInflightTracker();
const app = createApp({ isReady: () => state.ready, tracker });

const server = Bun.serve({
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
});

console.log(`API listening on http://${server.hostname}:${server.port} (${env.NODE_ENV})`);

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  void gracefulShutdown(server, {
    onStart: () => {
      state.ready = false;
      console.log(`Received ${signal}, draining in-flight requests…`);
    },
    tracker,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  }).then(() => {
    console.log("Shutdown complete.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
