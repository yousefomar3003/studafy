/**
 * Permission enforcement (ST-072).
 *
 * The matrix itself is tested in packages/constants — this file tests only the enforcement point:
 * that the middleware asks the right question, gets 401 and 403 precedence right, and keeps the
 * answer out of the response body.
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { hasPermission, requirePermission } from "./authz";

import type { AuthContext } from "./authContext";
import type { AppEnv } from "./requestId";
import type { Role } from "@studafy/constants";

// ---------------------------------------------------------------------------
// The matrix lookup
// ---------------------------------------------------------------------------

describe("hasPermission", () => {
  it("grants SUPER_ADMIN everything", () => {
    expect(hasPermission([ROLES.SUPER_ADMIN], PERMISSIONS.USER_SUSPEND)).toBe(true);
    expect(hasPermission([ROLES.SUPER_ADMIN], PERMISSIONS.USER_IMPERSONATE)).toBe(true);
  });

  it("grants ORG_ADMIN the permission the admin device routes gate on", () => {
    // If this ever flips, the admin revocation routes silently become unreachable for the role that
    // is meant to use them, and only an integration test would notice.
    expect(hasPermission([ROLES.ORG_ADMIN], PERMISSIONS.USER_SUSPEND)).toBe(true);
  });

  it("denies the teaching and learning roles", () => {
    for (const role of [ROLES.STUDENT, ROLES.INSTRUCTOR, ROLES.TEACHING_ASSISTANT, ROLES.GUEST]) {
      expect(hasPermission([role], PERMISSIONS.USER_SUSPEND)).toBe(false);
    }
  });

  it("unions permissions across several roles", () => {
    // An instructor who is also an org admin does both jobs from one token.
    expect(hasPermission([ROLES.INSTRUCTOR, ROLES.ORG_ADMIN], PERMISSIONS.USER_SUSPEND)).toBe(true);
  });

  it("denies an empty role list", () => {
    expect(hasPermission([], PERMISSIONS.USER_SUSPEND)).toBe(false);
  });

  it("denies a role that is not in the matrix", () => {
    // The claim is validated against the ROLES enum before it reaches here, but an authorization
    // check must not depend on a guarantee established in another module. A Map lookup cannot walk a
    // prototype chain, so neither of these can resolve to something truthy.
    expect(hasPermission(["nonsense" as Role], PERMISSIONS.USER_SUSPEND)).toBe(false);
    expect(hasPermission(["constructor" as Role], PERMISSIONS.USER_SUSPEND)).toBe(false);
    expect(hasPermission(["__proto__" as Role], PERMISSIONS.USER_SUSPEND)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

function appWith(auth: AuthContext | undefined): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const warnings: unknown[][] = [];

  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    c.set("log", {
      warn: (...args: unknown[]) => warnings.push(args),
    } as never);
    await next();
  });
  app.use("/guarded", requirePermission(PERMISSIONS.USER_SUSPEND));
  app.get("/guarded", (c) => c.json({ reached: true }));

  return app;
}

function contextFor(roles: Role[]): AuthContext {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    schoolId: "22222222-2222-4222-8222-222222222222",
    roles,
    channel: "api",
    jti: "33333333-3333-4333-8333-333333333333",
    entitlementsVer: 1,
  };
}

describe("requirePermission", () => {
  it("passes a caller holding the permission through to the handler", async () => {
    const res = await appWith(contextFor([ROLES.ORG_ADMIN])).request("/guarded");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it("rejects a caller without it", async () => {
    const res = await appWith(contextFor([ROLES.STUDENT])).request("/guarded");

    expect(res.status).toBe(403);
  });

  it("answers 401 rather than 403 when there is no auth context at all", async () => {
    const res = await appWith(undefined).request("/guarded");

    // Precedence matters: if an anonymous caller got a 403, the status code alone would tell them
    // the route exists and what it needs, turning the boundary into a discovery tool.
    expect(res.status).toBe(401);
  });

  it("does not name the missing permission in the response", async () => {
    const res = await appWith(contextFor([ROLES.STUDENT])).request("/guarded");
    const body = await res.text();

    // The log carries it; the response must not, or the permission matrix can be mapped by probing.
    expect(body).not.toContain("user:suspend");
    expect(body).not.toContain("USER_SUSPEND");
  });
});
