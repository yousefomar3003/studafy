// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../src/app";
import { resetSecurityConfig } from "../../src/config/security";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { KeyStore } from "../../src/modules/auth";
import {
  createFullTenant,
  createRefreshSession,
  createTestDatabase,
  createUserDevice,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
} from "../harness";

import type { CapturedLine } from "./support";
import type { AppEnv } from "../../src/middleware";
import type { TenantFixture, TestDatabase } from "../harness";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";

/**
 * ST-071 — the HTTP surface of the session endpoints.
 *
 * Where rotation.test.ts asks whether the state machine is correct, this file asks the questions
 * only a real request can answer: does a web session's token stay out of the response body, does the
 * cookie carry the attributes that make it worth setting, are the refresh endpoints actually
 * reachable without a bearer token now that /api/* is deny-by-default, and does a raw token ever
 * reach a log sink.
 *
 * The app is the production one from createApp, not a probe. The middleware ordering is part of what
 * is under test — the refresh endpoints are exempted inside jwtAuthMiddleware, and a probe app that
 * mounted the routes without it would prove nothing about that exemption.
 */

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | undefined;
let sql: Sql;
let tenant: TenantFixture;
let app: OpenAPIHono<AppEnv>;
let keyStore: KeyStore;
let lines: CapturedLine[];

beforeAll(async () => {
  if (!integrationEnabled) return;

  database = await createTestDatabase();
  await migrateDatabase(database.url);
  sql = database.sql;
  tenant = await createFullTenant(sql);

  lines = [];
  const logger = createLogger({
    destination: (line: string) => lines.push(JSON.parse(line) as CapturedLine),
  });

  keyStore = new KeyStore(60_000);
  await keyStore.init();

  resetSecurityConfig();
  app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    database: sql as never,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
  });
}, 60_000);

afterAll(async () => {
  keyStore?.destroy();
  await database?.cleanup();
});

async function post(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, { method: "POST", ...init });
}

/**
 * Headers for a web-channel request: the refresh cookie, and nothing else.
 *
 * No CSRF double-submit pair, because `/api/auth/refresh` and `/api/auth/logout` are in
 * csrfMiddleware's exempt list. The check could not cover them usefully: a client calls these
 * precisely when its access token is gone, so the Bearer exemption frequently does not apply, and a
 * mobile client carrying no cookie at all would be rejected by a defence meant for browsers. What
 * protects the browser case is the refresh cookie's own SameSite=Strict attribute, which keeps it
 * off every cross-site request. See the rationale on EXEMPT_PATHS in src/middleware/csrf.ts.
 */
function webHeaders(
  refreshToken: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    cookie: `session=${refreshToken}`,
    ...extra,
  };
}

/** Parse the one Set-Cookie header for the session cookie, if present. */
function sessionCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((cookie) => cookie.startsWith("session="));
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

describe("the authentication boundary", () => {
  integrationTest("lets /api/auth/refresh through without a bearer token", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
    });

    const res = await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    // The value of this assertion is entirely in the absence of an Authorization header: /api/* is
    // deny-by-default, so a 200 here proves DEFAULT_PUBLIC_PATHS covers this route.
    expect(res.status).toBe(200);
  });

  integrationTest("still guards /api/auth/sessions", async () => {
    const res = await app.request("/api/auth/sessions");

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    // The exemption is by exact path, so a sibling under the same prefix must stay protected.
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  integrationTest("does not exempt a route that merely shares a prefix", async () => {
    // isPublicPath matches whole segments; a bare startsWith would open this.
    const res = await post("/api/auth/refresh-everything");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Channel-aware delivery
// ---------------------------------------------------------------------------

describe("delivery", () => {
  integrationTest("gives a web session an HttpOnly cookie and no token in the body", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.ORG_ADMIN.id, {
      channel: "web",
    });

    const res = await post("/api/auth/refresh", {
      headers: webHeaders(seed.token),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The whole point of cookie delivery: a script that can read this response still cannot read
    // the refresh token out of it.
    expect(body.refresh_token).toBeUndefined();
    expect(body.access_token).toBeString();

    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Scoped to the two endpoints that consume it, so it rides on no other request.
    expect(cookie).toContain("Path=/api/auth");
  });

  integrationTest("gives a mobile session the token in the body and sets no cookie", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.INSTRUCTOR.id, {
      channel: "mobile",
    });

    const res = await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.refresh_token).toBeString();
    expect(sessionCookie(res)).toBeUndefined();
  });

  integrationTest("ignores a body token when a cookie is present", async () => {
    const web = await createRefreshSession(sql, tenant.schoolId, tenant.users.ORG_ADMIN.id, {
      channel: "web",
    });
    const attacker = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
    });

    const res = await post("/api/auth/refresh", {
      headers: webHeaders(web.token),
      body: JSON.stringify({ refresh_token: attacker.token }),
    });

    expect(res.status).toBe(200);
    // The cookie won, so the response is a web-channel one with no body token. If the body had been
    // preferred, a script able to set a request body could swap in a session of its choosing.
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("refresh_token");

    const [victim] = await sql<{ rotated_at: Date | null }[]>`
      SELECT rotated_at FROM app.refresh_tokens WHERE id = ${attacker.sessionId}
    `;
    expect(victim!.rotated_at).toBeNull();
  });

  integrationTest("cannot be talked out of cookie delivery by a header", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.ORG_ADMIN.id, {
      channel: "web",
    });

    const res = await post("/api/auth/refresh", {
      headers: webHeaders(seed.token, {
        // Headers a header-sniffing implementation would have honoured.
        "x-client-type": "mobile",
        "x-client-platform": "ios",
        "user-agent": "okhttp/4.9.0",
      }),
    });

    expect(res.status).toBe(200);
    // The channel is a stored property of the session, so this is not negotiable per request.
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("refresh_token");
    expect(sessionCookie(res)).toContain("HttpOnly");
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("failures", () => {
  integrationTest("answers problem+json correlated to the request id", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.STUDENT.id, {
      channel: "mobile",
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");

    const problem = (await res.json()) as Record<string, unknown>;
    expect(problem.code).toBe("AUTH_TOKEN_EXPIRED");
    expect(problem.status).toBe(401);
    // The correlation the ticket asks for: the body's request_id is the response header's value.
    expect(problem.request_id).toBe(res.headers.get("x-request-id"));
  });

  integrationTest("answers 400, not 401, when nothing was presented", async () => {
    const res = await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // A missing credential is a malformed request. Answering 401 would put a client with no cookie
    // into a refresh loop against an endpoint that can never accept it.
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
});

// ---------------------------------------------------------------------------
// Logout and session management
// ---------------------------------------------------------------------------

describe("logout", () => {
  integrationTest("revokes the family and clears the cookie", async () => {
    const seed = await createRefreshSession(sql, tenant.schoolId, tenant.users.INSTRUCTOR.id, {
      channel: "web",
    });

    const res = await post("/api/auth/logout", {
      headers: webHeaders(seed.token),
    });

    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie).toBeDefined();
    // Max-Age=0 is how a browser is told to drop it; the attributes must match the ones it was set
    // with or the deletion is ignored.
    expect(cookie).toContain("Max-Age=0");

    const [row] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app.refresh_tokens WHERE id = ${seed.sessionId}
    `;
    expect(row!.revoked_at).not.toBeNull();
  });

  integrationTest("answers identically for an unknown token, revealing nothing", async () => {
    const unknown = await post("/api/auth/logout", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0.Xk7pQ2abc" }),
    });
    const absent = await post("/api/auth/logout", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(unknown.status).toBe(200);
    expect(absent.status).toBe(200);
    expect(await unknown.json()).toEqual(await absent.json());
  });
});

describe("session management", () => {
  integrationTest("lists one entry per session, not per rotation", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const user = tenant.users.TEACHING_ASSISTANT;
    const device = await createUserDevice(sql, tenant.schoolId, user.id, { platform: "ios" });

    const seed = await createRefreshSession(sql, tenant.schoolId, user.id, {
      channel: "mobile",
      deviceId: device.id,
    });

    const config = {
      keyStore,
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
    };
    // Three rotations leave four rows in one family. A caller must still see one session.
    let current = seed.token;
    for (let i = 0; i < 3; i += 1) {
      current = (await rotateRefreshToken(sql, config, { presentedToken: current })).refreshToken;
    }

    const token = await mintTestToken(keyStore, { schoolId: tenant.schoolId, userId: user.id });
    const res = await app.request("/api/auth/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    const forDevice = body.sessions.filter((s) => s.device_id === device.id);

    expect(forDevice).toHaveLength(1);
    expect(forDevice[0]).toMatchObject({ channel: "mobile", device_id: device.id });
    // A session list is not a credential list.
    expect(forDevice[0]).not.toHaveProperty("token_hash");
    expect(forDevice[0]).not.toHaveProperty("locator");
  });

  integrationTest("terminating a session ends its whole family", async () => {
    const user = tenant.users.ORG_ADMIN;
    const seed = await createRefreshSession(sql, tenant.schoolId, user.id, { channel: "mobile" });

    const token = await mintTestToken(keyStore, { schoolId: tenant.schoolId, userId: user.id });
    const res = await app.request(`/api/auth/sessions/${seed.sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ revoked: 1 });

    // And the token stops working.
    const after = await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });
    expect(after.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe("logging", () => {
  integrationTest("never writes a refresh token, in any form, to a log sink", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const user = tenant.users.GUEST;
    const seed = await createRefreshSession(sql, tenant.schoolId, user.id, { channel: "mobile" });

    const config = {
      keyStore,
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
    };

    lines.length = 0;

    // Exercise every path that logs: success, reuse breach, and an outright rejection.
    const rotated = await rotateRefreshToken(sql, config, { presentedToken: seed.token });
    await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });
    await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: rotated.refreshToken }),
    });

    const written = JSON.stringify(lines);
    const secret = seed.token.split(".")[1]!;

    expect(written).not.toContain(seed.token);
    expect(written).not.toContain(secret);
    expect(written).not.toContain(rotated.refreshToken);
    // The locator is not a credential, but logging it would still make a log sink a session-lookup
    // index, so it stays out too.
    expect(written).not.toContain(seed.locator);
  });

  integrationTest("records a reuse breach at error level with the family as the key", async () => {
    const { rotateRefreshToken } = await import("../../src/modules/auth");
    const user = tenant.users.SUPPORT_AGENT;
    const seed = await createRefreshSession(sql, tenant.schoolId, user.id, { channel: "mobile" });

    const config = {
      keyStore,
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 30 * 24 * 60 * 60,
    };

    await rotateRefreshToken(sql, config, { presentedToken: seed.token });
    lines.length = 0;

    await post("/api/auth/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: seed.token }),
    });

    const breach = lines.find((line) => line.event === "refresh_token_reuse_detected");
    expect(breach).toBeDefined();
    // 50 is pino's `error`. A theft signal that lands at warn gets lost among ordinary 401s.
    expect(breach!.level).toBe(50);
    expect(breach!.family_id).toBe(seed.familyId);
  });
});
