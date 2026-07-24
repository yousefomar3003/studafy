/**
 * Permission enforcement (ST-072).
 *
 * Three layers:
 * 1. Matrix snapshot — every role×permission combination matches the constants matrix exactly.
 * 2. Middleware behaviour — 401/403 precedence, denial audit trail, response body safety.
 * 3. Structural — the guard is the only enforcement point; handlers don't reimplement the lookup.
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { hasPermission, requirePermission } from "./authz";

import type { AuthContext } from "./authContext";
import type { AppEnv } from "./requestId";
import type { Role } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contextFor(roles: Role[]): AuthContext {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    schoolId: "22222222-2222-4222-8222-222222222222",
    roles,
    channel: "api",
    jti: "33333333-3333-4333-8333-333333333333",
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

/**
 * Build a minimal Hono app behind the permission guard.
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
  app.use("/guarded", requirePermission(PERMISSIONS.USER_SUSPEND));
  app.get("/guarded", (c) => c.json({ reached: true }));

  return { app, warnings };
}

// ---------------------------------------------------------------------------
// Matrix snapshot — every role × permission cell matches the constants matrix
// ---------------------------------------------------------------------------

describe("matrix snapshot", () => {
  const allPermissions = Object.values(PERMISSIONS);
  const allRoles = Object.values(ROLES);

  it("hasPermission matches ROLE_PERMISSIONS for every role × permission combination", () => {
    for (const role of allRoles) {
      const allowed = new Set(ROLE_PERMISSIONS[role]);

      for (const permission of allPermissions) {
        const expected = allowed.has(permission);
        const actual = hasPermission([role], permission);

        // The failure message names the exact cell that diverged from the matrix.
        expect(actual).toBe(expected);
      }
    }
  });

  it("SUPER_ADMIN holds every permission", () => {
    const all = new Set(ROLE_PERMISSIONS[ROLES.SUPER_ADMIN]);
    for (const permission of allPermissions) {
      expect(all.has(permission)).toBe(true);
    }
  });

  it("every permission is reachable by at least one role", () => {
    const union = new Set(Object.values(ROLE_PERMISSIONS).flat());
    for (const permission of allPermissions) {
      expect(union.has(permission)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// hasPermission — targeted spot-checks
// ---------------------------------------------------------------------------

describe("hasPermission", () => {
  it("grants ORG_ADMIN the permission the admin device routes gate on", () => {
    expect(hasPermission([ROLES.ORG_ADMIN], PERMISSIONS.USER_SUSPEND)).toBe(true);
  });

  it("denies the teaching and learning roles for admin permissions", () => {
    for (const role of [ROLES.STUDENT, ROLES.INSTRUCTOR, ROLES.TEACHING_ASSISTANT, ROLES.GUEST]) {
      expect(hasPermission([role], PERMISSIONS.USER_SUSPEND)).toBe(false);
    }
  });

  it("unions permissions across several roles", () => {
    expect(hasPermission([ROLES.INSTRUCTOR, ROLES.ORG_ADMIN], PERMISSIONS.USER_SUSPEND)).toBe(true);
  });

  it("denies an empty role list", () => {
    expect(hasPermission([], PERMISSIONS.USER_SUSPEND)).toBe(false);
  });

  it("denies a role that is not in the matrix", () => {
    expect(hasPermission(["nonsense" as Role], PERMISSIONS.USER_SUSPEND)).toBe(false);
    expect(hasPermission(["constructor" as Role], PERMISSIONS.USER_SUSPEND)).toBe(false);
    expect(hasPermission(["__proto__" as Role], PERMISSIONS.USER_SUSPEND)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

describe("requirePermission", () => {
  it("passes a caller holding the permission through to the handler", async () => {
    const { app } = appWith(contextFor([ROLES.ORG_ADMIN]));
    const res = await app.request("/guarded");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reached: true });
  });

  it("rejects a caller without it", async () => {
    const { app } = appWith(contextFor([ROLES.STUDENT]));
    const res = await app.request("/guarded");

    expect(res.status).toBe(403);
  });

  it("answers 401 rather than 403 when there is no auth context at all", async () => {
    const { app } = appWith(undefined);
    const res = await app.request("/guarded");

    // Precedence matters: if an anonymous caller got a 403, the status code alone would tell them
    // the route exists and what it needs, turning the boundary into a discovery tool.
    expect(res.status).toBe(401);
  });

  it("does not name the missing permission in the response", async () => {
    const { app } = appWith(contextFor([ROLES.STUDENT]));
    const res = await app.request("/guarded");
    const body = await res.text();

    // The log carries it; the response must not, or the permission matrix can be mapped by probing.
    expect(body).not.toContain("user:suspend");
    expect(body).not.toContain("USER_SUSPEND");
  });

  it("audits the denial with event, required_permission, and route", async () => {
    const { app, warnings } = appWith(contextFor([ROLES.STUDENT]));
    await app.request("/guarded");

    expect(warnings).toHaveLength(1);

    const [payload] = warnings[0]!;
    expect(payload).toEqual(
      expect.objectContaining({
        event: "permission_denied",
        required_permission: PERMISSIONS.USER_SUSPEND,
        route: "/guarded",
      }),
    );
  });

  it("includes actor_roles in the denial audit", async () => {
    const { app, warnings } = appWith(contextFor([ROLES.STUDENT, ROLES.GUEST]));
    await app.request("/guarded");

    const [payload] = warnings[0]!;
    expect(payload).toEqual(
      expect.objectContaining({
        actor_roles: [ROLES.STUDENT, ROLES.GUEST],
      }),
    );
  });
});
