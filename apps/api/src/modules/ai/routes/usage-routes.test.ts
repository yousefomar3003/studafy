import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiUsageRoutes } from "./usage-routes";

import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { SchoolEntitlement, AiEntitlement } from "../../subscriptions/entitlements/resolve";
import type { AiUsageSnapshot, AiTokenMeter } from "../usage/meter";

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";
const PERIOD_START = "2026-08-01T00:00:00.000Z";
const PERIOD_END = "2026-08-31T23:59:59.000Z";

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

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

function schoolEntitlement(active: boolean): SchoolEntitlement {
  return {
    schoolId: SCHOOL_ID,
    version: 1,
    subscriptionId: "sub-1",
    status: active ? "active" : "closed",
    active,
    planCode: "growth",
    quotas: { studentCap: 50 },
    currentPeriodEnd: PERIOD_END,
  };
}

function aiEntitlement(active: boolean, hasPeriod = true): AiEntitlement {
  return {
    schoolId: SCHOOL_ID,
    studentId: STUDENT_ID,
    version: 1,
    schoolVersion: 1,
    status: active ? "active" : null,
    active,
    currentPeriodStart: hasPeriod ? PERIOD_START : null,
    currentPeriodEnd: hasPeriod ? PERIOD_END : null,
  };
}

function fakeEntitlements(school: SchoolEntitlement, ai: AiEntitlement) {
  return {
    school: async () => school,
    ai: async () => ai,
  };
}

function snapshotMeter(snapshot: AiUsageSnapshot): AiTokenMeter {
  return {
    reserve: async () => ({ ok: true, reservationId: "res-1", reservedTokens: 1, remaining: 0 }),
    commit: async () => ({ settled: true, remaining: 0 }),
    release: async () => ({ settled: true, remaining: 0 }),
    snapshot: async () => snapshot,
  };
}

const SNAPSHOT: AiUsageSnapshot = {
  active: true,
  budget: 100,
  usedTokens: 40,
  heldTokens: 0,
  remaining: 60,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
};

function buildUsageApp(
  entitlements: ReturnType<typeof fakeEntitlements>,
  meter: AiTokenMeter,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.route("/", aiUsageRoutes({ entitlements, meter }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

describe("GET /api/ai/usage", () => {
  test("returns the remaining-budget snapshot", async () => {
    const app = buildUsageApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      snapshotMeter(SNAPSHOT),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as AiUsageSnapshot;

    expect(res.status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
  });

  test("refuses an inactive school with 403 AI_SCHOOL_INACTIVE", async () => {
    const app = buildUsageApp(
      fakeEntitlements(schoolEntitlement(false), aiEntitlement(true)),
      snapshotMeter(SNAPSHOT),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe(ERROR_CODES.AI_SCHOOL_INACTIVE);
  });

  test("refuses an inactive AI add-on with 402 AI_SUBSCRIPTION_INACTIVE", async () => {
    const app = buildUsageApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(false)),
      snapshotMeter(SNAPSHOT),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE);
  });

  test("refuses a period-less verdict with 503 AI_QUOTA_UNAVAILABLE", async () => {
    const app = buildUsageApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true, false)),
      snapshotMeter(SNAPSHOT),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_QUOTA_UNAVAILABLE);
  });
});
