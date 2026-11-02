import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { errorHandlerMiddleware } from "../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../auth/channels";

import {
  fakeEntitlements,
  fakeFeatureService,
  memoryUsageMeter,
  migratedCatalog,
  SCHOOL_ID,
  schoolEntitlement,
  silentLogger,
  USER_ID,
  userEntitlement,
} from "./__tests__/fakes";
import { getFeatureGate, provideFeatures, requireFeature } from "./middleware";

import type { FeatureCatalog } from "./catalog";
import type { FeatureService } from "./service";
import type { AuthContext } from "../../middleware/authContext";
import type { AppEnv } from "../../middleware/requestId";
import type { UserSubscriptionGrant } from "../subscriptions/entitlements/resolve";
import type { Context } from "hono";

const auth: AuthContext = {
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.INSTRUCTOR],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

/** A teacher tier selling auto_grading at 3 submissions a month. */
function teacherCatalog(): FeatureCatalog {
  const catalog = migratedCatalog();
  catalog.tiers.teacher_basic = {
    id: "plan-teacher-basic",
    code: "teacher_basic",
    audience: "teacher",
    rank: 1,
    includesAllFeatures: false,
    isActive: true,
    limits: { auto_grading: 3 },
  };
  return catalog;
}

function subscription(overrides: Partial<UserSubscriptionGrant> = {}): UserSubscriptionGrant {
  return {
    id: "us-1",
    planCode: "teacher_basic",
    provider: "stripe",
    status: "active",
    live: true,
    autoRenew: true,
    currentPeriodStart: "2026-08-01T00:00:00.000Z",
    currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function teacherService(
  subscriptions: UserSubscriptionGrant[],
  options: {
    usage?: ReturnType<typeof memoryUsageMeter>;
    schoolActive?: boolean;
    catalog?: FeatureCatalog;
  } = {},
): FeatureService {
  return fakeFeatureService({
    entitlements: fakeEntitlements({
      school: schoolEntitlement(options.schoolActive ?? true),
      user: userEntitlement({ studentId: null, subscriptions }),
    }),
    catalog: options.catalog ?? teacherCatalog(),
    usage: options.usage,
  });
}

function buildApp(
  service: FeatureService | null,
  handler: (c: Context<AppEnv>) => Response | Promise<Response> = (c) =>
    c.json({ ok: true, used: getFeatureGate(c).access.used }),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  if (service) app.use("/api/*", provideFeatures(service));
  app.onError(errorHandlerMiddleware(silentLogger));
  app.post("/api/grading/run", requireFeature("auto_grading", { meter: 1 }), handler);
  app.get("/api/grading/report", requireFeature("auto_grading"), (c) => c.json({ ok: true }));
  return app;
}

const run = (app: Hono<AppEnv>) => app.request("/api/grading/run", { method: "POST" });

describe("requireFeature", () => {
  test("admits a person whose grant includes the feature, and counts the unit", async () => {
    const usage = memoryUsageMeter();
    const app = buildApp(teacherService([subscription()], { usage }));

    const res = await run(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, used: 1 });
    expect(usage.used.get(`${USER_ID}:auto_grading`)).toBe(1);
  });

  test("refuses with 402 FEATURE_NOT_INCLUDED when no grant includes it", async () => {
    const app = buildApp(teacherService([]));

    const res = await run(app);
    const body = (await res.json()) as { code: string; detail: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.FEATURE_NOT_INCLUDED);
  });

  test("refuses with 402 FEATURE_EXPIRED when the grant that included it has ended", async () => {
    const app = buildApp(teacherService([subscription({ status: "expired", live: false })]));

    const res = await run(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.FEATURE_EXPIRED);
  });

  test("refuses with 429 FEATURE_LIMIT_REACHED past the monthly limit, with Retry-After", async () => {
    const usage = memoryUsageMeter();
    const app = buildApp(teacherService([subscription()], { usage }));

    for (let i = 0; i < 3; i += 1) expect((await run(app)).status).toBe(200);
    const res = await run(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(429);
    expect(body.code).toBe(ERROR_CODES.FEATURE_LIMIT_REACHED);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(usage.used.get(`${USER_ID}:auto_grading`)).toBe(3);
  });

  test("an unmetered route is checked but not counted, even at the limit", async () => {
    const usage = memoryUsageMeter();
    usage.used.set(`${USER_ID}:auto_grading`, 3);
    const app = buildApp(teacherService([subscription()], { usage }));

    const res = await app.request("/api/grading/report");

    expect(res.status).toBe(200);
    expect(usage.calls.consume).toBe(0);
  });

  test("refuses an inactive school with 403 AI_SCHOOL_INACTIVE, as before", async () => {
    const app = buildApp(teacherService([subscription()], { schoolActive: false }));

    const res = await run(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe(ERROR_CODES.AI_SCHOOL_INACTIVE);
  });

  test("a feature the super admin paused is refused as not included", async () => {
    const catalog = teacherCatalog();
    catalog.settings.auto_grading = { displayName: "Auto grading", status: "paused" };
    const app = buildApp(teacherService([subscription()], { catalog }));

    const res = await run(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.FEATURE_NOT_INCLUDED);
  });

  test("a handler that answers 4xx gives the unit back", async () => {
    const usage = memoryUsageMeter();
    const app = buildApp(teacherService([subscription()], { usage }), (c) =>
      c.json({ error: "bad input" }, 422),
    );

    expect((await run(app)).status).toBe(422);
    expect(usage.calls).toEqual({ consume: 1, refund: 1 });
    expect(usage.used.get(`${USER_ID}:auto_grading`)).toBe(0);
  });

  test("a route behind requireFeature without provideFeatures is a server error", async () => {
    const app = buildApp(null);

    expect((await run(app)).status).toBe(500);
  });

  test("rejects a meter that is not a non-negative integer at wiring time", () => {
    expect(() => requireFeature("auto_grading", { meter: -1 })).toThrow();
    expect(() => requireFeature("auto_grading", { meter: 0.5 })).toThrow();
  });
});
