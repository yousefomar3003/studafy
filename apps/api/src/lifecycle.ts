/**
 * Request lifecycle utilities for graceful shutdown: an in-flight request tracker and the
 * shutdown routine that stops accepting new connections and drains active ones.
 */

/** Tracks the number of in-flight requests and lets callers await a full drain. */
export interface InflightTracker {
  begin(): void;
  end(): void;
  inFlight(): number;
  /** Resolves when the in-flight count reaches zero, or after `timeoutMs` if provided. */
  onDrained(timeoutMs?: number): Promise<void>;
}

export function createInflightTracker(): InflightTracker {
  let count = 0;
  let waiters: (() => void)[] = [];

  const settle = () => {
    if (count === 0 && waiters.length > 0) {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) {
        resolve();
      }
    }
  };

  return {
    begin() {
      count += 1;
    },
    end() {
      count -= 1;
      settle();
    },
    inFlight() {
      return count;
    },
    onDrained(timeoutMs) {
      if (count === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        if (timeoutMs !== undefined) {
          setTimeout(resolve, timeoutMs);
        }
      });
    },
  };
}

/** Minimal surface of a running server needed for shutdown — satisfied by Bun's `Server`. */
export interface StoppableServer {
  stop(closeActiveConnections?: boolean): void;
}

export interface GracefulShutdownOptions {
  /** Called first, before connections stop — flip readiness to not-ready and log. */
  onStart: () => void;
  tracker: InflightTracker;
  /** Upper bound, in milliseconds, on how long to wait for in-flight requests to drain. */
  timeoutMs: number;
}

/**
 * Graceful shutdown: mark the service not-ready, stop accepting new connections, then wait for
 * in-flight requests to finish (bounded by `timeoutMs`).
 */
export async function gracefulShutdown(
  server: StoppableServer,
  { onStart, tracker, timeoutMs }: GracefulShutdownOptions,
): Promise<void> {
  onStart();
  server.stop();
  await tracker.onDrained(timeoutMs);
}
