import { OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  aiEntitlement,
  fakeEntitlements,
  fakeFeatureService,
  PERIOD_END,
  PERIOD_START,
  SCHOOL_ID,
  schoolEntitlement,
  silentLogger,
  STUDENT_ID,
  USER_ID,
  userEntitlement,
} from "../../features/__tests__/fakes";
import { provideFeatures } from "../../features/middleware";

import { aiUsageRoutes } from "./usage-routes";

import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { FakeEntitlements } from "../../features/__tests__/fakes";
import type { AiSnapshotInput, AiUsageSnapshot, AiTokenMeter } from "../usage/meter";

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

function snapshotMeter(snapshot: AiUsageSnapshot, seen: AiSnapshotInput[] = []): AiTokenMeter {
  return {
    reserve: async () => ({ ok: true, reservationId: "res-1", reservedTokens: 1, remaining: 0 }),
    commit: async () => ({ settled: true, remaining: 0 }),
    release: async () => ({ settled: true, remaining: 0 }),
    snapshot: async (input) => {
      seen.push(input);
      return snapshot;
    },
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

function buildUsageApp(entitlements: FakeEntitlements, meter: AiTokenMeter): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/*", provideFeatures(fakeFeatureService({ entitlements })));
  app.route("/", aiUsageRoutes({ meter }));
  app.onError(errorHandlerMiddleware(silentLogger));
  return app;
}

describe("GET /api/ai/usage", () => {
  test("returns the remaining-budget snapshot for the add-on's window", async () => {
    const seen: AiSnapshotInput[] = [];
    const app = buildUsageApp(
      fakeEntitlements({ school: schoolEntitlement(true), ai: aiEntitlement("active") }),
      snapshotMeter(SNAPSHOT, seen),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as AiUsageSnapshot;

    expect(res.status).toBe(200);
    expect(body).toEqual(SNAPSHOT);
    expect(seen).toEqual([
      {
        schoolId: SCHOOL_ID,
        studentId: STUDENT_ID,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        budget: 1_000_000,
      },
    ]);
  });

  test("checks the add-on of the caller's student record, not their user id", async () => {
    const entitlements = fakeEntitlements({ ai: aiEntitlement("active") });
    const app = buildUsageApp(entitlements, snapshotMeter(SNAPSHOT));

    const res = await app.request("/api/ai/usage");

    expect(res.status).toBe(200);
    expect(entitlements.calls.user).toEqual([USER_ID]);
    expect(entitlements.calls.ai).toEqual([STUDENT_ID]);
  });

  test("answers 402 AI_SUBSCRIPTION_INACTIVE to a caller with no student record", async () => {
    const entitlements = fakeEntitlements({
      ai: aiEntitlement("active"),
      user: userEntitlement({ studentId: null }),
    });
    const app = buildUsageApp(entitlements, snapshotMeter(SNAPSHOT));

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE);
    expect(entitlements.calls.ai).toEqual([]);
  });

  test("refuses an inactive school with 403 AI_SCHOOL_INACTIVE", async () => {
    const app = buildUsageApp(
      fakeEntitlements({ school: schoolEntitlement(false), ai: aiEntitlement("active") }),
      snapshotMeter(SNAPSHOT),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe(ERROR_CODES.AI_SCHOOL_INACTIVE);
  });

  test("refuses an inactive AI add-on with 402 AI_SUBSCRIPTION_INACTIVE", async () => {
    const app = buildUsageApp(
      fakeEntitlements({ ai: aiEntitlement("canceled") }),
      snapshotMeter(SNAPSHOT),
    );

    const res = await app.request("/api/ai/usage");
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE);
  });
});
