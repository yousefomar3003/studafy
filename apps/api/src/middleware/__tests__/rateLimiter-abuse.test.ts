/**
 * QA-028: rate limits that neither throttle a whole campus nor hand an attacker a DoS lever.
 *
 * - The "auth" class keyed authenticated routes by IP, so a school behind one NAT address could
 *   register ~10 push devices a minute between all its users. A signed-in caller is now keyed by
 *   school and user.
 * - Member sign-in shared one platform-wide bucket: ~20 addresses could drain it and lock every
 *   school out. It is now one bucket per school (the school number is part of the member ID), so
 *   draining one school leaves the others alone.
 * - Microsoft start/callback and every mobile OAuth step fell into the generous default class.
 *   All of `/api/auth/oauth/*` and `/api/auth/login/*` are now in a sign-in class.
 * - On a Redis error the limiter failed open everywhere. The sign-in classes and the member-login
 *   buckets now fall back to an in-process bucket instead.
 *
 *   TEST_REDIS_URL=redis://127.0.0.1:6390 bun test src/middleware/__tests__/rateLimiter-abuse.test.ts
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  IP_SCOPED_ROUTE_CLASSES,
  RATE_LIMIT_BUDGETS,
  memberLoginSchoolNumber,
  resolveRouteClass,
} from "../../config/rateLimits";
import { createRedisClient } from "../../redis";
import { errorHandlerMiddleware, requestIdMiddleware } from "../index";
import { rateLimiterMiddleware, resetFallbackBuckets, takeMemberLoginTokens } from "../rateLimiter";

import type { RedisClient } from "../../redis";
import type { AppEnv } from "../requestId";

const silentLogger = {
  level: "info" as const,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
let redis: RedisClient | null = null;

async function clearRateLimitKeys(client: RedisClient): Promise<void> {
  const keys = await client.keys("rl:*");
  if (keys.length > 0) await client.del(...keys);
}

beforeEach(async () => {
  resetFallbackBuckets();
  if (!redisUrl) return;
  if (!redis) {
    redis = createRedisClient({ url: redisUrl, logger: silentLogger });
    await redis.connect();
  }
  await clearRateLimitKeys(redis);
});

afterAll(async () => {
  await redis?.quit();
});

/** A Redis client whose every call fails, as when the server is unreachable. */
const brokenRedis = {
  evalsha: () => Promise.reject(new Error("ECONNREFUSED")),
  script: () => Promise.reject(new Error("ECONNREFUSED")),
  status: "wait",
  quit: () => Promise.resolve(),
  disconnect: () => undefined,
} as unknown as RedisClient;

function appWith(
  client: RedisClient,
  asUser?: (n: number) => { schoolId: string; userId: string },
) {
  const app = new Hono<AppEnv>();
  app.use("*", requestIdMiddleware({ logger: silentLogger }));
  if (asUser) {
    app.use("*", async (c, next) => {
      const n = Number(c.req.header("X-Test-User"));
      c.set("auth", asUser(n) as never);
      await next();
    });
  }
  app.use("*", rateLimiterMiddleware({ redis: client }));
  app.onError(errorHandlerMiddleware(silentLogger));
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

const campus = { "Fly-Client-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.7" };

describe("sign-in routes are classed (QA-028)", () => {
  test.each([
    "/api/auth/oauth/microsoft/start",
    "/api/auth/oauth/microsoft/callback",
    "/api/auth/oauth/google/mobile-start",
    "/api/auth/oauth/google/mobile-exchange",
    "/api/auth/oauth/microsoft/mobile-authorize",
    "/api/auth/oauth/mock/mobile-exchange",
    "/api/auth/login/member",
  ])("%s is in an IP-scoped sign-in class", (path) => {
    const routeClass = resolveRouteClass(path);
    expect(routeClass).not.toBe("default");
    expect(IP_SCOPED_ROUTE_CLASSES.has(routeClass)).toBe(true);
  });

  test("the member ID carries the school number", () => {
    expect(memberLoginSchoolNumber("stu-1200042")).toBe("12");
    expect(memberLoginSchoolNumber(" PAR-300007 ")).toBe("3");
    expect(memberLoginSchoolNumber("not-a-code")).toBeNull();
  });
});

describeRedis("per-user keys for signed-in callers (QA-028)", () => {
  test("50 users behind one address can all register a device", async () => {
    const app = appWith(redis!, (n) => ({ schoolId: "school-1", userId: `user-${n}` }));
    const statuses: number[] = [];
    for (let n = 0; n < 50; n += 1) {
      const res = await app.request("/api/auth/devices", {
        method: "POST",
        headers: { ...campus, "X-Test-User": String(n) },
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
  });

  test("one signed-in user is still limited", async () => {
    const app = appWith(redis!, () => ({ schoolId: "school-1", userId: "user-1" }));
    let limited = false;
    for (let n = 0; n <= RATE_LIMIT_BUDGETS.auth.maxTokens; n += 1) {
      const res = await app.request("/api/auth/devices", {
        method: "POST",
        headers: { ...campus, "X-Test-User": "1" },
      });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describeRedis("member sign-in is bucketed per school (QA-028)", () => {
  test("draining one school's bucket leaves another school's sign-in working", async () => {
    const now = Math.floor(Date.now() / 1000);
    let blocked: string | null = null;
    // Distinct member IDs of school 12 until its bucket runs dry.
    for (let n = 0; n < 2_000 && blocked === null; n += 1) {
      const result = await takeMemberLoginTokens(
        redis!,
        `STU-12${String(n).padStart(5, "0")}`,
        now,
      );
      if (!result.allowed) blocked = result.scope;
    }
    expect(blocked).toBe("school");
    expect((await takeMemberLoginTokens(redis!, "STU-1299999", now)).allowed).toBe(false);
    expect((await takeMemberLoginTokens(redis!, "STU-1300001", now)).allowed).toBe(true);
  });
});

describe("fail closed for sign-in when Redis is down (QA-028)", () => {
  test("the sign-in class falls back to an in-process bucket", async () => {
    const app = appWith(brokenRedis);
    const statuses: number[] = [];
    for (let n = 0; n <= RATE_LIMIT_BUDGETS["auth-login"].maxTokens; n += 1) {
      const res = await app.request("/api/auth/login/member", { method: "POST", headers: campus });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, -1).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test("member sign-in buckets fall back too", async () => {
    const now = Math.floor(Date.now() / 1000);
    const results = [];
    for (let n = 0; n < 15; n += 1) {
      results.push(await takeMemberLoginTokens(brokenRedis, "STU-1200001", now));
    }
    expect(results.some((result) => !result.allowed)).toBe(true);
  });

  test("ordinary routes still fail open", async () => {
    const app = appWith(brokenRedis);
    for (let n = 0; n <= RATE_LIMIT_BUDGETS.default.maxTokens + 5; n += 1) {
      expect((await app.request("/api/students", { headers: campus })).status).toBe(200);
    }
  });
});
