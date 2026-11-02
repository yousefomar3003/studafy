import type { RedisClient } from "./redis";

/**
 * Cache utilities for the API layer. Provides type-safe, tenant-prefixed key construction,
 * JSON serialization with TTLs, and a single-flight mechanism to prevent cache dogpiling.
 *
 * ## Key convention
 *
 * All cache keys are scoped to a tenant (school) using the pattern:
 *
 *     sch:{school_id}:{resource}:{id}:{subkey}
 *
 * The {@link cacheKey} function enforces this structure at the TypeScript type level via a
 * branded type: only keys produced by `cacheKey()` are accepted by `getCache` / `setCache`.
 * This prevents accidental use of unscoped keys that would leak across tenant boundaries.
 *
 * ## Single-flight (dogpile protection)
 *
 * When a cache miss occurs and multiple concurrent requests try to populate the same key, only
 * the first request executes the upstream query. All others await the same in-flight promise.
 * After the promise settles (resolve or reject), it is removed from the in-flight map so the
 * next miss triggers a fresh fetch.
 *
 * @see docs/cache-key-conventions.md for naming standards and examples.
 */

// ---------------------------------------------------------------------------
// Branded CacheKey type
// ---------------------------------------------------------------------------

declare const __cacheKeyBrand: unique symbol;

/**
 * A cache key that has been validated to follow the `sch:{school_id}:{...}` convention.
 *
 * This is a branded type: plain strings cannot be assigned to `CacheKey`. The only way to
 * obtain a `CacheKey` is through the {@link cacheKey} function, which guarantees the prefix
 * structure at runtime.
 */
export type CacheKey = string & { readonly [__cacheKeyBrand]: never };

/**
 * Construct a tenant-scoped cache key. The result carries the branded `CacheKey` type, so only
 * keys produced here can be passed to `getCache` / `setCache`.
 *
 * @param schoolId  The tenant identifier (school ID).
 * @param parts     One or more key segments (resource, id, subkey, …).
 * @returns A branded `CacheKey` of the form `sch:{schoolId}:{parts[0]}:{parts[1]}:…`
 *
 * @example
 * ```typescript
 * const key = cacheKey("sch_abc", "session", "usr_123");
 * // → "sch:sch_abc:session:usr_123"
 * ```
 */
export function cacheKey(schoolId: string, ...parts: string[]): CacheKey {
  if (!schoolId) {
    throw new Error("cacheKey: schoolId is required");
  }
  if (parts.length === 0) {
    throw new Error("cacheKey: at least one key segment is required after schoolId");
  }
  for (const part of parts) {
    if (!part) {
      throw new Error("cacheKey: key segments must not be empty");
    }
  }
  return `sch:${schoolId}:${parts.join(":")}` as CacheKey;
}

// ---------------------------------------------------------------------------
// JSON get / set
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached value by key and deserialize it from JSON. Returns `null` when the key does
 * not exist or the value has expired.
 *
 * @typeParam T  The expected type of the deserialized value.
 */
export async function getCache<T>(client: RedisClient, key: CacheKey): Promise<T | null> {
  const raw = await client.get(key);
  if (raw === null) return null;
  return JSON.parse(raw) as T;
}

/**
 * Serialize a value to JSON and store it in Redis with a TTL. The TTL is mandatory to comply
 * with the `noeviction` Redis policy: every cache key must expire or be explicitly deleted.
 *
 * @param value       The value to cache (will be JSON-serialized).
 * @param ttlSeconds  Time-to-live in seconds. Must be a positive integer.
 */
export async function setCache(
  client: RedisClient,
  key: CacheKey,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  if (ttlSeconds <= 0) {
    throw new Error("setCache: ttlSeconds must be a positive integer");
  }
  await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

// ---------------------------------------------------------------------------
// Single-flight (dogpile / stampede protection)
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<unknown>>();

/**
 * Ensure that concurrent calls for the same key execute `fn` only once. The first caller
 * creates the promise and stores it; subsequent callers receive the same promise. After the
 * promise settles (resolve or reject), it is removed from the map so the next miss is fresh.
 *
 * This prevents cache dogpiling: when a popular key expires, N simultaneous cache misses no
 * longer produce N upstream queries — only one.
 *
 * @typeParam T  The return type of `fn`.
 * @param key    A unique identifier for the in-flight operation (typically the cache key).
 * @param fn     The upstream function to call on a cache miss.
 * @returns The result of `fn`. All callers for the same `key` receive the same promise.
 *
 * @example
 * ```typescript
 * const user = await singleFlight(`sch:${schoolId}:user:${userId}`, () =>
 *   db.query("SELECT * FROM users WHERE id = $1", [userId]),
 * );
 * ```
 */
export async function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing !== undefined) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

/**
 * Exposed for testing only. Clears all in-flight promises. Call this in test teardown to avoid
 * cross-test contamination when using the module-level map.
 */
export function resetInflight(): void {
  inflight.clear();
}
