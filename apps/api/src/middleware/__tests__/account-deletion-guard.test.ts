/**
 * Account deletion guard (000143): a session whose token carries `deletion_pending` reaches only
 * the profile, the cancel route and logout; every other session is untouched.
 */

// Imported before src/middleware — see the note at the top of tests/auth/support.ts.
import "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { CodedHttpException } from "../../coded-http-exception";
import { accountDeletionGuard } from "../account-deletion-guard";

import type { AuthContext } from "../authContext";
import type { AppEnv } from "../requestId";

function contextFor(deletionPending: boolean): AuthContext {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    schoolId: "22222222-2222-4222-8222-222222222222",
    roles: [ROLES.PARENT],
    channel: "mobile",
    jti: "33333333-3333-4333-8333-333333333333",
    entitlementsVer: 1,
    subscriptionStatus: "active",
    deletionPending,
  };
}

function appWith(auth: AuthContext | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    if (auth) c.set("auth", auth);
    await next();
  });
  app.use("*", accountDeletionGuard());
  app.get("/api/account/profile", (c) => c.text("profile"));
  app.delete("/api/account/deletion", (c) => c.text("cancelled"));
  app.post("/api/account/deletion", (c) => c.text("scheduled"));
  app.post("/api/auth/logout", (c) => c.text("logged out"));
  app.get("/api/students/me", (c) => c.text("student"));
  app.onError((error, c) =>
    error instanceof CodedHttpException
      ? c.json({ code: error.code }, error.status)
      : c.text("unexpected", 500),
  );
  return app;
}

describe("accountDeletionGuard", () => {
  it("lets a pending session read its profile, cancel and log out", async () => {
    const app = appWith(contextFor(true));
    expect((await app.request("/api/account/profile")).status).toBe(200);
    expect((await app.request("/api/account/deletion", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/api/auth/logout", { method: "POST" })).status).toBe(200);
  });

  it("refuses everything else for a pending session", async () => {
    const app = appWith(contextFor(true));
    const read = await app.request("/api/students/me");
    expect(read.status).toBe(403);
    expect(((await read.json()) as { code: string }).code).toBe("ACCOUNT_DELETION_SCHEDULED");
    expect((await app.request("/api/account/deletion", { method: "POST" })).status).toBe(403);
  });

  it("does not touch sessions without a pending deletion, or unauthenticated requests", async () => {
    expect((await appWith(contextFor(false)).request("/api/students/me")).status).toBe(200);
    expect((await appWith(null).request("/api/students/me")).status).toBe(200);
  });
});
