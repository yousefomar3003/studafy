/**
 * The entitlement cache's key contract and version guards (ST-133).
 *
 * Gated on REDIS_URL rather than TEST_REDIS_URL: CI sets only the former, and the auth suites that
 * use the latter consequently self-skip there. These assertions are worth actually running.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { createLogger } from "../../src/logger";
import {
  ENTITLEMENT_CACHE_TTL_SECONDS,
  aiEntitlementCacheKey,
  entitlementCacheKey,
  invalidateEntitlementEntry,
  readEntitlementEntry,
  readEntitlementPair,
  writeEntitlementEntryIfNewer,
} from "../../src/modules/subscriptions/entitlements/cache";
import { createRedisClient } from "../../src/redis";

import type { RedisClient } from "../../src/redis";

const redisUrl = process.env.REDIS_URL;
const redisTest = test.skipIf(!redisUrl);

let redis: RedisClient | undefined;
const schoolId = "11111111-1111-4111-8111-111111111111";
const studentId = "22222222-2222-4222-8222-222222222222";

beforeAll(() => {
  if (!redisUrl) return;
  redis = createRedisClient({
    url: redisUrl,
    logger: createLogger({ destination: () => undefined }),
  });
});

afterAll(() => {
  redis?.disconnect();
});

afterEach(async () => {
  if (!redis) return;
  await redis.del(entitlementCacheKey(schoolId), aiEntitlementCacheKey(studentId));
});

describe("key contract", () => {
  // The ticket names these keys exactly. src/cache.ts's cacheKey() cannot produce them — it
  // hard-codes a `sch:{schoolId}:` prefix — so this guards against someone "fixing" the bypass by
  // routing these through the branded helper and silently changing the key namespace.
  redisTest("writes exactly ent:{schoolId} and ent:ai:{studentId}", async () => {
    expect(entitlementCacheKey(schoolId)).toBe(`ent:${schoolId}`);
    expect(aiEntitlementCacheKey(studentId)).toBe(`ent:ai:${studentId}`);

    await writeEntitlementEntryIfNewer(redis!, entitlementCacheKey(schoolId), 2, { active: true });
    await writeEntitlementEntryIfNewer(redis!, aiEntitlementCacheKey(studentId), 2, {
      active: false,
    });

    expect(await redis!.exists(`ent:${schoolId}`)).toBe(1);
    expect(await redis!.exists(`ent:ai:${studentId}`)).toBe(1);
  });

  // Redis runs maxmemory-policy=noeviction, so a key without a TTL is a permanent leak.
  redisTest("every write carries a TTL", async () => {
    await writeEntitlementEntryIfNewer(redis!, entitlementCacheKey(schoolId), 2, { active: true });
    const writeTtl = await redis!.ttl(entitlementCacheKey(schoolId));
    expect(writeTtl).toBeGreaterThan(0);
    expect(writeTtl).toBeLessThanOrEqual(ENTITLEMENT_CACHE_TTL_SECONDS);

    await invalidateEntitlementEntry(redis!, aiEntitlementCacheKey(studentId), 5);
    const floorTtl = await redis!.ttl(aiEntitlementCacheKey(studentId));
    expect(floorTtl).toBeGreaterThan(0);
    expect(floorTtl).toBeLessThanOrEqual(ENTITLEMENT_CACHE_TTL_SECONDS);
  });
});

describe("version guards", () => {
  redisTest("a newer entry is not overwritten by an older write", async () => {
    const key = entitlementCacheKey(schoolId);

    expect(await writeEntitlementEntryIfNewer(redis!, key, 5, { marker: "v5" })).toBe(true);
    // The stale-set race: a reader that queried the database before the webhook committed, writing
    // back after the invalidation landed.
    expect(await writeEntitlementEntryIfNewer(redis!, key, 2, { marker: "v2" })).toBe(false);

    const entry = await readEntitlementEntry<{ marker: string }>(redis!, key);
    expect(entry?.version).toBe(5);
    expect(entry?.value?.marker).toBe("v5");
  });

  redisTest("an equal-version write wins, so a re-resolve can refresh the body", async () => {
    const key = entitlementCacheKey(schoolId);

    await writeEntitlementEntryIfNewer(redis!, key, 4, { marker: "first" });
    expect(await writeEntitlementEntryIfNewer(redis!, key, 4, { marker: "second" })).toBe(true);

    const entry = await readEntitlementEntry<{ marker: string }>(redis!, key);
    expect(entry?.value?.marker).toBe("second");
  });

  // Invalidation keeps the key present with a known version but no body. That is what lets the JWT
  // middleware see the new version immediately without anyone re-running the resolver.
  redisTest("invalidation leaves a readable version floor with no body", async () => {
    const key = entitlementCacheKey(schoolId);

    await writeEntitlementEntryIfNewer(redis!, key, 2, { active: true });
    expect(await invalidateEntitlementEntry(redis!, key, 3)).toBe(true);

    const entry = await readEntitlementEntry<{ active: boolean }>(redis!, key);
    expect(entry?.version).toBe(3);
    expect(entry?.value).toBeNull();
  });

  // Why running the pub/sub subscriber and the workers poller together is safe.
  redisTest("a repeated invalidation at the same version is a no-op", async () => {
    const key = entitlementCacheKey(schoolId);

    expect(await invalidateEntitlementEntry(redis!, key, 7)).toBe(true);
    expect(await invalidateEntitlementEntry(redis!, key, 7)).toBe(false);
    expect(await invalidateEntitlementEntry(redis!, key, 6)).toBe(false);

    const entry = await readEntitlementEntry(redis!, key);
    expect(entry?.version).toBe(7);
  });

  redisTest("a write below an invalidation floor is refused", async () => {
    const key = entitlementCacheKey(schoolId);

    await invalidateEntitlementEntry(redis!, key, 9);
    expect(await writeEntitlementEntryIfNewer(redis!, key, 8, { stale: true })).toBe(false);

    const entry = await readEntitlementEntry(redis!, key);
    expect(entry?.version).toBe(9);
    expect(entry?.value).toBeNull();
  });
});

describe("paired read", () => {
  redisTest("returns both entries and a miss as null", async () => {
    await writeEntitlementEntryIfNewer(redis!, entitlementCacheKey(schoolId), 3, { active: true });

    const pair = await readEntitlementPair<{ active: boolean }, { active: boolean }>(
      redis!,
      entitlementCacheKey(schoolId),
      aiEntitlementCacheKey(studentId),
    );

    expect(pair.school?.version).toBe(3);
    expect(pair.ai).toBeNull();
  });
});
