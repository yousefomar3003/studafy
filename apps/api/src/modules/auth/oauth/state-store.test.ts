// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { describe, expect, test } from "bun:test";

import {
  OAUTH_STATE_KEY_PREFIX,
  createMemoryStateStore,
  createRedisStateStore,
  takeStateFor,
} from "./state-store";

import type { StateEntry, StateStore } from "./state-store";
import type { RedisClient } from "../../../redis";

const ENTRY: StateEntry = { flow: "login", provider: "google", codeVerifier: "v", nonce: "n" };

/** ioredis-shaped fake covering exactly the two commands the Redis store issues. */
function fakeRedis(): {
  client: RedisClient;
  store: Map<string, string>;
  ttls: Map<string, number>;
} {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();
  const client = {
    set: (key: string, value: string, mode: string, ttl: number) => {
      expect(mode).toBe("PX");
      store.set(key, value);
      ttls.set(key, ttl);
      return Promise.resolve("OK");
    },
    getdel: (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return Promise.resolve(value);
    },
  } as unknown as RedisClient;
  return { client, store, ttls };
}

// The behavioural contract both implementations must honour.
for (const [name, make] of [
  ["memory", () => createMemoryStateStore()],
  ["redis", () => createRedisStateStore(fakeRedis().client)],
] as const satisfies readonly (readonly [string, () => StateStore])[]) {
  describe(`${name} state store`, () => {
    test("set/take round-trips the entry", async () => {
      const store = make();
      await store.set("s1", ENTRY);
      expect(await store.take("s1")).toEqual(ENTRY);
    });

    test("an entry is single-use", async () => {
      const store = make();
      await store.set("s1", ENTRY);
      await store.take("s1");
      expect(await store.take("s1")).toBeUndefined();
    });

    test("a missing key is undefined", async () => {
      expect(await make().take("never-issued")).toBeUndefined();
    });
  });
}

describe("createMemoryStateStore", () => {
  test("an expired entry is undefined", async () => {
    const store = createMemoryStateStore(50);
    await store.set("s1", ENTRY);
    await new Promise((r) => setTimeout(r, 60));
    expect(await store.take("s1")).toBeUndefined();
  });
});

describe("createRedisStateStore", () => {
  test("writes under the auth:oauth:state: prefix with the TTL in milliseconds", async () => {
    const redis = fakeRedis();
    await createRedisStateStore(redis.client, 120_000).set("abc", ENTRY);

    const key = `${OAUTH_STATE_KEY_PREFIX}abc`;
    expect(key).toBe("auth:oauth:state:abc");
    expect(JSON.parse(redis.store.get(key)!)).toEqual(ENTRY);
    expect(redis.ttls.get(key)).toBe(120_000);
  });

  test("an unparseable value is treated as missing", async () => {
    const redis = fakeRedis();
    redis.store.set(`${OAUTH_STATE_KEY_PREFIX}bad`, "{not json");
    expect(await createRedisStateStore(redis.client).take("bad")).toBeUndefined();
  });

  test("two stores over one Redis see each other's state — the multi-instance case", async () => {
    const redis = fakeRedis();
    const instanceA = createRedisStateStore(redis.client);
    const instanceB = createRedisStateStore(redis.client);

    await instanceA.set("s1", ENTRY);
    expect(await instanceB.take("s1")).toEqual(ENTRY);
  });
});

describe("takeStateFor", () => {
  test("returns the entry for the expected flow and provider", async () => {
    const store = createMemoryStateStore();
    await store.set("s1", ENTRY);
    expect(await takeStateFor(store, "s1", "login", "google")).toEqual(ENTRY);
  });

  test("rejects — and consumes — an entry minted for another flow", async () => {
    const store = createMemoryStateStore();
    await store.set("s1", ENTRY);
    expect(await takeStateFor(store, "s1", "mobile-login", "google")).toBeUndefined();
    expect(await store.take("s1")).toBeUndefined();
  });

  test("rejects an entry minted for another provider", async () => {
    const store = createMemoryStateStore();
    await store.set("s1", ENTRY);
    expect(await takeStateFor(store, "s1", "login", "microsoft")).toBeUndefined();
  });
});
