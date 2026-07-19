/**
 * Context cascade tests (ST-070).
 *
 * The suites in jwt-auth.test.ts run against a probe app, which proves the middleware's own
 * behaviour but says nothing about where it sits in the real chain. These run against createApp —
 * the stack the service actually boots with — so a regression in registration order is caught.
 *
 * Ordering is the thing under test here, and it is invisible to a status code. The middleware must
 * land after requestIdMiddleware (so a child logger exists to re-bind) and before
 * rateLimiterMiddleware (so rate-limit keys are tenant-scoped rather than collapsing every user
 * behind a shared NAT into one IP bucket).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createApp } from "../../src/app";
import { createInflightTracker } from "../../src/lifecycle";
import { KeyStore } from "../../src/modules/auth";

import { AUDIENCE, ISSUER, SCHOOL_ID, USER_ID, createCapturingLogger, mintToken } from "./support";

import type { CapturedLine } from "./support";
import type { AppEnv } from "../../src/middleware";

let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;
let lines: CapturedLine[];

beforeEach(async () => {
  const captured = createCapturingLogger();
  lines = captured.lines;
  keyStore = new KeyStore(60_000);
  await keyStore.init();

  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: captured.logger,
    keyStore,
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
  });

  // The service has no protected business routes yet, so a request that passes authentication
  // would otherwise land on the 404 handler and "not 401" would be weak evidence. This route is
  // registered after createApp returns, which puts it behind the whole middleware chain.
  app.get("/api/echo", (c) => c.json({ auth: c.get("auth") ?? null }));
});

afterEach(() => {
  keyStore.destroy();
});

describe("protected routes in the real stack", () => {
  it("rejects an unauthenticated request to /api/*", async () => {
    // Deny-by-default: this route opted into nothing, and it is protected anyway.
    const res = await app.request("/api/echo");
    expect(res.status).toBe(401);
  });

  it("cascades the hydrated context to a downstream route", async () => {
    const token = await mintToken(keyStore, { roles: ["ORG_ADMIN"] });
    const res = await app.request("/api/echo", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      auth: {
        userId: USER_ID,
        schoolId: SCHOOL_ID,
        roles: ["ORG_ADMIN"],
        channel: "web",
        jti: expect.any(String),
        entitlementsVer: 1,
      },
    });
  });

  it("leaves health checks reachable without a token", async () => {
    // /healthz and /readyz sit outside /api/*, so the mount prefix alone keeps them public — but
    // an accidental widening to "*" would break every probe, and that is worth a regression guard.
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
  });

  it("leaves the JWKS endpoint reachable without a token", async () => {
    // Clients fetch this to verify tokens; requiring a token to get it would be circular.
    const res = await app.request("/.well-known/jwks.json");
    expect(res.status).toBe(200);
  });
});

describe("log correlation", () => {
  it("stamps school_id and user_id on the request-completed line", async () => {
    const token = await mintToken(keyStore);
    await app.request("/api/echo", { headers: { Authorization: `Bearer ${token}` } });

    // This is the ST-054 seam. requestIdMiddleware binds both as null on the way in because no
    // identity exists yet; the auth middleware re-childs the logger, and the completion line is
    // emitted on the unwind, so it must carry the real values. If auth were registered before
    // requestId there would be no logger to re-child, and if it were registered after the route
    // these would still be null — the assertion pins the ordering from both sides.
    const completed = lines.find((line) => line.msg === "request completed");
    expect(completed).toBeDefined();
    expect(completed?.school_id).toBe(SCHOOL_ID);
    expect(completed?.user_id).toBe(USER_ID);

    // The DB GUCs (app.school_id / app.user_id, see src/db/tenant-tx.ts) carry the same labels, so
    // one identifier joins an HTTP log line to an audit row.
    expect(completed?.request_id).toBeString();
  });

  it("leaves identity null on the completed line for a rejected request", async () => {
    await app.request("/api/echo");

    const completed = lines.find((line) => line.msg === "request completed");
    expect(completed?.school_id).toBeNull();
    expect(completed?.user_id).toBeNull();
    expect(completed?.status).toBe(401);
  });
});

describe("without a key store", () => {
  it("leaves /api/* unauthenticated when no keys are configured", async () => {
    // createApp mounts the middleware only when a key store is supplied. Without one there is
    // nothing to verify against, and mounting it anyway would answer every request with a 503.
    // Pinned so the behaviour is a decision rather than a surprise.
    const captured = createCapturingLogger();
    const bare = createApp({
      isReady: () => true,
      tracker: createInflightTracker(),
      logger: captured.logger,
    });
    bare.get("/api/echo", (c) => c.json({ auth: c.get("auth") ?? null }));

    const res = await bare.request("/api/echo");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auth: null });
  });
});
