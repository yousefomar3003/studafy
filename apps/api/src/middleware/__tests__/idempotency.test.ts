// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createRedisClient } from "../../redis";
import { idempotencyMiddleware, resetIdempotencyInflight } from "../idempotency";
import { requestIdMiddleware, errorHandlerMiddleware } from "../index";

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

function buildApp(redis: RedisClient | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware({ logger: silentLogger }));
  app.use("*", idempotencyMiddleware({ redis }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

// ---------------------------------------------------------------------------
// Unit tests — fail-open when Redis is null
// ---------------------------------------------------------------------------

describe("fail-open behavior", () => {
  test("passes through when redis is null", async () => {
    const app = buildApp(null);
    app.post("/test", (c) => c.json({ created: true }));

    const res = await app.request("/test", { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Header/method filtering (no Redis required)
// ---------------------------------------------------------------------------

describe("header and method filtering", () => {
  test("passes through GET requests", async () => {
    const app = buildApp(null);
    app.get("/test", (c) => c.json({ ok: true }));

    const res = await app.request("/test", {
      headers: { "Idempotency-Key": "key-1" },
    });
    expect(res.status).toBe(200);
  });

  test("passes through POST without Idempotency-Key", async () => {
    const app = buildApp(null);
    app.post("/test", (c) => c.json({ created: true }));

    const res = await app.request("/test", { method: "POST", body: '{"a":1}' });
    expect(res.status).toBe(200);
  });

  test("passes through PUT with Idempotency-Key (only POST is idempotent)", async () => {
    const app = buildApp(null);
    app.put("/test", (c) => c.json({ updated: true }));

    const res = await app.request("/test", {
      method: "PUT",
      body: '{"a":1}',
      headers: { "Idempotency-Key": "key-1" },
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — require Redis
// ---------------------------------------------------------------------------

describe("response replay (requires Redis)", () => {
  test("returns identical response on duplicate key with same body", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      let callCount = 0;
      app.post("/test", (c) => {
        callCount++;
        return c.json({ id: callCount, name: "item" }, 201);
      });

      const body = '{"value":"hello"}';
      const res1 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": "dup-key-1" },
      });
      expect(res1.status).toBe(201);
      const json1 = await res1.json();
      expect(json1).toEqual({ id: 1, name: "item" });
      expect(callCount).toBe(1);

      // Replay — handler should not be called again
      const res2 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": "dup-key-1" },
      });
      expect(res2.status).toBe(201);
      const json2 = await res2.json();
      expect(json2).toEqual({ id: 1, name: "item" });
      expect(callCount).toBe(1);
    } finally {
      await client.del("idem:dup-key-1");
      await client.quit();
    }
  });

  test("preserves response headers on replay", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      app.post("/test", (c) => {
        return c.json({ ok: true }, 201, { "X-Custom": "test-value" });
      });

      const body = '{"x":1}';
      const res1 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": "header-key-1" },
      });
      expect(res1.headers.get("x-custom")).toBe("test-value");

      const res2 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": "header-key-1" },
      });
      expect(res2.headers.get("x-custom")).toBe("test-value");
    } finally {
      await client.del("idem:header-key-1");
      await client.quit();
    }
  });
});

describe("body mismatch rejection (requires Redis)", () => {
  test("returns 409 when same key is used with a different body", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      app.post("/test", (c) => c.json({ created: true }, 201));

      // First request — establishes the idempotency key
      const res1 = await app.request("/test", {
        method: "POST",
        body: '{"original":true}',
        headers: { "Idempotency-Key": "mismatch-key-1" },
      });
      expect(res1.status).toBe(201);

      // Second request — different body, same key
      const res2 = await app.request("/test", {
        method: "POST",
        body: '{"different":true}',
        headers: { "Idempotency-Key": "mismatch-key-1" },
      });
      expect(res2.status).toBe(409);
    } finally {
      await client.del("idem:mismatch-key-1");
      await client.quit();
    }
  });
});

describe("concurrent duplicate serialization (requires Redis)", () => {
  test("concurrent same-key same-body requests receive the same response", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      let callCount = 0;
      app.post("/test", async (c) => {
        callCount++;
        // Simulate slow handler to increase chance of overlap
        await new Promise((r) => setTimeout(r, 50));
        return c.json({ count: callCount }, 201);
      });

      const body = '{"concurrent":true}';
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          app.request("/test", {
            method: "POST",
            body,
            headers: { "Idempotency-Key": "conc-key-1" },
          }),
        ),
      );

      // All should succeed with 201
      for (const res of results) {
        expect(res.status).toBe(201);
      }

      // All should have the same response body
      const bodies = await Promise.all(results.map((r) => r.json()));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);

      // Handler should have been called only once
      expect(callCount).toBe(1);
    } finally {
      await client.del("idem:conc-key-1");
      await client.quit();
    }
  });

  test("concurrent same-key different-body requests get 409", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      app.post("/test", async (c) => {
        await new Promise((r) => setTimeout(r, 50));
        return c.json({ ok: true }, 201);
      });

      const results = await Promise.all([
        app.request("/test", {
          method: "POST",
          body: '{"variant":"a"}',
          headers: { "Idempotency-Key": "conc-mismatch-1" },
        }),
        app.request("/test", {
          method: "POST",
          body: '{"variant":"b"}',
          headers: { "Idempotency-Key": "conc-mismatch-1" },
        }),
      ]);

      const statuses = results.map((r) => r.status).sort();
      // One should be 201, the other 409
      expect(statuses).toEqual([201, 409]);
    } finally {
      await client.del("idem:conc-mismatch-1");
      await client.quit();
    }
  });
});

describe("24-hour window (requires Redis)", () => {
  test("stored response expires after TTL", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      // Use a 2-second TTL for fast expiry test
      const app = new Hono<AppEnv>();
      app.use("*", requestIdMiddleware({ logger: silentLogger }));
      app.use("*", idempotencyMiddleware({ redis: client, windowSeconds: 2 }));
      app.onError(errorHandlerMiddleware(silentLogger));
      let callCount = 0;
      app.post("/test", (c) => {
        callCount++;
        return c.json({ count: callCount }, 201);
      });

      const body = '{"ttl":"test"}';
      const key = "ttl-key-1";

      // First request
      const res1 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": key },
      });
      expect(res1.status).toBe(201);
      expect(callCount).toBe(1);

      // Immediate replay — should return stored response
      const res2 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": key },
      });
      expect(res2.status).toBe(201);
      expect(callCount).toBe(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 2500));

      // After expiry — should execute handler again
      const res3 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": key },
      });
      expect(res3.status).toBe(201);
      expect(callCount).toBe(2);
    } finally {
      await client.del("idem:ttl-key-1");
      await client.quit();
    }
  });
});

describe("error propagation (requires Redis)", () => {
  test("handler errors are propagated and in-flight entry is cleaned up", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      let callCount = 0;
      app.post("/test", (_c) => {
        callCount++;
        throw new Error("handler failure");
      });

      const body = '{"err":true}';
      const res1 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": "error-key-1" },
      });
      expect(res1.status).toBe(500);

      // Second request should not be blocked by stale in-flight entry
      const res2 = await app.request("/test", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": "error-key-1" },
      });
      expect(res2.status).toBe(500);
      expect(callCount).toBe(2);
    } finally {
      await client.del("idem:error-key-1");
      await client.quit();
    }
  });
});

describe("body preservation", () => {
  test("handles empty body", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      app.post("/test", (c) => c.json({ ok: true }));

      const res1 = await app.request("/test", {
        method: "POST",
        body: "",
        headers: { "Idempotency-Key": "empty-body-1" },
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/test", {
        method: "POST",
        body: "",
        headers: { "Idempotency-Key": "empty-body-1" },
      });
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ ok: true });
    } finally {
      await client.del("idem:empty-body-1");
      await client.quit();
    }
  });

  test("handles large JSON body", async () => {
    const client = await createTestClient();
    if (!client) return;

    try {
      resetIdempotencyInflight();

      const app = buildApp(client);
      app.post("/test", (c) => c.json({ received: true }));

      const largeBody = JSON.stringify({ data: "x".repeat(50_000) });
      const res1 = await app.request("/test", {
        method: "POST",
        body: largeBody,
        headers: { "Idempotency-Key": "large-body-1" },
      });
      expect(res1.status).toBe(200);

      const res2 = await app.request("/test", {
        method: "POST",
        body: largeBody,
        headers: { "Idempotency-Key": "large-body-1" },
      });
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ received: true });
    } finally {
      await client.del("idem:large-body-1");
      await client.quit();
    }
  });
});
