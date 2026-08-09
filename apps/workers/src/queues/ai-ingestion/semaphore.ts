/**
 * Per-tenant concurrency gate for AI ingestion (ST-161).
 *
 * The ai-ingestion queue's BullMQ `concurrency` bounds jobs per worker process, but a school is a
 * cluster-wide resource: its embedding spend is metered per material, and an over-subscribed school
 * would swamp the shared Redis-backed queue for every other school on the same workers. The
 * acceptance criteria for ST-161 call for a per-tenant cap, so the worker takes a slot per school
 * before it claims a material, from a distributed semaphore keyed on `school_id`.
 *
 * The semaphore is a Redis sorted set, one member per active slot, scored by lease expiry:
 *
 *   ai-ingestion:leases:<schoolId>  member = token (uuid), score = now + leaseMs
 *
 * `acquire` runs a single Lua script: it prunes expired members, admits the caller when the live
 * count is below the cap, and renews the key's TTL. Because each slot is a distinct member carrying
 * its own token, a `release` can remove only the caller's own lease — the drift failure mode of a
 * plain INCR/DECR counter (a stale release decrementing a slot re-leased to someone else) is
 * structurally impossible. A member whose lease expired is dropped by the next acquire's prune, so
 * a hung or crashed worker stops counting against its school once the lease lapses, with no timeout
 * sweep needed.
 *
 * No cap when the queue runs without a semaphore (dev/test): {@link nullSemaphore} grants every
 * request, which is also what the worker's own unit tests inject.
 */

import { randomUUID } from "node:crypto";

import type IORedis from "ioredis";

/** How long a slot is held before a crashed worker's lease lapses. Longer than any real ingestion. */
export const TENANT_SEMAPHORE_LEASE_MS = 30 * 60 * 1000;
/** The counter key's TTL is the lease plus this buffer, so live members never expire the key. */
const KEY_TTL_BUFFER_MS = 60 * 1000;

/**
 * The worker throws this when the school's cap is reached. The throw makes BullMQ retry with the
 * job's exponential backoff; on the terminal attempt the failure path records it in `ingest_error`
 * as a scheduling failure rather than an ingestion failure.
 */
export class TenantConcurrencyExceededError extends Error {
  constructor(schoolId: string) {
    super(`per-tenant ingestion concurrency cap reached for school ${schoolId}`);
    this.name = "TenantConcurrencyExceededError";
  }
}

/** A held slot. Calling `release` twice is safe: the second removal is a no-op. */
export interface TenantSemaphoreLease {
  release(): Promise<void>;
}

export interface TenantSemaphore {
  /**
   * Try to take a slot for `schoolId`. Resolves to a lease when admitted, or `null` when the
   * school's cap is already full — the caller decides between retry (via backoff) and failure.
   */
  acquire(schoolId: string): Promise<TenantSemaphoreLease | null>;
}

/** The no-op semaphore: no Redis configured, no cap. Used in dev/test. */
export const nullSemaphore: TenantSemaphore = {
  async acquire() {
    return {
      async release() {
        /* nothing held */
      },
    };
  },
};

const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local token = ARGV[1]
local cap = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local nowMs = redis.call('TIME')
nowMs = tonumber(nowMs[1]) * 1000 + math.floor(tonumber(nowMs[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs)
if redis.call('ZCARD', key) < cap then
  redis.call('ZADD', key, nowMs + leaseMs, token)
  redis.call('PEXPIRE', key, leaseMs + ${KEY_TTL_BUFFER_MS})
  return 1
end
return 0
`;

export interface TenantSemaphoreOptions {
  /** The Redis client the semaphore shares. Must be connected before the first acquire. */
  redis: IORedis;
  /** At most this many concurrent ingestion jobs per school across the whole worker fleet. */
  maxConcurrencyPerSchool: number;
  /** Slot lease duration; injectable so tests can lapse leases without waiting 30 minutes. */
  leaseMs?: number;
}

export function createTenantSemaphore(options: TenantSemaphoreOptions): TenantSemaphore {
  const { redis, maxConcurrencyPerSchool } = options;
  const leaseMs = options.leaseMs ?? TENANT_SEMAPHORE_LEASE_MS;

  return {
    async acquire(schoolId) {
      const token = randomUUID();
      const key = `ai-ingestion:leases:${schoolId}`;
      const granted = await redis.eval(
        ACQUIRE_SCRIPT,
        1,
        key,
        token,
        maxConcurrencyPerSchool.toString(),
        leaseMs.toString(),
      );
      if (!granted) return null;
      return {
        async release() {
          await redis.zrem(key, token);
        },
      };
    },
  };
}
