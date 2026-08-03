// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { signToken } from "./auth";
import { createConnectionTracker } from "./lifecycle";
import { resetMetrics, snapshot } from "./metrics";
import { createRoomManager } from "./rooms";

const SECRET = "test-secret";

// metrics.ts is a module-level singleton shared across every test file in this run — reset it so
// this file's /metrics assertions don't depend on what outbox-fanout.test.ts did first.
beforeEach(() => {
  resetMetrics();
});

/**
 * The `/ws` handshake's success path performs a real Bun WebSocket upgrade, which needs a live
 * `Bun.serve` server object (`hono/bun`'s `upgradeWebSocket` reads it off the fetch call's second
 * argument) — `app.request()` doesn't provide one. That path is exercised end-to-end by
 * scripts/smoke-test.ts instead, mirroring apps/workers' split between unit tests for pure logic
 * and a Redis-required smoke test for the network behavior. What's unit-tested here is what
 * `app.request()` can drive without a real server: health routes and the handshake's rejection
 * path, which never reaches the upgrade.
 */
const buildApp = () =>
  createApp({
    isReady: () => true,
    jwtSecret: SECRET,
    rooms: createRoomManager(),
    tracker: createConnectionTracker(),
    metrics: snapshot,
  });

describe("health routes", () => {
  test("GET /healthz returns 200 ok", async () => {
    const res = await buildApp().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /readyz reflects isReady", async () => {
    const notReadyApp = createApp({
      isReady: () => false,
      jwtSecret: SECRET,
      rooms: createRoomManager(),
      tracker: createConnectionTracker(),
      metrics: snapshot,
    });
    const res = await notReadyApp.request("/readyz");
    expect(res.status).toBe(503);
  });

  test("GET /metrics returns the fan-out counters", async () => {
    const res = await buildApp().request("/metrics");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 0, roomDeliveries: 0, dropped: 0 });
  });
});

describe("GET /ws handshake", () => {
  test("rejects a connection with no token", async () => {
    const res = await buildApp().request("/ws");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing token query parameter" });
  });

  test("rejects a connection with a malformed token", async () => {
    const res = await buildApp().request("/ws?token=not-a-jwt");
    expect(res.status).toBe(401);
  });

  test("rejects a connection with a token signed by a different secret", async () => {
    const token = signToken(
      { sub: "user-1", schoolId: "school-1", role: "STUDENT" },
      "other-secret",
    );
    const res = await buildApp().request(`/ws?token=${token}`);
    expect(res.status).toBe(401);
  });

  test("rejects an expired token", async () => {
    const expired = Math.floor(Date.now() / 1000) - 3600;
    const token = signToken(
      { sub: "user-1", schoolId: "school-1", role: "STUDENT", exp: expired },
      SECRET,
    );
    const res = await buildApp().request(`/ws?token=${token}`);
    expect(res.status).toBe(401);
  });
});
