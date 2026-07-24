/**
 * Tenant lifecycle guard middleware (ST-092).
 *
 * Enforces the subscription lifecycle state machine on every authenticated request.
 * Tests cover all four core states (trialing, active, grace_period, suspended, closed)
 * and verify role-based access rules during suspension.
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { ROLES, SUBSCRIPTION_STATUSES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { tenantLifecycleGuard } from "../tenant-lifecycle";

import type { AuthContext } from "../authContext";
import type { AppEnv } from "../requestId";
import type { Role, SubscriptionStatus } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUDY_UUID = "22222222-2222-4222-8222-222222222222";
const USER_UUID = "11111111-1111-4111-8111-111111111111";
const JTI_UUID = "33333333-3333-4333-8333-333333333333";

function contextFor(roles: Role[], subscriptionStatus: SubscriptionStatus): AuthContext {
  return {
    userId: USER_UUID,
    schoolId: STUDY_UUID,
    roles,
    channel: "api",
    jti: JTI_UUID,
    entitlementsVer: 1,
    subscriptionStatus,
  };
}

/**
 * Build a minimal Hono app behind the lifecycle guard.
 *
 * Registers GET, POST, PUT, PATCH, DELETE handlers on /resource so tests can exercise
 * every HTTP method. Returns the app for `app.request()` assertions.
 */
function appWith(auth: AuthContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("log", {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => appWith,
    } as never);
    await next();
  });
  app.use("/api/*", tenantLifecycleGuard());
  app.get("/api/resource", (c) => c.json({ method: "GET" }));
  app.post("/api/resource", (c) => c.json({ method: "POST" }));
  app.put("/api/resource", (c) => c.json({ method: "PUT" }));
  app.patch("/api/resource", (c) => c.json({ method: "PATCH" }));
  app.delete("/api/resource", (c) => c.json({ method: "DELETE" }));

  return app;
}

// ---------------------------------------------------------------------------
// closed state — all traffic blocked
// ---------------------------------------------------------------------------

describe("tenantLifecycleGuard — closed", () => {
  const auth = contextFor([ROLES.ORG_ADMIN], SUBSCRIPTION_STATUSES.CLOSED);

  it("blocks GET requests", async () => {
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    expect(res.status).toBe(403);
  });

  it("blocks POST requests", async () => {
    const app = appWith(auth);
    const res = await app.request("/api/resource", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("blocks all roles including SUPER_ADMIN", async () => {
    const superAdmin = contextFor([ROLES.SUPER_ADMIN], SUBSCRIPTION_STATUSES.CLOSED);
    const app = appWith(superAdmin);
    const res = await app.request("/api/resource");
    expect(res.status).toBe(403);
  });

  it("returns TENANT_CLOSED error code", async () => {
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    const body = await res.text();
    expect(body).toContain("permanently closed");
  });
});

// ---------------------------------------------------------------------------
// suspended state — read-only for ORG_ADMIN and FINANCE
// ---------------------------------------------------------------------------

describe("tenantLifecycleGuard — suspended", () => {
  describe("write operations blocked for all roles", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      it(`blocks ${method} for ORG_ADMIN`, async () => {
        const auth = contextFor([ROLES.ORG_ADMIN], "suspended" as SubscriptionStatus);
        const app = appWith(auth);
        const res = await app.request("/api/resource", { method });
        expect(res.status).toBe(403);
      });
    }
  });

  describe("GET allowed only for ORG_ADMIN and FINANCE", () => {
    it("allows GET for ORG_ADMIN", async () => {
      const auth = contextFor([ROLES.ORG_ADMIN], "suspended" as SubscriptionStatus);
      const app = appWith(auth);
      const res = await app.request("/api/resource");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ method: "GET" });
    });

    it("allows GET for FINANCE", async () => {
      const auth = contextFor([ROLES.FINANCE], "suspended" as SubscriptionStatus);
      const app = appWith(auth);
      const res = await app.request("/api/resource");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ method: "GET" });
    });

    it("allows GET for user with both ORG_ADMIN and FINANCE roles", async () => {
      const auth = contextFor([ROLES.ORG_ADMIN, ROLES.FINANCE], "suspended" as SubscriptionStatus);
      const app = appWith(auth);
      const res = await app.request("/api/resource");
      expect(res.status).toBe(200);
    });
  });

  describe("GET blocked for non-admin/non-finance roles", () => {
    for (const role of [
      ROLES.INSTRUCTOR,
      ROLES.TEACHING_ASSISTANT,
      ROLES.STUDENT,
      ROLES.GUEST,
      ROLES.SUPPORT_AGENT,
    ]) {
      it(`blocks GET for ${role}`, async () => {
        const auth = contextFor([role], "suspended" as SubscriptionStatus);
        const app = appWith(auth);
        const res = await app.request("/api/resource");
        expect(res.status).toBe(403);
      });
    }
  });

  it("returns TENANT_SUSPENDED error code for blocked writes", async () => {
    const auth = contextFor([ROLES.ORG_ADMIN], "suspended" as SubscriptionStatus);
    const app = appWith(auth);
    const res = await app.request("/api/resource", { method: "POST" });
    const body = await res.text();
    expect(body).toContain("suspended");
  });

  it("returns TENANT_SUSPENDED error code for blocked reads", async () => {
    const auth = contextFor([ROLES.STUDENT], "suspended" as SubscriptionStatus);
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    const body = await res.text();
    expect(body).toContain("suspended");
  });
});

// ---------------------------------------------------------------------------
// grace_period state — full access with banner header
// ---------------------------------------------------------------------------

describe("tenantLifecycleGuard — grace_period", () => {
  it("allows GET requests", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.GRACE_PERIOD);
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    expect(res.status).toBe(200);
  });

  it("allows POST requests", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.GRACE_PERIOD);
    const app = appWith(auth);
    const res = await app.request("/api/resource", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("sets X-Tenant-Grace-Banner header on GET", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.GRACE_PERIOD);
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    expect(res.headers.get("x-tenant-grace-banner")).toBe("true");
  });

  it("sets X-Tenant-Grace-Banner header on POST", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.GRACE_PERIOD);
    const app = appWith(auth);
    const res = await app.request("/api/resource", { method: "POST" });
    expect(res.headers.get("x-tenant-grace-banner")).toBe("true");
  });

  it("allows all roles", async () => {
    for (const role of [ROLES.ORG_ADMIN, ROLES.INSTRUCTOR, ROLES.STUDENT, ROLES.FINANCE]) {
      const auth = contextFor([role], SUBSCRIPTION_STATUSES.GRACE_PERIOD);
      const app = appWith(auth);
      const res = await app.request("/api/resource");
      expect(res.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// trialing state — standard access
// ---------------------------------------------------------------------------

describe("tenantLifecycleGuard — trialing", () => {
  it("allows GET requests", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.TRIALING);
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    expect(res.status).toBe(200);
  });

  it("allows POST requests", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.TRIALING);
    const app = appWith(auth);
    const res = await app.request("/api/resource", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("does not set grace banner header", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.TRIALING);
    const app = appWith(auth);
    const res = await app.request("/api/resource");
    expect(res.headers.get("x-tenant-grace-banner")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// active state — standard access
// ---------------------------------------------------------------------------

describe("tenantLifecycleGuard — active", () => {
  it("allows all operations without banner", async () => {
    const auth = contextFor([ROLES.STUDENT], SUBSCRIPTION_STATUSES.ACTIVE);
    const app = appWith(auth);

    const getRes = await app.request("/api/resource");
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("x-tenant-grace-banner")).toBeNull();

    const postRes = await app.request("/api/resource", { method: "POST" });
    expect(postRes.status).toBe(200);
    expect(postRes.headers.get("x-tenant-grace-banner")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// past_due / canceled / expired — standard access (soft states)
// ---------------------------------------------------------------------------

describe("tenantLifecycleGuard — soft terminal states", () => {
  for (const status of [
    SUBSCRIPTION_STATUSES.PAST_DUE,
    SUBSCRIPTION_STATUSES.CANCELED,
    SUBSCRIPTION_STATUSES.EXPIRED,
  ]) {
    it(`allows access for ${status}`, async () => {
      const auth = contextFor([ROLES.STUDENT], status);
      const app = appWith(auth);
      const res = await app.request("/api/resource");
      expect(res.status).toBe(200);
    });
  }
});
