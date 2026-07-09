/**
 * Shutdown for the realtime gateway. Unlike apps/api (draining in-flight requests) or
 * apps/workers (waiting for active jobs), a WebSocket connection has no per-connection async work
 * to bound a wait around — sending a frame and closing a socket are both effectively immediate.
 * So shutdown here is unconditional, not timeout-bounded: mark not-ready, stop new fan-out, close
 * every open connection.
 */

/** Minimal surface of a tracked connection needed to close it — satisfied by Bun's raw socket. */
export interface CloseableClient {
  close(code?: number, reason?: string): void;
}

/** Tracks currently-open connections so shutdown can close all of them. */
export interface ConnectionTracker<Client extends CloseableClient = CloseableClient> {
  add(client: Client): void;
  remove(client: Client): void;
  size(): number;
  closeAll(code?: number, reason?: string): void;
}

export function createConnectionTracker<
  Client extends CloseableClient = CloseableClient,
>(): ConnectionTracker<Client> {
  const clients = new Set<Client>();

  return {
    add(client) {
      clients.add(client);
    },
    remove(client) {
      clients.delete(client);
    },
    size() {
      return clients.size;
    },
    closeAll(code, reason) {
      for (const client of clients) {
        client.close(code, reason);
      }
    },
  };
}

export interface GracefulShutdownOptions {
  /** Called first — flip readiness to not-ready and log. */
  onStart: () => void;
  /** Stops new Redis fan-out from reaching the (about to be closed) connections. */
  unsubscribe: () => Promise<void>;
  tracker: ConnectionTracker;
}

/**
 * Graceful shutdown: mark the gateway not-ready, stop new pub/sub fan-out, then close every open
 * connection. There is nothing to wait for beyond these three steps — see the module doc.
 */
export async function gracefulShutdown({
  onStart,
  unsubscribe,
  tracker,
}: GracefulShutdownOptions): Promise<void> {
  onStart();
  await unsubscribe();
  tracker.closeAll(1001, "server shutting down");
}
