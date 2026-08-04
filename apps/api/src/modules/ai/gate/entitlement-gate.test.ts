import { ERROR_CODES, ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { errorHandlerMiddleware } from "../../../middleware/errorHandler";
import { AUTH_CHANNELS } from "../../auth/channels";

import { aiEntitlementGate } from "./entitlement-gate";

import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type { AppEnv } from "../../../middleware/requestId";
import type { SchoolEntitlement, AiEntitlement } from "../../subscriptions/entitlements/resolve";
import type {
  AiCommitInput,
  AiReleaseInput,
  AiReservationResult,
  AiReserveInput,
  AiTokenMeter,
} from "../usage/meter";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const SCHOOL_ID = "00000000-0000-4000-8000-000000000001";
const STUDENT_ID = "00000000-0000-4000-8000-000000000002";
const USER_ID = "00000000-0000-4000-8000-000000000003";

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
    currentPeriodEnd: "2026-08-31T23:59:59.000Z",
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
    currentPeriodStart: hasPeriod ? "2026-08-01T00:00:00.000Z" : null,
    currentPeriodEnd: hasPeriod ? "2026-08-31T23:59:59.000Z" : null,
  };
}

function fakeEntitlements(school: SchoolEntitlement, ai: AiEntitlement) {
  return {
    school: async () => school,
    ai: async () => ai,
  };
}

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
      throw new Error("snapshot should not be called by the gate");
    },
  };

  return { meter, calls };
}

function buildGateApp(
  entitlements: ReturnType<typeof fakeEntitlements>,
  meter: AiTokenMeter,
  routes?: (app: Hono<AppEnv>) => void,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("auth", auth);
    c.set("locale", "en");
    await next();
  });
  app.use("/api/ai/*", aiEntitlementGate({ entitlements, meter }));
  app.onError(errorHandlerMiddleware(silentLogger));
  routes?.(app);
  return app;
}

const commitChatRoute = (app: Hono<AppEnv>) => {
  app.post("/api/ai/students/:studentId/chat", async (c) => {
    const quota = c.get("aiQuota");
    const result = await quota?.commit(12);
    return c.json({ ok: true, remaining: result?.remaining });
  });
};

const throwChatRoute = (app: Hono<AppEnv>) => {
  app.post("/api/ai/students/:studentId/chat", async () => {
    throw new Error("boom");
  });
};

const noSettleChatRoute = (app: Hono<AppEnv>) => {
  app.post("/api/ai/students/:studentId/chat", (c) => c.json({ ok: true }));
};

// ---------------------------------------------------------------------------
// Decision-flow contract tests
// ---------------------------------------------------------------------------

describe("aiEntitlementGate decision flow", () => {
  test("school inactive answers 403 AI_SCHOOL_INACTIVE and never touches the meter", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(false), aiEntitlement(true)),
      meter,
      commitChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe(ERROR_CODES.AI_SCHOOL_INACTIVE);
    expect(calls.reserve).toHaveLength(0);
  });

  test("AI add-on inactive answers 402 AI_SUBSCRIPTION_INACTIVE", async () => {
    const { meter } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(false)),
      meter,
      commitChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(402);
    expect(body.code).toBe(ERROR_CODES.AI_SUBSCRIPTION_INACTIVE);
  });

  test("active but period-less entitlement (stale cache) answers 503 AI_QUOTA_UNAVAILABLE", async () => {
    const { meter } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true, false)),
      meter,
      commitChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });
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
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      meter,
      commitChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(429);
    expect(body.code).toBe(ERROR_CODES.AI_QUOTA_EXCEEDED);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  test("missing student id answers 422 VALIDATION_FAILED", async () => {
    const { meter } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      meter,
      (a) => {
        a.post("/api/ai/chat", (c) => c.json({ ok: true }));
      },
    );

    const res = await app.request("/api/ai/chat", { method: "POST" });
    const body = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(body.code).toBe(ERROR_CODES.VALIDATION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// Reservation lifecycle contract tests
// ---------------------------------------------------------------------------

describe("aiEntitlementGate reservation lifecycle", () => {
  test("reserves quota, passes the handle, and releases nothing when the handler commits", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      meter,
      commitChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });

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

  test("a handler error releases the hold", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      meter,
      throwChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });

    expect(res.status).toBe(500);
    expect(calls.reserve).toHaveLength(1);
    expect(calls.commit).toHaveLength(0);
    expect(calls.release).toHaveLength(1);
    expect(calls.release[0].reservationId).toBe("res-1");
  });

  test("a handler that never settles releases the hold", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      meter,
      noSettleChatRoute,
    );

    const res = await app.request(`/api/ai/students/${STUDENT_ID}/chat`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(calls.release).toHaveLength(1);
  });

  test("the usage path passes through without reserving", async () => {
    const { meter, calls } = recordingMeter();
    const app = buildGateApp(
      fakeEntitlements(schoolEntitlement(true), aiEntitlement(true)),
      meter,
      (a) => {
        a.get("/api/ai/usage", (c) => c.json({ ok: true }));
      },
    );

    const res = await app.request("/api/ai/usage");

    expect(res.status).toBe(200);
    expect(calls.reserve).toHaveLength(0);
    expect(calls.release).toHaveLength(0);
  });
});
