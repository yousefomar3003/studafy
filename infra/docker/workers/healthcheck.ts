// apps/workers exposes no HTTP or IPC surface (it's a BullMQ queue consumer, not a service), so
// there is no endpoint to probe for a Docker HEALTHCHECK. What actually threatens this process is
// its one external dependency going unreachable, so this opens its own raw TCP connection to
// REDIS_URL and exits 0/1 on whether that succeeds within a short timeout.
//
// This does not reuse the worker's own ioredis connection object — it is an independent probe of
// the same dependency, the same pattern most HEALTHCHECK scripts use to verify a required backing
// service is reachable, rather than introspecting a specific in-process connection's state.
const TIMEOUT_MS = 2000;

const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const port = Number(url.port) || 6379;

const timer = setTimeout(() => {
  console.error(`redis healthcheck: timed out connecting to ${url.hostname}:${port}`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  await Bun.connect({
    hostname: url.hostname,
    port,
    socket: {
      open(socket) {
        clearTimeout(timer);
        socket.end();
        process.exit(0);
      },
      data() {
        // Unused: the connection succeeding is the entire signal this probe needs.
      },
      error(_socket, error) {
        clearTimeout(timer);
        console.error(`redis healthcheck: ${error.message}`);
        process.exit(1);
      },
    },
  });
} catch (error) {
  clearTimeout(timer);
  console.error(`redis healthcheck: ${(error as Error).message}`);
  process.exit(1);
}
