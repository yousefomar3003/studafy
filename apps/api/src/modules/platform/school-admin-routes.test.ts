import { OpenAPIHono } from "@hono/zod-openapi";
import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../auth/channels";

import { platformRoutes } from "./routes";

import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { AuthContext } from "../../middleware/authContext";
import type { AppEnv } from "../../middleware/requestId";
import type { AuthChannel } from "../auth/channels";
import type { Role } from "@studafy/constants";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SCHOOL_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const EXPORT_ID = "00000000-0000-4000-8000-000000000004";

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
    platformRoutes({
      database: untouchableDatabase,
      redis: null,
      paymentProvider: null,
      logger: silentLogger,
      storage: null,
    }),
  );
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

const send = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const schoolRoles: Role[] = [
  ROLES.ORG_ADMIN,
  ROLES.PRINCIPAL,
  ROLES.FINANCE,
  ROLES.SUPPORT_AGENT,
  ROLES.INSTRUCTOR,
  ROLES.STUDENT,
  ROLES.PARENT,
];

describe("platform school administration authorization", () => {
  for (const role of schoolRoles) {
    test(`${role} cannot edit a school's profile`, async () => {
      const res = await buildApp(auth([role])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/profile`,
        send("PATCH", { name: "New name", reason: "Because" }),
      );
      expect(res.status).toBe(403);
    });

    test(`${role} cannot read a school's usage`, async () => {
      const res = await buildApp(auth([role])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/usage`,
      );
      expect(res.status).toBe(403);
    });

    test(`${role} cannot export a school`, async () => {
      const res = await buildApp(auth([role])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/exports`,
        send("POST", { reason: "Backup" }),
      );
      expect(res.status).toBe(403);
    });

    test(`${role} cannot read an export's download link`, async () => {
      const res = await buildApp(auth([role])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/exports/${EXPORT_ID}`,
      );
      expect(res.status).toBe(403);
    });
  }

  test("a SUPER_ADMIN on a mobile session cannot export a school", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN], AUTH_CHANNELS.MOBILE)).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/exports`,
      send("POST", { reason: "Backup" }),
    );
    expect(res.status).toBe(403);
  });
});

describe("platform school administration validation", () => {
  test("a profile edit without a reason is rejected before the database", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/profile`,
      send("PATCH", { name: "New name" }),
    );
    expect(res.status).toBe(400);
  });

  test("a profile edit that names no field is rejected", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/profile`,
      send("PATCH", { reason: "Nothing to change" }),
    );
    expect(res.status).toBe(400);
  });

  test("an unsupported language or a malformed timezone is rejected", async () => {
    for (const body of [
      { locale: "xx", reason: "Language" },
      { timezone: "Not a zone", reason: "Timezone" },
      { countryCode: "JOR", reason: "Country" },
      { email: "not-an-email", reason: "Email" },
    ]) {
      const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
        `/api/platform/schools/${OTHER_SCHOOL_ID}/profile`,
        send("PATCH", body),
      );
      expect(res.status).toBe(400);
    }
  });

  test("a profile edit cannot touch fields outside the profile", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/profile`,
      send("PATCH", { slug: "new-slug", reason: "Slug" }),
    );
    expect(res.status).toBe(400);
  });

  test("an export without a reason is rejected", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/exports`,
      send("POST", {}),
    );
    expect(res.status).toBe(400);
  });

  test("an export with no queue configured answers 503 before the database", async () => {
    const res = await buildApp(auth([ROLES.SUPER_ADMIN])).request(
      `/api/platform/schools/${OTHER_SCHOOL_ID}/exports`,
      send("POST", { reason: "Backup before migration" }),
    );
    expect(res.status).toBe(503);
  });
});
