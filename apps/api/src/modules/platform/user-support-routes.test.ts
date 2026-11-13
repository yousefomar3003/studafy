import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../auth/channels";

import { platformUserSupportRoutes } from "./user-support-routes";

import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { AuthContext } from "../../middleware/authContext";
import type { AppEnv } from "../../middleware/requestId";
import type { AuthChannel } from "../auth/channels";
import type { Role } from "@studafy/constants";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const TARGET_SCHOOL_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_USER_ID = "00000000-0000-4000-8000-000000000004";

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

function auth(roles: readonly Role[], channel: AuthChannel = AUTH_CHANNELS.WEB): AuthContext {
  return {
    userId: USER_ID,
    schoolId: SCHOOL_ID,
    roles,
    channel,
    jti: "jti-1",
    exp: Math.floor(Date.now() / 1000) + 900,
    entitlementsVer: 1,
    subscriptionStatus: "active",
  };
}

/** A database that fails the test if any route reaches it -- denials must happen before the DB. */
const untouchableDatabase = Object.assign((() => undefined) as unknown as Database, {
  begin: () => {
    throw new Error("database must not be reached");
  },
});

function buildApp(authCtx: AuthContext) {
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", authCtx);
    c.set("locale", "en");
    c.set("log", silentLogger);
    await next();
  });
  app.route(
    "/",
    platformUserSupportRoutes({
      database: untouchableDatabase,
      denylist: null,
      logger: silentLogger,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const base = `/api/platform/schools/${TARGET_SCHOOL_ID}/users/${TARGET_USER_ID}`;
const ACTIONS = ["invitation/resend", "sessions/revoke", "unlock", "deactivate", "reactivate"];

const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("platform support actions: authorization", () => {
  for (const role of [ROLES.ORG_ADMIN, ROLES.PRINCIPAL, ROLES.SUPPORT_AGENT]) {
    test(`${role} cannot read the support panel`, async () => {
      const res = await buildApp(auth([role])).request(base);
      expect(res.status).toBe(403);
    });

    for (const action of ACTIONS) {
      test(`${role} cannot ${action}`, async () => {
        const res = await buildApp(auth([role])).request(
          `${base}/${action}`,
          post({ reason: "support ticket 42" }),
        );
        expect(res.status).toBe(403);
      });
    }
  }

  for (const action of ACTIONS) {
    test(`a SUPER_ADMIN on a mobile session cannot ${action}`, async () => {
      const res = await buildApp(auth([ROLES.SUPER_ADMIN], AUTH_CHANNELS.MOBILE)).request(
        `${base}/${action}`,
        post({ reason: "support ticket 42" }),
      );
      expect(res.status).toBe(403);
    });
  }
});

describe("platform support actions: a reason is required", () => {
  for (const action of ACTIONS) {
    test(`${action} without a reason is refused before the database`, async () => {
      const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(`${base}/${action}`, post({}));
      expect(res.status).toBe(400);
    });

    test(`${action} with a blank reason is refused`, async () => {
      const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
        `${base}/${action}`,
        post({ reason: "  a " }),
      );
      expect(res.status).toBe(400);
    });
  }

  test("a malformed user id is refused before the database", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${TARGET_SCHOOL_ID}/users/not-a-uuid/unlock`,
      post({ reason: "support ticket 42" }),
    );
    expect(res.status).toBe(400);
  });
});
