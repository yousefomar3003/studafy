import type { RedisClient } from "../../redis";

/**
 * Redis-backed `jti` denylist — the revocation half of the authentication boundary.
 *
 * Access tokens are stateless by design: nothing is consulted to prove one is valid. That makes
 * verification fast but leaves no way to end a session early, so logout, a forced password reset,
 * or an admin kicking a compromised device would otherwise have to wait out the token's remaining
 * TTL. This denylist is the escape hatch: one flat key per revoked token id.
 *
 * Design constraints that shaped it:
 *
 * - **O(1) lookups.** One key per `jti`, checked with `EXISTS`. No set membership, no hash field
 *   scan, no pattern match — those all scale with the number of revoked tokens, and this runs on
 *   every authenticated request.
 * - **Self-pruning.** Each entry's TTL is the revoked token's own remaining lifetime. Once the
 *   token would have expired on its own, the denylist entry is worthless and Redis drops it, so
 *   the keyspace stays bounded by the access-token TTL rather than growing with logout volume.
 *
 * Deliberately not built on the helpers in src/cache.ts: those key everything under
 * `sch:{schoolId}:…` because they cache tenant data, whereas a `jti` is globally unique by
 * construction and a revocation check happens before any tenant is established.
 */

/** Key prefix for revoked token ids. One key per revoked `jti`. */
export const JTI_DENYLIST_PREFIX = "auth:jti:denylist:";

/** Build the Redis key for a token id. */
export function jtiDenylistKey(jti: string): string {
  return `${JTI_DENYLIST_PREFIX}${jti}`;
}

export interface JtiDenylist {
  /**
   * Whether this token id has been revoked.
   *
   * Rejects rather than resolving when Redis is unreachable — see the note on fail-closed
   * behaviour in createJtiDenylist.
   */
  isRevoked(jti: string): Promise<boolean>;

  /**
   * Revoke a token id until it would have expired anyway.
   *
   * @param jti             The token's `jti` claim.
   * @param expUnixSeconds  The token's `exp` claim, in seconds since the epoch.
   */
  revoke(jti: string, expUnixSeconds: number): Promise<void>;
}

export interface CreateJtiDenylistOptions {
  /** Override the clock for deterministic testing. Defaults to `Date.now()`. */
  now?: () => number;
}

/**
 * Build a denylist client over an existing Redis connection.
 *
 * **Failure behaviour is fail-closed**, and that is the opposite of the rate limiter next door
 * (src/middleware/rateLimiter.ts), which passes traffic through when Redis is down. The difference
 * is what each one protects: throttling is availability tooling, so failing open degrades
 * gracefully, whereas revocation is a security boundary — failing open there means every token
 * anyone has logged out of silently works again for as long as the outage lasts. The middleware
 * turns a thrown error into a 503, so a Redis outage becomes visible downtime rather than an
 * invisible authentication bypass.
 */
export function createJtiDenylist(
  redis: RedisClient,
  { now = () => Date.now() }: CreateJtiDenylistOptions = {},
): JtiDenylist {
  return {
    async isRevoked(jti: string): Promise<boolean> {
      return (await redis.exists(jtiDenylistKey(jti))) === 1;
    },

    async revoke(jti: string, expUnixSeconds: number): Promise<void> {
      const ttlSeconds = expUnixSeconds - Math.floor(now() / 1000);

      // An already-expired token needs no entry: verification rejects it on `exp` before the
      // denylist is ever consulted. Guarding here is also what keeps `SET … EX` well-formed —
      // Redis errors on a non-positive TTL.
      if (ttlSeconds <= 0) return;

      await redis.set(jtiDenylistKey(jti), "1", "EX", ttlSeconds);
    },
  };
}
