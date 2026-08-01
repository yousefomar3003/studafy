/**
 * Cache stampede safety (ST-133 acceptance criterion).
 *
 * Many concurrent requests for the same cold key must trigger exactly one recomputation, not N. The
 * count is taken from a counting database pool rather than inferred from timing, because a timing
 * assertion would pass just as happily on a fast machine doing N queries.
 *
 * ## The bound this proves, stated honestly
 *
 * `singleFlight` is an in-process Map, not a Redis lock, so this is per-process de-duplication. With
 * M API pods a cold key costs M resolutions rather than N x M. That is the deliberate trade: the
 * resolver is a single indexed row read, and a distributed lock would add two Redis round trips plus
 * a lock-expiry failure mode to the authentication hot path to save one point lookup per pod.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { resetInflight } from "../../src/cache";
import { createLogger } from "../../src/logger";
import { entitlementCacheKey } from "../../src/modules/subscriptions/entitlements/cache";
import { createEntitlementService } from "../../src/modules/subscriptions/entitlements/service";
import { createRedisClient } from "../../src/redis";
import { createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { Database } from "../../src/db/client";
import type { RedisClient } from "../../src/redis";
import type { TestDatabase } from "../harness";

const redisUrl = process.env.REDIS_URL;
const enabled = integrationEnabled && Boolean(redisUrl);
const stampedeTest = test.skipIf(!enabled);

const CONCURRENT_REQUESTS = 50;

let db: TestDatabase | undefined;
let redis: RedisClient | undefined;
let schoolId: string;

const logger = createLogger({ destination: () => undefined });

beforeAll(async () => {
  if (!enabled) return;

  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  redis = createRedisClient({ url: redisUrl!, logger });

  schoolId = await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `stampede-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Stampede ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const id = school!.id;

    await tx`SELECT set_config('app.school_id', ${id}, true)`;
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES (${`plan_${slug.replaceAll("-", "_")}`}, 'Stampede Plan', true)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.subscriptions (school_id, plan_id, status, current_period_start, current_period_end)
      VALUES (
        ${id}::uuid, ${plan!.id}::uuid, 'active',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days'
      )
    `;
    return id;
  });
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await db?.cleanup();
});

afterEach(async () => {
  // The in-flight map is module-level; leaving an entry behind would let one test's flight satisfy
  // the next test's request and report a false pass.
  resetInflight();
  await redis?.del(entitlementCacheKey(schoolId));
});

/**
 * The real pool, wrapped so every `begin` is counted.
 *
 * Counting transactions rather than statements is the right granularity: the resolver opens exactly
 * one `withTenantTx` per recomputation, so the transaction count *is* the recomputation count.
 */
function countingDatabase(inner: Database): { database: Database; calls: () => number } {
  let calls = 0;
  const proxy = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "begin") {
        return (...args: unknown[]) => {
          calls += 1;
          return (target.begin as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Database;

  return { database: proxy, calls: () => calls };
}

describe("cache stampede", () => {
  stampedeTest("50 concurrent cold-key reads cause exactly one resolution", async () => {
    const counting = countingDatabase(db!.sql);
    const service = createEntitlementService({
      database: counting.database,
      redis: redis!,
      logger,
    });

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => service.school(schoolId)),
    );

    expect(results).toHaveLength(CONCURRENT_REQUESTS);
    // Every caller got a real answer, not a placeholder handed out to collapse the flight.
    for (const result of results) {
      expect(result.active).toBe(true);
      expect(result.schoolId).toBe(schoolId);
    }

    expect(counting.calls()).toBe(1);
  });

  stampedeTest("a warm key causes no resolution at all", async () => {
    const warming = createEntitlementService({ database: db!.sql, redis: redis!, logger });
    await warming.school(schoolId);
    resetInflight();

    const counting = countingDatabase(db!.sql);
    const service = createEntitlementService({
      database: counting.database,
      redis: redis!,
      logger,
    });

    await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => service.school(schoolId)));

    expect(counting.calls()).toBe(0);
  });

  // currentVersion is the JWT middleware's entry point and the hottest path in the system. A cold key
  // must not let a burst of authenticated requests each open their own transaction.
  stampedeTest("concurrent currentVersion reads on a cold key resolve once", async () => {
    const counting = countingDatabase(db!.sql);
    const service = createEntitlementService({
      database: counting.database,
      redis: redis!,
      logger,
    });

    const versions = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => service.currentVersion(schoolId)),
    );

    // No subscription change has happened, so every caller sees the genesis version.
    expect(new Set(versions)).toEqual(new Set([1]));
    expect(counting.calls()).toBe(1);
  });
});
