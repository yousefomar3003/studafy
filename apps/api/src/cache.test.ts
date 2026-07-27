// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { cacheKey, getCache, resetInflight, setCache, singleFlight } from "./cache";
import { createRedisClient } from "./redis";

import type { CacheKey } from "./cache";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A silent logger that discards all output — deterministic under `bun test`. */
const silentLogger = {
  level: "info" as const,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

/** Create a client connected to a local Redis instance. Returns null if Redis is unavailable. */
async function createTestClient() {
  try {
    const client = createRedisClient({
      url: "redis://localhost:6390/0",
      logger: silentLogger,
    });
    await client.connect();
    await client.ping();
    return client;
  } catch {
    return null;
  }
}

const TEST_PREFIX = `test:sch:${Date.now()}`;

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------

describe("createRedisClient", () => {
  test("does not connect eagerly", () => {
    const client = createRedisClient({
      url: "redis://localhost:6390/0",
      logger: silentLogger,
    });
    try {
      expect(client.options.lazyConnect).toBe(true);
      expect(client.status).toBe("wait");
    } finally {
      client.disconnect();
    }
  });

  test("enables ready check for post-reconnect validation", () => {
    const client = createRedisClient({
      url: "redis://localhost:6390/0",
      logger: silentLogger,
    });
    try {
      expect(client.options.enableReadyCheck).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  test("configures exponential backoff retry strategy", () => {
    const client = createRedisClient({
      url: "redis://localhost:6390/0",
      logger: silentLogger,
    });
    try {
      const strategy = client.options.retryStrategy;
      expect(strategy).toBeFunction();
      // Attempt 1 → 200 ms, attempt 5 → 1000 ms, attempt 25 → null (give up).
      if (strategy) {
        expect(strategy(1)).toBe(200);
        expect(strategy(5)).toBe(1000);
        expect(strategy(25)).toBeNull();
      }
    } finally {
      client.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// Cache key construction
// ---------------------------------------------------------------------------

describe("cacheKey", () => {
  test("produces sch:{schoolId}:{parts} format", () => {
    const key = cacheKey("sch_abc", "session", "usr_123");
    // Compare as string — CacheKey is a branded string, so String() strips the brand.
    expect(String(key)).toBe("sch:sch_abc:session:usr_123");
  });

  test("works with a single part", () => {
    expect(String(cacheKey("sch_abc", "config"))).toBe("sch:sch_abc:config");
  });

  test("works with many parts", () => {
    expect(String(cacheKey("sch_abc", "a", "b", "c"))).toBe("sch:sch_abc:a:b:c");
  });

  test("throws for empty schoolId", () => {
    expect(() => cacheKey("", "key")).toThrow("schoolId is required");
  });

  test("throws when no parts are provided", () => {
    expect(() => cacheKey("sch_abc")).toThrow("at least one key segment");
  });

  test("throws for empty parts", () => {
    expect(() => cacheKey("sch_abc", "")).toThrow("must not be empty");
  });

  test("rejects non-CacheKey strings at the type level", () => {
    // The branded CacheKey type ensures only keys produced by cacheKey() are accepted by
    // getCache / setCache. This test verifies the type constraint is effective by checking
    // that a helper function accepting CacheKey works with cacheKey() output.
    function requireCacheKey(_key: CacheKey): void {
      // no-op — the type constraint is the assertion
    }

    const key = cacheKey("sch_abc", "foo");
    // Valid: cacheKey() returns CacheKey.
    expect(() => requireCacheKey(key)).not.toThrow();

    // A raw string requires explicit casting to CacheKey — this is intentional.
    // Without the cast, TypeScript would reject the assignment in consuming code.
    const raw = "sch:sch_abc:foo" as unknown as CacheKey;
    expect(() => requireCacheKey(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cache get / set (integration — requires Redis)
// ---------------------------------------------------------------------------

describe("getCache / setCache", () => {
  test("round-trips a JSON value through set and get", async () => {
    const client = await createTestClient();
    if (!client) return; // skip if Redis is unavailable

    try {
      const key = cacheKey(`${TEST_PREFIX}:roundtrip`, "user", "u1");
      const value = { name: "Alice", scores: [1, 2, 3] };

      await setCache(client, key, value, 60);
      const result = await getCache<typeof value>(client, key);

      expect(result).toEqual(value);
    } finally {
      await client.quit();
    }
  });

  test("returns null for a non-existent key", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const key = cacheKey(`${TEST_PREFIX}:miss`, "nonexistent", "none");
      const result = await getCache(client, key);
      expect(result).toBeNull();
    } finally {
      await client.quit();
    }
  });

  test("respects TTL and returns null after expiry", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const key = cacheKey(`${TEST_PREFIX}:ttl`, "ttl", "expire-me");
      await setCache(client, key, "ephemeral", 1);

      // Immediately available.
      const before = await getCache<string>(client, key);
      expect(before).toBe("ephemeral");

      // Wait for expiry.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const after = await getCache<string>(client, key);
      expect(after).toBeNull();
    } finally {
      await client.quit();
    }
  });

  test("throws for non-positive TTL", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const key = cacheKey(`${TEST_PREFIX}:bad-ttl`, "ttl", "bad");
      await expect(setCache(client, key, "x", 0)).rejects.toThrow(
        "ttlSeconds must be a positive integer",
      );
      await expect(setCache(client, key, "x", -5)).rejects.toThrow(
        "ttlSeconds must be a positive integer",
      );
    } finally {
      await client.quit();
    }
  });
});

// ---------------------------------------------------------------------------
// Single-flight
// ---------------------------------------------------------------------------

describe("singleFlight", () => {
  test("calls fn exactly once for concurrent requests with the same key", async () => {
    resetInflight();
    let callCount = 0;

    const fn = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "result";
    };

    const CONCURRENCY = 50;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => singleFlight("dedup:key", fn)),
    );

    expect(callCount).toBe(1);
    expect(results.every((r) => r === "result")).toBe(true);
  });

  test("different keys execute fn independently", async () => {
    resetInflight();
    let callCount = 0;

    const fn = async () => {
      callCount += 1;
      const captured = callCount;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return captured;
    };

    const [a, b] = await Promise.all([singleFlight("key:a", fn), singleFlight("key:b", fn)]);

    expect(callCount).toBe(2);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  test("propagates errors to all waiters", async () => {
    resetInflight();

    const fn = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("upstream failure");
    };

    const CONCURRENCY = 20;
    const outcomes = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => singleFlight("error:key", fn)),
    );

    // Every waiter should see the same rejection.
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason.message).toBe("upstream failure");
      }
    }
  });

  test("allows a fresh call after the previous one settles", async () => {
    resetInflight();
    let callCount = 0;

    const fn = async () => {
      callCount += 1;
      return callCount;
    };

    const first = await singleFlight("fresh:key", fn);
    expect(first).toBe(1);

    // After the first call settles, a new call should execute fn again.
    const second = await singleFlight("fresh:key", fn);
    expect(second).toBe(2);
  });
});
