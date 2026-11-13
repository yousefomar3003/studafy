import IORedis from "ioredis";

import type { Env } from "./env";

/**
 * Redis connection factory for the pub/sub subscriber. `lazyConnect: true` defers the actual TCP
 * connection until first use, so constructing this object (e.g. in a test) never opens a socket
 * on its own. Once a connection issues `SUBSCRIBE`/`PSUBSCRIBE` it enters subscriber mode and can
 * no longer run ordinary commands (an ioredis/Redis constraint) — this connection must be used for
 * pub/sub only, never shared with request-path Redis calls.
 */
export function createRedisSubscriber(env: Pick<Env, "REDIS_URL">): IORedis {
  return new IORedis(env.REDIS_URL, { lazyConnect: true });
}
