import { checkDatabase } from "./db";
import { checkRedis } from "./redis";

import type { Database } from "./db";
import type { StorageService } from "./lib/storage";
import type { RedisClient } from "./redis";

/**
 * Readiness probe for the API service.
 *
 * Owns everything `/readyz` depends on — the databases, Redis, and object storage — so
 * `health.ts` (the route) stays dependency-free and `index.ts` (the composition root) only has to
 * hand the instances over. It is deliberately separate from the route: the route answers "should
 * the load balancer route here", and this module answers "are the dependencies usable", which the
 * route must never have to reason about.
 *
 * The whole probe is bounded by {@link ReadinessProbeOptions.timeoutMs}. Each individual check can
 * hang for reasons its own client cannot bound (a busted pool slot, an ioredis command retrying in
 * the offline queue), so the deadline is what guarantees the acceptance criterion that readiness
 * flips within a fixed window (READINESS_TIMEOUT_MS, capped at 10s). On deadline the probe reports
 * not-ready; the slow checks are abandoned, not cancelled — they are idempotent reads.
 *
 * Null dependencies count as healthy, mirroring checkRedis()/checkDatabase(): the absence of an
 * optional dependency is not an outage. Storage is checked via the service's own `check()` (a
 * HeadBucket round trip) so this module never has to know the S3 client shape.
 */
export interface ReadinessProbeOptions {
  database: Database | null;
  readDatabase: Database | null;
  redis: RedisClient | null;
  storage: StorageService | null;
  /** Upper bound on the whole probe in milliseconds. Timeout reports not-ready. */
  timeoutMs: number;
}

export function createReadinessProbe({
  database,
  readDatabase,
  redis,
  storage,
  timeoutMs,
}: ReadinessProbeOptions): () => Promise<boolean> {
  const checks: (() => Promise<boolean>)[] = [
    () => checkDatabase(database),
    () => checkDatabase(readDatabase),
    () => checkRedis(redis),
    () => (storage ? storage.check() : Promise.resolve(true)),
  ];

  return async () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });

    const results = Promise.all(checks.map((run) => run())).then((all) => all.every(Boolean));
    return Promise.race([results, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
}
