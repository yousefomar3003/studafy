// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createApp } from "../../app";
import { buildRateLimitKey, resolveRouteClass } from "../../config/rateLimits";
import { createInflightTracker } from "../../lifecycle";
import { createLogger } from "../../logger";
import { createRedisClient } from "../../redis";
import { requestIdMiddleware, errorHandlerMiddleware } from "../index";
import { rateLimiterMiddleware, extractClientIp } from "../rateLimiter";

import type { RedisClient } from "../../redis";
import type { AppEnv } from "../requestId";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function createTestClient(): Promise<RedisClient | null> {
  try {
    const client = createRedisClient({
      url: "redis://localhost:6379/0",
      logger: silentLogger,
    });
    await client.connect();
    await client.ping();
    return client;
  } catch {
    return null;
  }
}

const buildApp = (
  redis: RedisClient | null,
  routeClass?: string,
  routes?: (app: Hono<AppEnv>) => void,
) => {
  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => {} }), // eslint-disable-line @typescript-eslint/no-empty-function
  });
  app.use(
    "*",
    rateLimiterMiddleware({
      redis,
      routeClass: routeClass as "auth" | "ai" | "default" | undefined,
    }),
  );
  routes?.(app);
  return app;
};

// ---------------------------------------------------------------------------
// Unit tests — pure functions, no Redis required
// ---------------------------------------------------------------------------

describe("extractClientIp", () => {
  test("takes last IP from X-Forwarded-For", () => {
    const ip = extractClientIp({
      req: {
        header: (name: string) =>
          name === "x-forwarded-for" ? "1.2.3.4, 10.0.0.1, 192.168.1.1" : undefined,
      },
    });
    expect(ip).toBe("192.168.1.1");
  });

  test("handles single IP in X-Forwarded-For", () => {
    const ip = extractClientIp({
      req: { header: (name: string) => (name === "x-forwarded-for" ? "1.2.3.4" : undefined) },
    });
    expect(ip).toBe("1.2.3.4");
  });

  test("trims whitespace around IPs", () => {
    const ip = extractClientIp({
      req: {
        header: (name: string) => (name === "x-forwarded-for" ? " 1.2.3.4 , 10.0.0.1 " : undefined),
      },
    });
    expect(ip).toBe("10.0.0.1");
  });

  test("falls back to X-Real-IP when X-Forwarded-For is absent", () => {
    const ip = extractClientIp({
      req: {
        header: (name: string) => (name === "x-real-ip" ? "5.6.7.8" : undefined),
      },
    });
    expect(ip).toBe("5.6.7.8");
  });

  test('returns "unknown" when no IP headers present', () => {
    const ip = extractClientIp({
      req: { header: () => undefined },
    });
    expect(ip).toBe("unknown");
  });
});

describe("resolveRouteClass", () => {
  test("returns exact match from ROUTE_CLASS_MAP", () => {
    // All entries are commented out in ROUTE_CLASS_MAP, so this tests the
    // fallback to default when no entries match.
    expect(resolveRouteClass("/healthz")).toBe("default");
  });

  test("returns default for unregistered paths", () => {
    expect(resolveRouteClass("/api/unknown")).toBe("default");
  });
});

describe("buildRateLimitKey", () => {
  test("auth key uses IP identity", () => {
    const key = buildRateLimitKey("auth", "192.168.1.1");
    expect(key).toMatch(/^rl:auth:192\.168\.1\.1:\d+$/);
  });

  test("ai key uses tenant:user identity", () => {
    const key = buildRateLimitKey("ai", "sch_123:usr_456");
    expect(key).toMatch(/^rl:sch:sch_123:usr_456:ai:\d+$/);
  });

  test("default key uses tenant:user identity", () => {
    const key = buildRateLimitKey("default", "sch_789:usr_012");
    expect(key).toMatch(/^rl:sch:sch_789:usr_012:default:\d+$/);
  });

  test("window segment is stable within the same window", () => {
    const key1 = buildRateLimitKey("auth", "1.2.3.4");
    const key2 = buildRateLimitKey("auth", "1.2.3.4");
    expect(key1).toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require Redis
// ---------------------------------------------------------------------------

describe("token consumption (requires Redis)", () => {
  test("allows requests within budget", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const app = buildApp(client, "auth");
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.request("/test");
      expect(res.status).toBe(200);
    } finally {
      await client.quit();
    }
  });

  test("rejects with 429 after budget exhaustion", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const budget = { maxTokens: 3, refillRate: 0, windowSeconds: 60 };
      const app = buildApp(client, "auth", (a) => {
        a.get("/test", (c) => c.json({ ok: true }));
      });
      // Override budget via direct middleware registration
      app.use("/test", rateLimiterMiddleware({ redis: client, routeClass: "auth", budget }));

      // Consume all 3 tokens
      for (let i = 0; i < 3; i++) {
        const res = await app.request("/test");
        expect(res.status).toBe(200);
      }

      // 4th request should be 429
      const blocked = await app.request("/test");
      expect(blocked.status).toBe(429);
    } finally {
      await client.quit();
    }
  });

  test("budget exhaustion under simulated concurrency", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const budget = { maxTokens: 5, refillRate: 0, windowSeconds: 60 };
      const app = new Hono<AppEnv>();
      app.use("*", rateLimiterMiddleware({ redis: client, routeClass: "ai", budget }));
      app.get("/concurrent", (c) => c.json({ ok: true }));

      const CONCURRENCY = 10;
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => app.request("/concurrent")),
      );

      const statuses = results.map((r) => r.status);
      const okCount = statuses.filter((s) => s === 200).length;
      const blockedCount = statuses.filter((s) => s === 429).length;

      expect(okCount).toBe(5);
      expect(blockedCount).toBe(5);
    } finally {
      await client.quit();
    }
  });

  test("different IPs have independent buckets", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const budget = { maxTokens: 2, refillRate: 0, windowSeconds: 60 };
      const app = new Hono<AppEnv>();
      app.use("*", rateLimiterMiddleware({ redis: client, routeClass: "auth", budget }));
      app.get("/test", (c) => c.json({ ok: true }));

      // IP A: consume 2 tokens
      for (let i = 0; i < 2; i++) {
        const res = await app.request("/test", {
          headers: { "X-Forwarded-For": "10.0.0.1" },
        });
        expect(res.status).toBe(200);
      }
      // IP A: exhausted
      const blockedA = await app.request("/test", {
        headers: { "X-Forwarded-For": "10.0.0.1" },
      });
      expect(blockedA.status).toBe(429);

      // IP B: should still have budget
      const okB = await app.request("/test", {
        headers: { "X-Forwarded-For": "10.0.0.2" },
      });
      expect(okB.status).toBe(200);
    } finally {
      await client.quit();
    }
  });
});

describe("response headers (requires Redis)", () => {
  test("successful responses include rate limit headers", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const app = buildApp(client, "auth");
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.request("/test");
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
      expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
      expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    } finally {
      await client.quit();
    }
  });

  test("429 responses include Retry-After header", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const budget = { maxTokens: 1, refillRate: 0, windowSeconds: 60 };
      const app = new Hono<AppEnv>();
      app.use("*", rateLimiterMiddleware({ redis: client, routeClass: "auth", budget }));
      app.get("/test", (c) => c.json({ ok: true }));

      // Consume the single token
      const ok = await app.request("/test");
      expect(ok.status).toBe(200);

      // Should be blocked now
      const blocked = await app.request("/test");
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("Retry-After")).toBeTruthy();
      expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    } finally {
      await client.quit();
    }
  });

  test("Remaining decrements correctly across requests", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const budget = { maxTokens: 5, refillRate: 0, windowSeconds: 60 };
      const app = new Hono<AppEnv>();
      app.use("*", rateLimiterMiddleware({ redis: client, routeClass: "default", budget }));
      app.get("/test", (c) => c.json({ ok: true }));

      const remainingValues: number[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await app.request("/test");
        remainingValues.push(Number(res.headers.get("X-RateLimit-Remaining")));
      }

      expect(remainingValues[0]).toBe(4);
      expect(remainingValues[1]).toBe(3);
      expect(remainingValues[2]).toBe(2);
    } finally {
      await client.quit();
    }
  });

  test("Reset is a future unix timestamp", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const app = buildApp(client, "default");
      app.get("/test", (c) => c.json({ ok: true }));

      const res = await app.request("/test");
      const reset = Number(res.headers.get("X-RateLimit-Reset"));
      const now = Math.floor(Date.now() / 1000);
      expect(reset).toBeGreaterThan(now);
    } finally {
      await client.quit();
    }
  });
});

describe("RFC 9457 compliance on 429 (requires Redis)", () => {
  test("429 body matches problem+json structure", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      const budget = { maxTokens: 1, refillRate: 0, windowSeconds: 60 };
      const app = new Hono<AppEnv>();
      // Wire requestId + error handler manually so we get the full RFC 9457 envelope
      // without going through createApp() (which adds unrelated middleware).
      app.use("*", requestIdMiddleware({ logger: silentLogger }));
      app.use("*", rateLimiterMiddleware({ redis: client, routeClass: "auth", budget }));
      app.onError(errorHandlerMiddleware(silentLogger));
      app.get("/test", (c) => c.json({ ok: true }));

      // Consume the single token
      await app.request("/test");

      // Should get 429 with RFC 9457 body
      const res = await app.request("/test");
      expect(res.status).toBe(429);
      expect(res.headers.get("content-type")).toContain("application/problem+json");

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        type: "about:blank",
        title: "Too Many Requests",
        status: 429,
        code: "RATE_LIMIT_EXCEEDED",
      });
      expect(body.request_id).toBeTruthy();
    } finally {
      await client.quit();
    }
  });
});

describe("fail-open behavior", () => {
  test("passes through when redis is null", async () => {
    const app = buildApp(null);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });

  test("passes through on redis connection error", async () => {
    // Mock a Redis client that always rejects — simulates an unreachable server
    // without waiting for TCP timeouts or ioredis retry backoff.
    const badClient = {
      evalsha: () => Promise.reject(new Error("ECONNREFUSED")),
      script: () => Promise.reject(new Error("ECONNREFUSED")),
      status: "wait",
      quit: () => Promise.resolve(),
      disconnect: () => {}, // eslint-disable-line @typescript-eslint/no-empty-function
    } as unknown as RedisClient;

    const app = buildApp(badClient);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test");
    // Should fail open — pass through despite Redis error
    expect(res.status).toBe(200);
  });
});
