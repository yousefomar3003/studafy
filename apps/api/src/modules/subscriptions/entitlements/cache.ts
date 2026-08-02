import type { RedisClient } from "../../../redis";

/**
 * The entitlement cache (ST-133).
 *
 * ## Keys
 *
 * `ent:{schoolId}` and `ent:ai:{studentId}`, exactly as the ticket specifies.
 *
 * Deliberately not built on the helpers in src/cache.ts, and for the same reason
 * modules/auth/denylist.ts is not: `cacheKey()` hard-codes a `sch:{schoolId}:` prefix and returns a
 * branded `CacheKey` that `getCache`/`setCache` accept exclusively, so those keys are simply not
 * producible through it. Widening `cacheKey` with a second, unprefixed constructor was rejected --
 * the brand is the mechanism that stops an unscoped key leaking across tenants, and a constructor
 * that also returned `CacheKey` would defeat it for the whole codebase, making the safe path and the
 * unsafe path the same function.
 *
 * ## Encoding: `<version>|<json>`
 *
 * A plain cache-aside DEL has the classic stale-set race: a reader that queried the database *before*
 * the webhook committed can `SET` its now-stale value *after* the invalidation, pinning a wrong
 * entitlement for the full TTL. The window is milliseconds; the consequence is a silent 60x breach of
 * the propagation SLA.
 *
 * So every entry carries the version it was computed at, and both writes are compare-and-set inside
 * Lua -- the same technique already shipped in modules/grades/published/cache.ts. A racing reader
 * holding an older version fails the CAS: it still returns its own value to its own request, which was
 * correct at read time, but it cannot pollute the cache for anyone else.
 *
 * Invalidation writes a *floor marker* (`<version>|` with an empty body) rather than deleting. Two
 * things fall out of that. Readers treat an empty body as a miss, so the next request re-resolves.
 * And the JWT middleware -- which only ever needs the version -- sees the new value immediately,
 * without waiting for anyone to run the full resolver against Postgres.
 *
 * Every write sets a TTL. Redis runs `maxmemory-policy=noeviction` (docs/runbooks/redis-conventions.md),
 * so a key without one is a permanent leak.
 */

/**
 * How long a resolved entitlement may sit in the cache.
 *
 * This is a backstop, not the SLA. The propagation guarantee comes from the invalidation consumers;
 * this bounds how wrong the cache can get if every one of them is broken at once.
 */
export const ENTITLEMENT_CACHE_TTL_SECONDS = 300;

export function entitlementCacheKey(schoolId: string): string {
  return `ent:${schoolId}`;
}

export function aiEntitlementCacheKey(studentId: string): string {
  return `ent:ai:${studentId}`;
}

/**
 * Write only if the stored entry is absent or not newer.
 *
 * ARGV[1] incoming version, ARGV[2] JSON body, ARGV[3] TTL seconds.
 * Returns 1 when written, 0 when a newer entry was already present.
 */
const SET_IF_NEWER = `
local current = redis.call("GET", KEYS[1])
if current then
  local sep = string.find(current, "|", 1, true)
  if sep then
    local stored = tonumber(string.sub(current, 1, sep - 1))
    if stored and stored > tonumber(ARGV[1]) then return 0 end
  end
end
redis.call("SET", KEYS[1], ARGV[1] .. "|" .. ARGV[2], "EX", ARGV[3])
return 1
`;

/**
 * Raise the entry to a version floor, discarding its body.
 *
 * ARGV[1] new version, ARGV[2] TTL seconds. Returns 1 when the floor moved, 0 when the stored entry
 * was already at or above it -- which is what makes running two consumers over the same event a
 * provable no-op rather than a race.
 */
const INVALIDATE_TO_FLOOR = `
local current = redis.call("GET", KEYS[1])
if current then
  local sep = string.find(current, "|", 1, true)
  if sep then
    local stored = tonumber(string.sub(current, 1, sep - 1))
    if stored and stored >= tonumber(ARGV[1]) then return 0 end
  end
end
redis.call("SET", KEYS[1], ARGV[1] .. "|", "EX", ARGV[2])
return 1
`;

export interface CachedEntry<T> {
  version: number;
  /** `null` for a floor marker: the version is known, the body must be re-resolved. */
  value: T | null;
}

function decodeEntry<T>(raw: string | null): CachedEntry<T> | null {
  if (raw === null) return null;

  const separator = raw.indexOf("|");
  if (separator === -1) return null;

  const version = Number(raw.slice(0, separator));
  if (!Number.isFinite(version)) return null;

  const body = raw.slice(separator + 1);
  if (body.length === 0) return { version, value: null };

  try {
    return { version, value: JSON.parse(body) as T };
  } catch {
    // A body we cannot parse is treated as a miss rather than an error: the resolver is always able
    // to answer, and failing the request over a corrupt cache entry would turn a cosmetic problem
    // into an outage.
    return { version, value: null };
  }
}

export async function readEntitlementEntry<T>(
  redis: RedisClient,
  key: string,
): Promise<CachedEntry<T> | null> {
  return decodeEntry<T>(await redis.get(key));
}

/**
 * Read the school entry and one student's AI entry in a single round trip.
 *
 * Together, because the AI verdict is only trustworthy against a known school version -- see
 * `AiEntitlement.schoolVersion`.
 */
export async function readEntitlementPair<S, A>(
  redis: RedisClient,
  schoolKey: string,
  aiKey: string,
): Promise<{ school: CachedEntry<S> | null; ai: CachedEntry<A> | null }> {
  const [schoolRaw, aiRaw] = await redis.mget(schoolKey, aiKey);
  return {
    school: decodeEntry<S>(schoolRaw ?? null),
    ai: decodeEntry<A>(aiRaw ?? null),
  };
}

/** @returns true when the value was written, false when a newer entry won. */
export async function writeEntitlementEntryIfNewer(
  redis: RedisClient,
  key: string,
  version: number,
  value: unknown,
): Promise<boolean> {
  const result = await redis.eval(
    SET_IF_NEWER,
    1,
    key,
    String(version),
    JSON.stringify(value),
    String(ENTITLEMENT_CACHE_TTL_SECONDS),
  );
  return Number(result) === 1;
}

/** @returns true when the floor moved, false when the entry was already at or above `version`. */
export async function invalidateEntitlementEntry(
  redis: RedisClient,
  key: string,
  version: number,
): Promise<boolean> {
  const result = await redis.eval(
    INVALIDATE_TO_FLOOR,
    1,
    key,
    String(version),
    String(ENTITLEMENT_CACHE_TTL_SECONDS),
  );
  return Number(result) === 1;
}
