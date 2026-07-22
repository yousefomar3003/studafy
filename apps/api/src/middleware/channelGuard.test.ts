/**
 * Channel guard middleware tests.
 *
 * Verifies that the channel guard correctly:
 * 1. Allows sessions on the expected channel through to the handler.
 * 2. Denies sessions on unexpected channels with CHANNEL_NOT_AUTHORIZED (403).
 * 3. Returns 401 when there is no auth context (same precedence as requirePermission).
 * 4. Audits the denial with structured log fields.
 * 5. Does not leak the channel restriction detail in the response body.
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { describe, expect, it } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { Hono } from "hono";

import { requireChannel } from "./channelGuard";

import type { AuthContext } from "./authContext";
import type { AppEnv } from "./requestId";
import type { AuthChannel } from "../modules/auth/channels";
import type { Role } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextFor(channel: AuthChannel, roles: Role[] = ["ORG_ADMIN"]): AuthContext {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    schoolId: "22222222-2222-4222-8222-222222222222",
    roles,
    channel,
    jti: "33333333-3333-4333-8333-333333333333",
    entitlementsVer: 1,
  };
}

/**
 * Build a minimal Hono app behind the channel guard.
 *
 * Returns the app and the captured log.warn arguments so tests can inspect the
 * denial audit trail without coupling to the logger implementation.
 */
function appWith(auth: AuthContext | undefined): {
  app: Hono<AppEnv>;
  warnings: unknown[][];
} {
  const app = new Hono<AppEnv>();
  const warnings: unknown[][] = [];

  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    c.set("log", {
      warn: (...args: unknown[]) => warnings.push(args),
    } as never);
    await next();
  });
  app.use("/guarded", requireChannel("web"));
  app.get("/guarded", (c) => c.json({ reached: true }));

  return { app, warnings };
}

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

describe("requireChannel", () => {
  it("passes a web-channel caller through to the handler", async () => {
    const { app } = appWith(contextFor("web"));
    const res = await app.request("/guarded");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it("denies a mobile-channel caller", async () => {
    const { app } = appWith(contextFor("mobile"));
    const res = await app.request("/guarded");

    expect(res.status).toBe(403);
  });

  it("denies an api-channel caller", async () => {
    const { app } = appWith(contextFor("api"));
    const res = await app.request("/guarded");

    expect(res.status).toBe(403);
  });

  it("answers 401 when there is no auth context", async () => {
    const { app } = appWith(undefined);
    const res = await app.request("/guarded");

    // Same precedence logic as requirePermission: unauthenticated callers must not
    // learn whether a channel restriction exists.
    expect(res.status).toBe(401);
  });

  it("does not leak the channel restriction in the response body", async () => {
    const { app } = appWith(contextFor("mobile"));
    const res = await app.request("/guarded");
    const body = await res.text();

    expect(body).not.toContain("channel");
    expect(body).not.toContain("mobile");
    expect(body).not.toContain("web-only");
  });

  it("audits the denial with event, allowed_channels, actual_channel, and route", async () => {
    const { app, warnings } = appWith(contextFor("mobile"));
    await app.request("/guarded");

    expect(warnings).toHaveLength(1);

    const [payload] = warnings[0]!;
    expect(payload).toEqual(
      expect.objectContaining({
        event: "channel_denied",
        allowed_channels: ["web"],
        actual_channel: "mobile",
        route: "/guarded",
      }),
    );
  });

  it("includes actor_roles in the denial audit", async () => {
    const { app, warnings } = appWith(contextFor("mobile", ["ORG_ADMIN", "INSTRUCTOR"]));
    await app.request("/guarded");

    const [payload] = warnings[0]!;
    expect(payload).toEqual(
      expect.objectContaining({
        actor_roles: ["ORG_ADMIN", "INSTRUCTOR"],
      }),
    );
  });

  it("allows multiple allowed channels", async () => {
    const app = new Hono<AppEnv>();

    app.use("*", async (c, next) => {
      c.set("auth", contextFor("api"));
      c.set("log", { warn: () => undefined } as never);
      await next();
    });
    app.use("/guarded", requireChannel("web", "api"));
    app.get("/guarded", (c) => c.json({ reached: true }));

    const res = await app.request("/guarded");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });
});
