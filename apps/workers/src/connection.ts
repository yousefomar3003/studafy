import IORedis from "ioredis";

import type { Env } from "./env";

/**
 * BullMQ's connection factory. Two options are non-negotiable for BullMQ:
 * - `maxRetriesPerRequest: null` — BullMQ blocks on Redis commands (e.g. `BRPOPLPUSH`) and runs
 *   its own retry/backoff loop; ioredis's per-request retry limit conflicts with that and BullMQ
 *   refuses to start without this being disabled.
 * - `enableReadyCheck: true` (default) — a broken connection surfaces as an error instead of
 *   silently queueing commands.
 *
 * `lazyConnect: true` defers the actual TCP connection until first use, so constructing this
 * object (e.g. in a factory or a test) never opens a socket on its own.
 */
export function createRedisConnection(env: Pick<Env, "REDIS_URL">): IORedis {
  return new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}
