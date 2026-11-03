// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "./app";
import { signToken, ticketPayload } from "./auth";
import { createConnectionTracker } from "./lifecycle";
import { resetMetrics, snapshot } from "./metrics";
import { createRoomManager } from "./rooms";
import { createMemorySessionGuard } from "./session-guard.testing";

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
async function jsonBody(res: Response): Promise<{ error: string; code: string }> {
  return res.json() as Promise<{ error: string; code: string }>;
}

const buildApp = () =>
  createApp({
    isReady: () => true,
    jwtSecret: SECRET,
    sessionGuard: createMemorySessionGuard(),
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
      sessionGuard: createMemorySessionGuard(),
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
  test("rejects a connection with no ticket", async () => {
    const res = await buildApp().request("/ws");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "missing ticket query parameter",
      code: "TOKEN_MISSING",
    });
  });

  test("ignores the retired ?token= parameter, so a session token is never accepted there", async () => {
    const ticket = signToken(
      ticketPayload({ sub: "user-1", school_id: "school-1", roles: ["STUDENT"] }),
      SECRET,
    );
    const res = await buildApp().request(`/ws?token=${ticket}`);
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).code).toBe("TOKEN_MISSING");
  });

  test("rejects a connection with a malformed ticket", async () => {
    const res = await buildApp().request("/ws?ticket=not-a-jwt");
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).code).toBe("TOKEN_INVALID");
  });

  test("rejects a connection with a ticket signed by a different secret", async () => {
    const token = signToken(
      ticketPayload({ sub: "user-1", school_id: "school-1", roles: ["STUDENT"] }),
      "other-secret",
    );
    const res = await buildApp().request(`/ws?ticket=${token}`);
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).code).toBe("TOKEN_INVALID");
  });

  test("rejects an expired ticket with the re-auth error code", async () => {
    const token = signToken(
      ticketPayload(
        { sub: "user-1", school_id: "school-1", roles: ["STUDENT"] },
        Date.now() - 3_600_000,
      ),
      SECRET,
    );
    const res = await buildApp().request(`/ws?ticket=${token}`);
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).code).toBe("TOKEN_EXPIRED");
  });
});
