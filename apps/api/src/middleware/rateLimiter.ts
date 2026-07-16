import { HTTPException } from "hono/http-exception";

import { RATE_LIMIT_BUDGETS, buildRateLimitKey, resolveRouteClass } from "../config/rateLimits";

import type { RouteClass } from "../config/rateLimits";
import type { RedisClient } from "../redis";
import type { AppEnv } from "./requestId";
import type { MiddlewareHandler } from "hono";

/**
 * Redis-backed token-bucket rate limiter middleware.
 *
 * Uses an atomic Lua script to check and consume tokens in a single round-trip,
 * eliminating race conditions under concurrency. Supports three route classes
 * (`auth`, `ai`, `default`) with distinct budgets keyed per tenant/user for
 * authenticated sessions and per IP address for unauthenticated routes.
 *
 * When Redis is unavailable, the middleware passes through (fail-open) so
 * transient infrastructure issues never block legitimate traffic.
 *
 * @see ../config/rateLimits.ts for budget definitions and route-class registry.
 *
 * @example
 * ```typescript
 * // Apply to specific routes
 * app.use("/api/auth/*", rateLimiterMiddleware({ redis, routeClass: "auth" }));
 * app.use("/api/ai/*", rateLimiterMiddleware({ redis, routeClass: "ai" }));
 *
 * // Or apply globally with automatic route-class resolution
 * app.use("*", rateLimiterMiddleware({ redis }));
 * ```
 */

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  /** Redis client. Pass `null` to disable rate limiting (fail-open). */
  redis: RedisClient | null;
  /**
   * Override the route class for all requests handled by this middleware instance.
   * When omitted, the class is resolved from `ROUTE_CLASS_MAP` using the request path.
   */
  routeClass?: RouteClass;
  /** Override the budget for testing. When omitted, uses `RATE_LIMIT_BUDGETS[routeClass]`. */
  budget?: { maxTokens: number; refillRate: number; windowSeconds: number };
  /** Override the clock for deterministic testing. Defaults to `Date.now()`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// IP extraction (last entry in X-Forwarded-For = ALB-vouched client IP)
// ---------------------------------------------------------------------------

/**
 * Extract the client IP address from the request. Trusts the **last** entry in
 * `X-Forwarded-For` because ALB appends its own observation at the end in the
 * default "Append" mode — all preceding entries are client-controlled and
 * potentially spoofed.
 *
 * Falls back to `X-Real-IP` (if an upstream proxy sets it), then to `"unknown"`.
 */
export function extractClientIp(c: { req: { header(name: string): string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const ips = xff
      .split(",")
      .map((ip) => ip.trim())
      .filter(Boolean);
    if (ips.length > 0) return ips[ips.length - 1];
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

// ---------------------------------------------------------------------------
// Key construction (delegates to config, adds identity resolution)
// ---------------------------------------------------------------------------

/**
 * Build the identity string for rate-limit key construction.
 *
 * - `auth` routes: always IP (pre-authentication, no tenant/user context).
 * - `ai`/`default` routes: `schoolId:userId` when auth context is present,
 *   falls back to IP for unauthenticated requests on authenticated routes.
 */
function buildIdentity(
  routeClass: RouteClass,
  auth: { schoolId: string; userId: string } | undefined,
  clientIp: string,
): string {
  if (routeClass === "auth") return clientIp;
  if (auth) return `${auth.schoolId}:${auth.userId}`;
  return clientIp;
}

// ---------------------------------------------------------------------------
// Lua script — atomic token-bucket consume-or-reject
// ---------------------------------------------------------------------------

/**
 * Token-bucket Lua script executed atomically in Redis.
 *
 * Uses two keys per bucket (tokens + timestamp) with matching TTLs so they
 * expire together. On the first request for a key, initializes the bucket at
 * `maxTokens - 1` (consuming one token for the current request). On subsequent
 * requests, refills tokens based on elapsed time since the last consumption.
 *
 * Returns: `[remaining, allowed (1|0), retryAfterSeconds]`
 */
const TOKEN_BUCKET_SCRIPT = `
local tokenKey = KEYS[1]
local tsKey = KEYS[2]
local max = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local tokens = tonumber(redis.call('GET', tokenKey))
local lastTs = tonumber(redis.call('GET', tsKey))

if tokens == nil then
  redis.call('SET', tokenKey, max - 1, 'EX', ttl)
  redis.call('SET', tsKey, now, 'EX', ttl)
  return {max - 1, 1, 0}
end

local elapsed = math.max(0, now - lastTs)
tokens = math.min(max, tokens + elapsed * rate)

if tokens < 1 then
  return {math.floor(tokens), 0, math.ceil((1 - tokens) / rate)}
end

tokens = tokens - 1
redis.call('SET', tokenKey, math.floor(tokens), 'EX', ttl)
redis.call('SET', tsKey, now, 'EX', ttl)
return {math.floor(tokens), 1, 0}
`;

let scriptSha: string | null = null;

/**
 * Ensure the Lua script is loaded in Redis and return its SHA. Caches the SHA
 * across calls so `SCRIPT LOAD` is only executed once per process lifetime.
 * Falls back to `EVAL` if the SHA is evicted or the connection is stale.
 */
async function ensureScript(redis: RedisClient): Promise<string> {
  if (scriptSha) return scriptSha;
  const result = (await redis.script("LOAD", TOKEN_BUCKET_SCRIPT)) as string;
  scriptSha = result;
  return scriptSha;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Redis-backed token-bucket rate limiter middleware.
 *
 * @param options  Configuration: Redis client, optional route-class override, and test seams.
 * @returns A Hono middleware handler.
 */
export function rateLimiterMiddleware({
  redis,
  routeClass: routeClassOverride,
  budget: budgetOverride,
  now: nowFn = () => Date.now(),
}: RateLimiterOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!redis) {
      await next();
      return;
    }

    const routeClass = routeClassOverride ?? resolveRouteClass(c.req.path);
    const budget = budgetOverride ?? RATE_LIMIT_BUDGETS[routeClass];
    const auth = c.get("auth");
    const clientIp = extractClientIp(c);
    const identity = buildIdentity(routeClass, auth, clientIp);
    const key = buildRateLimitKey(routeClass, identity);
    const now = Math.floor(nowFn() / 1000);
    const ttl = budget.windowSeconds + Math.ceil(budget.maxTokens / budget.refillRate);

    let remaining: number;
    let allowed: number;
    let retryAfter: number;

    try {
      const sha = await ensureScript(redis);
      const result = (await redis.evalsha(
        sha,
        2,
        `${key}:tokens`,
        `${key}:ts`,
        budget.maxTokens,
        budget.refillRate,
        now,
        ttl,
      )) as [number, number, number];

      remaining = result[0];
      allowed = result[1];
      retryAfter = result[2];
    } catch (err: unknown) {
      // NOSCRIPT = script evicted from cache; re-load and retry once.
      if (
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string" &&
        (err as { message: string }).message.includes("NOSCRIPT")
      ) {
        scriptSha = null;
        const sha = await ensureScript(redis);
        const result = (await redis.evalsha(
          sha,
          2,
          `${key}:tokens`,
          `${key}:ts`,
          budget.maxTokens,
          budget.refillRate,
          now,
          ttl,
        )) as [number, number, number];

        remaining = result[0];
        allowed = result[1];
        retryAfter = result[2];
      } else {
        // Redis failure — fail open. Log and proceed.
        const log = c.get("log");
        if (log) {
          log.warn({ err }, "rate limiter redis error, failing open");
        }
        await next();
        return;
      }
    }

    c.header("X-RateLimit-Limit", String(budget.maxTokens));
    c.header("X-RateLimit-Remaining", String(Math.max(0, remaining)));
    c.header("X-RateLimit-Reset", String(now + budget.windowSeconds));

    if (!allowed) {
      c.header("Retry-After", String(retryAfter));
      throw new HTTPException(429);
    }

    await next();
  };
}
