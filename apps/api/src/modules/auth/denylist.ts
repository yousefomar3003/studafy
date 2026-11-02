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

  /**
   * Revoke many token ids in one round trip.
   *
   * A global logout for a user with sessions on a laptop, a phone, and a tablet has as many
   * outstanding access tokens as it has live token families, and issuing a separate SET per token
   * would pay the network round trip once each — the dominant cost, since each command itself is
   * O(1). Pipelining collapses that into a single trip regardless of N, which is what keeps an
   * administrative "revoke all devices" inside the propagation budget on an account with many
   * sessions.
   *
   * Entries whose expiry has already passed are skipped, not rejected: a batch assembled from a
   * revocation query legitimately contains tokens that aged out between the UPDATE and this call,
   * and there is nothing to denylist about a token verification already refuses on `exp`.
   *
   * @returns How many entries were actually written.
   */
  revokeMany(entries: readonly DenylistEntry[]): Promise<number>;
}

/** One access token to deny: its `jti` claim and the `exp` that bounds the entry's lifetime. */
export interface DenylistEntry {
  jti: string;
  expUnixSeconds: number;
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

    async revokeMany(entries: readonly DenylistEntry[]): Promise<number> {
      const nowSeconds = Math.floor(now() / 1000);

      // Filtered before anything is allocated, so a batch of nothing-but-expired entries costs a
      // loop and no more. Queuing into the pipeline first and then declining to exec() it would be
      // equivalent on the wire, but it builds a command buffer for a call that was never going to
      // send one — and exec() on an empty pipeline resolves to null in ioredis, which the error
      // check below would then have to treat as success rather than as the failure it signals.
      const live: { key: string; ttlSeconds: number }[] = [];
      for (const { jti, expUnixSeconds } of entries) {
        const ttlSeconds = expUnixSeconds - nowSeconds;
        if (ttlSeconds <= 0) continue;
        live.push({ key: jtiDenylistKey(jti), ttlSeconds });
      }

      if (live.length === 0) return 0;

      const pipeline = redis.pipeline();
      for (const { key, ttlSeconds } of live) {
        pipeline.set(key, "1", "EX", ttlSeconds);
      }

      const results = await pipeline.exec();

      // ioredis reports per-command failures inside the results array instead of rejecting, so a
      // pipeline that "succeeded" can still contain errors. Surfacing the first one matters here for
      // the reason createJtiDenylist documents above: this is a security boundary, and a revocation
      // that silently failed to land leaves a token the caller has been told is dead still working.
      // The service layer turns this into a 503 rather than reporting a successful teardown.
      if (results === null) {
        throw new Error("denylist pipeline returned no result");
      }
      for (const [error] of results) {
        if (error) throw error;
      }

      return live.length;
    },
  };
}
