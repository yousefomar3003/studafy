/**
 * Per-tenant ingestion concurrency gate (ST-161) tests.
 *
 * The semaphore's only Redis surface is `eval` (acquire) and `zrem` (release), so a small in-memory
 * fake that reproduces the sorted-set semantics — members keyed by token, scored by expiry — is
 * enough to prove the guarantees without a live Redis: a cap per school, independence across
 * schools, release freeing a slot, and expiry pruning by the next acquire.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import { createTenantSemaphore } from "./semaphore";

import type { TenantSemaphoreOptions } from "./semaphore";

const SCHOOL_A = "11111111-1111-4111-8111-111111111111";
const SCHOOL_B = "22222222-2222-4222-8222-222222222222";

/**
 * A minimal ioredis-shaped fake. `now` is mutable so a test can lapse leases without waiting.
 * Members live in a Map keyed by token, scored by `now + leaseMs`; acquire prunes expired members,
 * admits below the cap, and release drops the caller's own token.
 */
function createFakeRedis() {
  const sets = new Map<string, Map<string, number>>();
  let now = 1_000_000;
  return {
    _sets: sets,
    _setNow(value: number) {
      now = value;
    },
    async eval(
      _script: string,
      _numKeys: number,
      key: string,
      token: string,
      capRaw: string,
      leaseRaw: string,
    ): Promise<number> {
      const cap = Number(capRaw);
      const leaseMs = Number(leaseRaw);
      const members = sets.get(key) ?? new Map<string, number>();
      for (const [member, expiresAt] of members) {
        if (expiresAt <= now) members.delete(member);
      }
      if (members.size >= cap) return 0;
      members.set(token, now + leaseMs);
      sets.set(key, members);
      return 1;
    },
    async zrem(key: string, token: string): Promise<number> {
      return sets.get(key)?.delete(token) ? 1 : 0;
    },
  };
}

function semaphoreOf(fake: ReturnType<typeof createFakeRedis>, cap = 2): TenantSemaphoreOptions {
  return {
    redis: fake as never,
    maxConcurrencyPerSchool: cap,
    leaseMs: 1_000,
  };
}

describe("createTenantSemaphore", () => {
  test("admits up to the cap per school and rejects beyond it", async () => {
    const fake = createFakeRedis();
    const semaphore = createTenantSemaphore(semaphoreOf(fake, 2));

    expect(await semaphore.acquire(SCHOOL_A)).not.toBeNull();
    expect(await semaphore.acquire(SCHOOL_A)).not.toBeNull();
    expect(await semaphore.acquire(SCHOOL_A)).toBeNull();
  });

  test("schools draw from independent budgets", async () => {
    const fake = createFakeRedis();
    const semaphore = createTenantSemaphore(semaphoreOf(fake, 1));

    expect(await semaphore.acquire(SCHOOL_A)).not.toBeNull();
    // School B is unaffected by A being full.
    expect(await semaphore.acquire(SCHOOL_B)).not.toBeNull();
    expect(await semaphore.acquire(SCHOOL_B)).toBeNull();
    expect(await semaphore.acquire(SCHOOL_A)).toBeNull();
  });

  test("releasing a lease frees the slot for the same school", async () => {
    const fake = createFakeRedis();
    const semaphore = createTenantSemaphore(semaphoreOf(fake, 1));

    const first = await semaphore.acquire(SCHOOL_A);
    expect(first).not.toBeNull();
    expect(await semaphore.acquire(SCHOOL_A)).toBeNull();

    await first!.release();
    expect(await semaphore.acquire(SCHOOL_A)).not.toBeNull();
  });

  test("a stale release cannot evict a slot re-leased to someone else", async () => {
    const fake = createFakeRedis();
    const semaphore = createTenantSemaphore(semaphoreOf(fake, 1));

    const first = await semaphore.acquire(SCHOOL_A);
    expect(first).not.toBeNull();

    // The first lease lapses (a crashed worker) and the slot is reclaimed by a second run.
    fake._setNow(5_000_000);
    const second = await semaphore.acquire(SCHOOL_A);
    expect(second).not.toBeNull();

    // A plain INCR/DECR counter would wrongly free the re-leased slot here; the token-keyed
    // release must not evict it.
    await first!.release();
    expect(await semaphore.acquire(SCHOOL_A)).toBeNull();

    await second!.release();
    expect(await semaphore.acquire(SCHOOL_A)).not.toBeNull();
  });

  test("expired leases are pruned by the next acquire", async () => {
    const fake = createFakeRedis();
    const semaphore = createTenantSemaphore(semaphoreOf(fake, 1));

    const lease = await semaphore.acquire(SCHOOL_A);
    expect(lease).not.toBeNull();
    expect(await semaphore.acquire(SCHOOL_A)).toBeNull();

    // Lapse the lease (30s of real time is not testable); the next acquire reclaims the slot.
    fake._setNow(5_000_000);
    expect(await semaphore.acquire(SCHOOL_A)).not.toBeNull();
  });
});
