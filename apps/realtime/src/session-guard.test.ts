import { JTI_DENYLIST_PREFIX, REALTIME_TICKET_USED_PREFIX } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  createRedisSessionGuard,
  createSessionRegistry,
  sweepRevokedSessions,
} from "./session-guard";

import type { AuthClaims } from "./auth";
import type { GuardRedis } from "./session-guard";

/** A Redis double holding plain keys, enough for SET NX and EXISTS/MGET. */
function fakeRedis() {
  const keys = new Map<string, { value: string; ttl: number }>();
  const mgetSizes: number[] = [];
  const redis: GuardRedis = {
    async set(key, value, _ex, seconds) {
      if (keys.has(key)) return null;
      keys.set(key, { value, ttl: seconds });
      return "OK";
    },
    async exists(key) {
      return keys.has(key) ? 1 : 0;
    },
    async mget(list) {
      mgetSizes.push(list.length);
      return list.map((key) => keys.get(key)?.value ?? null);
    },
  };
  return { redis, keys, mgetSizes };
}

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function claims(overrides: Partial<AuthClaims> = {}): AuthClaims {
  return {
    userId: "user-1",
    schoolId: "school-1",
    roles: ["STUDENT"],
    sessionId: "session-1",
    sessionExp: NOW / 1000 + 900,
    ticketId: "ticket-1",
    exp: NOW / 1000 + 30,
    ...overrides,
  };
}

describe("createRedisSessionGuard", () => {
  test("admits a ticket once, keeping its marker until the ticket could no longer verify", async () => {
    const { redis, keys } = fakeRedis();
    const guard = createRedisSessionGuard(redis);

    expect(await guard.admit(claims(), NOW)).toBe("ok");
    expect(keys.get(`${REALTIME_TICKET_USED_PREFIX}ticket-1`)?.ttl).toBe(35);
    expect(await guard.admit(claims(), NOW)).toBe("replayed");
  });

  test("refuses a session the API has denylisted, under the API's own key", async () => {
    const { redis, keys } = fakeRedis();
    keys.set(`${JTI_DENYLIST_PREFIX}session-1`, { value: "1", ttl: 900 });

    expect(await createRedisSessionGuard(redis).admit(claims(), NOW)).toBe("revoked");
  });

  test("reports revoked sessions in batches", async () => {
    const { redis, keys, mgetSizes } = fakeRedis();
    const ids = Array.from({ length: 1200 }, (_, index) => `s-${index}`);
    keys.set(`${JTI_DENYLIST_PREFIX}s-7`, { value: "1", ttl: 900 });
    keys.set(`${JTI_DENYLIST_PREFIX}s-1100`, { value: "1", ttl: 900 });

    const revoked = await createRedisSessionGuard(redis).revokedSessions(ids);

    expect([...revoked].sort()).toEqual(["s-1100", "s-7"]);
    expect(mgetSizes).toEqual([500, 500, 200]);
  });
});

describe("sweepRevokedSessions", () => {
  test("closes every socket of a revoked session and looks each session up once", async () => {
    const { redis, keys, mgetSizes } = fakeRedis();
    keys.set(`${JTI_DENYLIST_PREFIX}revoked`, { value: "1", ttl: 900 });
    const registry = createSessionRegistry<string>();
    const closed: string[] = [];
    for (const [socket, sessionId] of [
      ["a", "revoked"],
      ["b", "revoked"],
      ["c", "live"],
    ]) {
      registry.add(socket, { sessionId, close: (reason) => closed.push(`${socket}:${reason}`) });
    }

    expect(await sweepRevokedSessions(registry, createRedisSessionGuard(redis))).toBe(2);
    expect(closed).toEqual(["a:session revoked", "b:session revoked"]);
    expect(mgetSizes).toEqual([2]);
  });

  test("does nothing, and asks Redis nothing, with no open sockets", async () => {
    const { redis, mgetSizes } = fakeRedis();
    expect(
      await sweepRevokedSessions(createSessionRegistry(), createRedisSessionGuard(redis)),
    ).toBe(0);
    expect(mgetSizes).toEqual([]);
  });
});
