/**
 * Who may reach the refund routes. Every denial below must happen before the database: the
 * database stub fails the test if it is touched, and a request that gets past every guard stops at
 * body/query validation (400), which proves the guards let it through.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { openApiValidationHook } from "../../../openapi/hook";
import { AUTH_CHANNELS } from "../../auth/channels";
import { refundAdminRoutes } from "../routes/refund-admin-routes";
import { refundRequestRoutes } from "../routes/refund-routes";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { AuthChannel } from "../../auth/channels";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { Role } from "@studafy/constants";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const BASE = `/api/platform/refund-requests/${SCHOOL_ID}/${REQUEST_ID}`;

const silentLogger: Logger = {
  level: "info",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

const database = Object.assign((() => undefined) as unknown as Database, {
  begin: () => {
    throw new Error("database must not be reached");
  },
});
const providers: PaymentProviderRegistry = { stripe: null, tap: null };

function appFor(roles: readonly Role[], channel: AuthChannel = AUTH_CHANNELS.WEB) {
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });
  app.use("*", async (c, next) => {
    c.set("auth", {
      userId: "00000000-0000-4000-8000-000000000003",
      schoolId: SCHOOL_ID,
      roles,
      channel,
      jti: "jti-1",
      entitlementsVer: 1,
      subscriptionStatus: "active",
    });
    c.set("log", silentLogger);
    c.set("requestId", "req-1");
    c.set("locale", "en");
    await next();
  });
  app.route("/", refundRequestRoutes(database, providers));
  app.route("/", refundAdminRoutes(database, providers));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

async function call(
  app: OpenAPIHono<AppEnv>,
  method: "GET" | "POST",
  path: string,
  body: unknown = {},
): Promise<{ status: number; code?: string }> {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, code: json.code };
}

describe("requester routes", () => {
  test("the school plan's request needs the billing permission", async () => {
    const res = await call(
      appFor([ROLES.INSTRUCTOR]),
      "POST",
      "/api/subscriptions/current/refund-requests",
    );
    expect(res.status).toBe(403);
    expect(res.code).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
  });

  test("a billing admin reaches body validation", async () => {
    const res = await call(
      appFor([ROLES.ORG_ADMIN]),
      "POST",
      "/api/subscriptions/current/refund-requests",
      { reason: "not-a-reason" },
    );
    expect(res.status).toBe(400);
  });

  test("the AI add-on request has no route-time permission, only the web channel", async () => {
    const web = await call(appFor([ROLES.PARENT]), "POST", "/api/subscriptions/ai/refund-requests");
    expect(web.status).toBe(400);

    const mobile = await call(
      appFor([ROLES.PARENT], AUTH_CHANNELS.MOBILE),
      "POST",
      "/api/subscriptions/ai/refund-requests",
    );
    expect(mobile.status).toBe(403);
    expect(mobile.code).toBe(ERROR_CODES.CHANNEL_NOT_AUTHORIZED);
  });
});

describe("platform console routes", () => {
  const consoleRoutes: ["GET" | "POST", string][] = [
    ["GET", "/api/platform/refund-requests"],
    ["GET", BASE],
    ["POST", `${BASE}/approve`],
    ["POST", `${BASE}/reject`],
  ];

  test.each(consoleRoutes)("a school admin is refused %s %s", async (method, path) => {
    const res = await call(appFor([ROLES.ORG_ADMIN]), method, path);
    expect(res.status).toBe(403);
    expect(res.code).toBe(ERROR_CODES.AUTHZ_FORBIDDEN);
  });

  test.each(consoleRoutes)("a mobile session is refused %s %s", async (method, path) => {
    const res = await call(appFor([ROLES.SUPER_ADMIN], AUTH_CHANNELS.MOBILE), method, path);
    expect(res.status).toBe(403);
    expect(res.code).toBe(ERROR_CODES.CHANNEL_NOT_AUTHORIZED);
  });

  test("a super admin reaches validation: a rejection needs a note", async () => {
    const res = await call(appFor([ROLES.SUPER_ADMIN]), "POST", `${BASE}/reject`, { note: "  " });
    expect(res.status).toBe(400);
  });

  test("a super admin reaches validation: an approval amount must be positive", async () => {
    const res = await call(appFor([ROLES.SUPER_ADMIN]), "POST", `${BASE}/approve`, {
      amountMinor: 0,
    });
    expect(res.status).toBe(400);
  });

  test("a super admin reaches validation: the list query is checked", async () => {
    const res = await call(
      appFor([ROLES.SUPER_ADMIN]),
      "GET",
      "/api/platform/refund-requests?status=unknown",
    );
    expect(res.status).toBe(400);
  });
});
