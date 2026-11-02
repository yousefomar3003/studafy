import IORedis from "ioredis";

import type { Logger } from "./logger";

/**
 * Resilient Redis client factory for the API cache layer (DB 0). Follows the same `createXxx`
 * pattern as `createDatabase` — a pure factory with no module-level side effects.
 *
 * TLS is handled automatically by ioredis when the URL scheme is `rediss://`. The connection
 * defers the TCP handshake until the first command (`lazyConnect: true`), so constructing this
 * object in tests never opens a socket.
 *
 * Reconnection uses exponential backoff (200 ms × attempt, capped at 5 s) and stops after 20
 * failed attempts. The `enableReadyCheck` flag verifies the connection is usable after a
 * reconnect, preventing stale connections from silently failing on the first command.
 *
 * @see docs/runbooks/redis-conventions.md for infra-level Redis conventions (DB assignment, TLS,
 *      eviction policy, failover).
 */

export type RedisClient = IORedis;

export interface CreateRedisClientOptions {
  url: string;
  logger: Logger;
}

export function createRedisClient({ url, logger }: CreateRedisClientOptions): RedisClient {
  const log = logger.child({ component: "redis" });

  const client = new IORedis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    retryStrategy(times) {
      if (times > 20) {
        // Stop reconnecting after 20 failed attempts — a full minute of failures means
        // something is fundamentally wrong, not a transient blip.
        return null;
      }
      // Exponential backoff: 200 ms, 400 ms, 600 ms, … capped at 5 s.
      const delay = Math.min(times * 200, 5_000);
      log.warn({ attempt: times, delay_ms: delay }, "reconnecting");
      return delay;
    },
  });

  client.on("connect", () => log.info("connected"));
  client.on("ready", () => log.info("ready"));
  client.on("error", (err) => log.error({ err }, "connection error"));
  client.on("close", () => log.warn("connection closed"));

  return client;
}

/**
 * Ping the Redis server to verify connectivity. Returns `true` when the server responds with
 * `PONG`, `false` on any error (connection refused, timeout, etc.).
 *
 * Safe to call on a `null` client (returns `true` — the absence of Redis is not an error when
 * caching is optional).
 */
export async function checkRedis(client: RedisClient | null): Promise<boolean> {
  if (!client) return true;
  try {
    return (await client.ping()) === "PONG";
  } catch {
    return false;
  }
}

/**
 * Gracefully close the Redis connection. Waits for pending commands to flush before disconnecting.
 * Safe to call on a `null` client.
 */
export async function closeRedis(client: RedisClient | null): Promise<void> {
  if (!client) return;
  await client.quit();
}
