import { LIVE_STATUSES } from "@studafy/billing";
import { ERROR_CODES, ROLES, SUBSCRIPTION_STATUSES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  aiEntitlement,
  fakeEntitlements,
  fakeFeatureService,
  memoryUsageMeter,
  PERIOD_END,
  PERIOD_START,
  SCHOOL_ID,
  schoolEntitlement,
  silentLogger,
  STUDENT_ID,
  USER_ID,
  userEntitlement,
} from "../../features/__tests__/fakes";
import { provideFeatures, requireFeature } from "../../features/middleware";

import { AI_FEATURE_ROUTE, aiTokenBudget, provideAiTokenBudget } from "./token-budget";

import type { AiQuotaHandle, AiTokenBudgetConfig } from "./token-budget";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { FeatureService } from "../../features/service";
import type { AiEntitlement, SchoolEntitlement } from "../../subscriptions/entitlements/resolve";
import type {
  AiCommitInput,
  AiReleaseInput,
  AiReservationResult,
  AiReserveInput,
  AiTokenMeter,
} from "../usage/meter";
import type { SubscriptionStatus } from "@studafy/constants";

/**
 * The AI routes' access chain -- requireFeature(..., AI_FEATURE_ROUTE) then aiTokenBudget() -- which
 * replaced the ST-155 entitlement gate. The decision-flow and reservation-lifecycle cases are the old
 * gate's, unchanged in what they assert: an AI add-on subscriber keeps exactly the access, codes and
 * token quota they had.
 */

// A caller who is not the student: the AI routes key on the student in the path, not on the caller.
const CALLER_ID = "00000000-0000-4000-8000-0000000000c1";

const auth: AuthContext = {
  userId: CALLER_ID,
  schoolId: SCHOOL_ID,
  roles: [ROLES.STUDENT],
  channel: AUTH_CHANNELS.API,
  jti: "jti-1",
  entitlementsVer: 1,
  subscriptionStatus: "active",
};

function recordingMeter(reserveResult?: AiReservationResult) {
  const calls: {
    reserve: AiReserveInput[];
    commit: AiCommitInput[];
    release: AiReleaseInput[];
  } = { reserve: [], commit: [], release: [] };

  const meter: AiTokenMeter = {
    reserve: async (input) => {
      calls.reserve.push(input);
      return (
        reserveResult ?? {
          ok: true,
          reservationId: "res-1",
          reservedTokens: input.amount,
          remaining: 90,
        }
      );
    },
    commit: async (input) => {
      calls.commit.push(input);
      return { settled: true, remaining: 90 };
    },
    release: async (input) => {
      calls.release.push(input);
      return { settled: true, remaining: 100 };
    },
    snapshot: async () => {
      throw new Error("snapshot should not be called by the budget");
    },
  };

  return { meter, calls };
}

function serviceFor(school: SchoolEntitlement, ai: AiEntitlement): FeatureService {
  return fakeFeatureService({ entitlements: fakeEntitlements({ school, ai }) });
}

function buildApp(
  features: FeatureService,
  budget: AiTokenBudgetConfig,
  routes: (app: Hono<AppEnv>) => void,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/*", provideFeatures(features));
  app.use("/api/ai/*", provideAiTokenBudget(budget));
  app.onError(errorHandlerMiddleware(silentLogger));
  routes(app);
  return app;
}

const CHAT = "/api/ai/students/:studentId/chat";
const tutor = () => requireFeature("ai_tutor", { ...AI_FEATURE_ROUTE, meter: 1 });

const commitChatRoute = (app: Hono<AppEnv>) => {
  app.post(CHAT, tutor(), aiTokenBudget(), async (c) => {
    const result = await c.get("aiQuota")?.commit(12);
    return c.json({ ok: true, remaining: result?.remaining });
  });
};

const throwChatRoute = (app: Hono<AppEnv>) => {
  app.post(CHAT, tutor(), aiTokenBudget(), async () => {
    throw new Error("boom");
  });
};

const noSettleChatRoute = (app: Hono<AppEnv>) => {
  app.post(CHAT, tutor(), aiTokenBudget(), (c) => c.json({ ok: true }));
};

const chat = (app: Hono<AppEnv>) =>
  app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });

describe("AI access decision flow", () => {
  test("school inactive answers 403 AI_SCHOOL_INACTIVE and never touches the meter", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(false), aiEntitlement("active")),
      { meter },
      commitChatRoute,
    );

    const res = await chat(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe(ERROR_CODES.AI_SCHOOL_INACTIVE);
    expect(calls.reserve).toHaveLength(0);
  });

  test("AI add-on inactive answers 402 AI_SUBSCRIPTION_INACTIVE", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement(null)),
      { meter },
      commitChatRoute,
    );

    const res = await chat(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE);
    expect(calls.reserve).toHaveLength(0);
  });

  test("a verdict without a billing window answers 503 AI_QUOTA_UNAVAILABLE", async () => {
    const { meter } = recordingMeter();
    const real = serviceFor(schoolEntitlement(true), aiEntitlement("active"));
    // No grant source produces this today; the budget must still fail closed if one ever does.
    const windowless: FeatureService = {
      ...real,
      async resolve(...args) {
        const resolved = await real.resolve(...args);
        resolved.features.ai_tutor = {
          ...resolved.features.ai_tutor,
          periodStart: null,
          periodEnd: null,
        };
        return resolved;
      },
    };
    const app = buildApp(windowless, { meter }, commitChatRoute);

    const res = await chat(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(503);
    expect(body.code).toBe(ERROR_CODES.AI_QUOTA_UNAVAILABLE);
  });

  test("quota refused answers 429 AI_QUOTA_EXCEEDED with Retry-After", async () => {
    const { meter } = recordingMeter({
      ok: false,
      reason: "exhausted",
      currentUsage: 100,
      budget: 100,
      retryAfterSeconds: 60,
    });
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      { meter },
      commitChatRoute,
    );

    const res = await chat(app);
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(429);
    expect(body.code).toBe(ERROR_CODES.AI_QUOTA_EXCEEDED);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  test("missing student id answers 422 VALIDATION_FAILED", async () => {
    const { meter } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      { meter },
      (a) => {
        a.post("/api/ai/chat", tutor(), aiTokenBudget(), (c) => c.json({ ok: true }));
      },
    );

    const res = await app.request("/api/ai/chat", { method: "POST" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});

describe("AI add-on subscribers keep exactly today's access", () => {
  // The old gate: school live (403 otherwise), then add-on live (402 otherwise). Every combination of
  // school state and add-on status, against the new chain.
  const aiStatuses: (SubscriptionStatus | null)[] = [null, ...Object.values(SUBSCRIPTION_STATUSES)];

  for (const schoolActive of [true, false]) {
    for (const status of aiStatuses) {
      const expected = !schoolActive ? 403 : status && LIVE_STATUSES.has(status) ? 200 : 402;

      test(`school ${schoolActive ? "active" : "inactive"}, add-on ${status ?? "absent"} -> ${expected}`, async () => {
        const { meter, calls } = recordingMeter();
        const app = buildApp(
          serviceFor(schoolEntitlement(schoolActive), aiEntitlement(status)),
          { meter },
          commitChatRoute,
        );

        const res = await chat(app);
        expect(res.status).toBe(expected);

        if (expected === 200) {
          // Same Redis key (school, student, the add-on's own window), same budget, same hold.
          expect(calls.reserve).toEqual([
            {
              schoolId: SCHOOL_ID,
              studentId: STUDENT_ID,
              periodStart: PERIOD_START,
              periodEnd: PERIOD_END,
              budget: 1_000_000,
              amount: 1_000,
            },
          ]);
        } else {
          const body = (await res.json()) as { code: string };
          expect(body.code).toBe(
            expected === 403
              ? ERROR_CODES.AI_SCHOOL_INACTIVE
              : ERROR_CODES.AI_SUBSCRIPTION_INACTIVE,
          );
          expect(calls.reserve).toHaveLength(0);
        }
      });
    }
  }

  test("units are counted for an add-on subscriber but never limit them", async () => {
    const { meter } = recordingMeter();
    const usage = memoryUsageMeter();
    const features = fakeFeatureService({
      entitlements: fakeEntitlements({ ai: aiEntitlement("active") }),
      usage,
    });
    const app = buildApp(features, { meter }, commitChatRoute);

    for (let i = 0; i < 400; i += 1) {
      expect((await chat(app)).status).toBe(200);
    }
    // 400 is past ai_tutor's code default (300): the add-on tier's limit is unlimited.
    expect(usage.used.get(`${USER_ID}:ai_tutor`)).toBe(400);
  });

  test("the feature and the budget are the student's in the path, not the caller's", async () => {
    const { meter, calls } = recordingMeter();
    const entitlements = fakeEntitlements({ ai: aiEntitlement("active") });
    const app = buildApp(fakeFeatureService({ entitlements }), { meter }, commitChatRoute);

    await chat(app);

    expect(entitlements.calls.ai).toEqual([STUDENT_ID]);
    expect(entitlements.calls.user).toEqual([USER_ID]);
    expect(calls.reserve[0]?.studentId).toBe(STUDENT_ID);
  });

  test("a student with a personal subscription to a tier reaches the AI routes too", async () => {
    const { meter, calls } = recordingMeter();
    const features = fakeFeatureService({
      entitlements: fakeEntitlements({
        ai: aiEntitlement(null),
        user: userEntitlement({
          subscriptions: [
            {
              id: "us-1",
              planCode: "ai_addon",
              provider: "app_store",
              status: "active",
              live: true,
              autoRenew: true,
              currentPeriodStart: "2026-08-10T00:00:00.000Z",
              currentPeriodEnd: "2026-09-10T00:00:00.000Z",
            },
          ],
        }),
      }),
    });
    const app = buildApp(features, { meter }, commitChatRoute);

    const res = await chat(app);

    expect(res.status).toBe(200);
    expect(calls.reserve[0]).toMatchObject({
      periodStart: "2026-08-10T00:00:00.000Z",
      periodEnd: "2026-09-10T00:00:00.000Z",
    });
  });
});

describe("AI token reservation lifecycle", () => {
  test("reserves quota, passes the handle, and releases nothing when the handler commits", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      { meter },
      commitChatRoute,
    );

    const res = await chat(app);

    expect(res.status).toBe(200);
    expect(calls.reserve).toHaveLength(1);
    expect(calls.reserve[0]).toMatchObject({
      schoolId: SCHOOL_ID,
      studentId: STUDENT_ID,
      amount: 1000,
      budget: 1000000,
    });
    expect(calls.commit).toHaveLength(1);
    expect(calls.commit[0]).toMatchObject({ reservationId: "res-1", consumedTokens: 12 });
    expect(calls.release).toHaveLength(0);
  });

  test("a handler error releases the hold and refunds the unit", async () => {
    const { meter, calls } = recordingMeter();
    const usage = memoryUsageMeter();
    const features = fakeFeatureService({
      entitlements: fakeEntitlements({ ai: aiEntitlement("active") }),
      usage,
    });
    const app = buildApp(features, { meter }, throwChatRoute);

    const res = await chat(app);

    expect(res.status).toBe(500);
    expect(calls.reserve).toHaveLength(1);
    expect(calls.commit).toHaveLength(0);
    expect(calls.release).toHaveLength(1);
    expect(calls.release[0]?.reservationId).toBe("res-1");
    expect(usage.calls).toEqual({ consume: 1, refund: 1 });
    expect(usage.used.get(`${USER_ID}:ai_tutor`)).toBe(0);
  });

  test("a handler that never settles releases the hold", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      { meter },
      noSettleChatRoute,
    );

    const res = await chat(app);

    expect(res.status).toBe(200);
    expect(calls.release).toHaveLength(1);
  });

  test("detach() stops the auto-release, and the handle keeps working after the handler returns", async () => {
    const { meter, calls } = recordingMeter();
    let handedOff: AiQuotaHandle | undefined;
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      { meter },
      (a) => {
        a.post(CHAT, tutor(), aiTokenBudget(), (c) => {
          const quota = c.get("aiQuota")!;
          // Mirrors streamSSE: the route hands the reservation off and returns before any
          // commit/release, exactly the shape that would otherwise race the middleware's finally.
          quota.detach();
          handedOff = quota;
          return c.json({ ok: true });
        });
      },
    );

    const res = await chat(app);

    expect(res.status).toBe(200);
    expect(calls.commit).toHaveLength(0);
    expect(calls.release).toHaveLength(0);

    await handedOff?.commit(12);
    expect(calls.commit).toHaveLength(1);
    expect(calls.commit[0]).toMatchObject({ reservationId: "res-1", consumedTokens: 12 });
    expect(calls.release).toHaveLength(0);
  });

  test("resolveReserveTokens sets the hold size for the request, defaulting elsewhere", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      {
        meter,
        defaultReserveTokens: 1000,
        resolveReserveTokens: (c) => (c.req.path.endsWith("/generate") ? 24_000 : undefined),
      },
      (a) => {
        a.post("/api/ai/students/:studentId/generate", tutor(), aiTokenBudget(), (c) =>
          c.json({ ok: true }),
        );
        a.post(CHAT, tutor(), aiTokenBudget(), (c) => c.json({ ok: true }));
      },
    );

    await app.request(`/api/ai/students/${STUDENT_ID}/generate`, { method: "POST" });
    await chat(app);

    expect(calls.reserve).toHaveLength(2);
    expect(calls.reserve[0]).toMatchObject({ amount: 24_000 });
    expect(calls.reserve[1]).toMatchObject({ amount: 1000 });
  });

  test("a request that already holds a reservation is not reserved twice", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildApp(
      serviceFor(schoolEntitlement(true), aiEntitlement("active")),
      { meter },
      (a) => {
        a.post(CHAT, tutor(), aiTokenBudget(), aiTokenBudget(), (c) => c.json({ ok: true }));
      },
    );

    expect((await chat(app)).status).toBe(200);
    expect(calls.reserve).toHaveLength(1);
  });
});
