/**
 * Route-class budget configuration for Redis-backed token-bucket rate limiting.
 *
 * Every non-health route must be registered in {@link ROUTE_CLASS_MAP}. The CI test
 * walks this map and fails if any registered route is missing a class entry.
 * Unregistered routes fall through to {@link DEFAULT_ROUTE_CLASS} (fail-safe).
 *
 * ## Token-bucket parameters
 *
 * Each budget defines:
 * - `maxTokens`: Burst capacity — the maximum number of requests allowed in a single burst.
 * - `refillRate`: Tokens added per second — determines sustained throughput.
 * - `windowSeconds`: TTL window for the Redis key (must comply with `noeviction` policy).
 *
 * ## Key construction
 *
 * Keys follow the convention `rl:{scope}:{identity}:{window}` where:
 * - `scope` is `auth` (IP-scoped) or `sch` (tenant-scoped for ai/default).
 * - `identity` is the client IP (auth) or `schoolId:userId` (ai/default).
 * - `window` is `floor(now / windowSeconds)` — rotates automatically.
 */

// ---------------------------------------------------------------------------
// Budget definitions
// ---------------------------------------------------------------------------

export interface RateLimitBudget {
  /** Maximum tokens (burst capacity). */
  maxTokens: number;
  /** Tokens added per second (sustained throughput). */
  refillRate: number;
  /** Window size in seconds — also used as the Redis key TTL base. */
  windowSeconds: number;
}

export type RouteClass = "auth" | "auth-strict" | "ai" | "default";

/**
 * Per-class token-bucket budgets.
 *
 * - `auth-strict`: Unauthenticated endpoints with brute-force or enumeration risk.
 *   5 tokens burst, ~5 req/min sustained. Applies to `/api/auth/refresh` (token rotation)
 *   and `/api/auth/logout` (session termination).
 * - `auth`: Authenticated admin-mutating endpoints (invitations). 10 tokens burst,
 *   ~10 req/min sustained.
 * - `ai`: Metered tenant+user scoped (existing).
 * - `default`: Generous catch-all for public/read endpoints (existing).
 */
export const RATE_LIMIT_BUDGETS: Record<RouteClass, RateLimitBudget> = {
  "auth-strict": { maxTokens: 5, refillRate: 0.08, windowSeconds: 60 },
  auth: { maxTokens: 10, refillRate: 0.17, windowSeconds: 60 },
  ai: { maxTokens: 30, refillRate: 0.5, windowSeconds: 60 },
  default: { maxTokens: 100, refillRate: 1.67, windowSeconds: 60 },
};

// ---------------------------------------------------------------------------
// Route-class registry
// ---------------------------------------------------------------------------

/**
 * Explicit per-route-class registry. Every non-health route MUST be registered here.
 *
 * Patterns:
 * - Exact: `"/api/auth/login"` → matches only that path.
 * - Prefix: `"/api/ai/*"` → matches `/api/ai/completions`, `/api/ai/health`, etc.
 *
 * The CI test validates that every registered route has a class entry.
 * Unregistered routes fall through to {@link DEFAULT_ROUTE_CLASS}.
 */
export const ROUTE_CLASS_MAP: Record<string, RouteClass> = {
  // Auth — unauthenticated, IP-scoped, brute-force targets (strictest budget)
  "/api/auth/refresh": "auth-strict",
  "/api/auth/logout": "auth-strict",
  // Auth — authenticated, IP-scoped, sensitive mutations
  "/api/auth/sessions": "auth",
  "/api/auth/sessions/*": "auth",
  "/api/auth/devices/*": "auth",
  // Invitations — authenticated, IP-scoped
  "/api/invitations": "auth",
  "/api/invitations/*": "auth",
  "/api/auth/invitations/*": "auth",
  // "/api/auth/login": "auth",
  // "/api/auth/register": "auth",
  // "/api/auth/forgot-password": "auth",
  // AI (metered, tenant+user scoped)
  // "/api/ai/*": "ai",
};

/**
 * Default class for unregistered routes. Must be the lowest-risk class (generous budget)
 * so that forgetting to register a route fails safe rather than open.
 *
 * Change this to `"auth"` (lowest budget) if you want unregistered routes to be
 * strictly throttled until explicitly classified.
 */
export const DEFAULT_ROUTE_CLASS: RouteClass = "default";

// ---------------------------------------------------------------------------
// Route-class resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the route class for a given request path. Checks exact matches first,
 * then prefix matches (longest prefix wins), and falls back to the default class.
 *
 * @param pathname  The request path (e.g. `"/api/auth/login"`).
 * @returns The resolved {@link RouteClass}.
 */
export function resolveRouteClass(pathname: string): RouteClass {
  const exact = ROUTE_CLASS_MAP[pathname];
  if (exact) return exact;

  let best: RouteClass = DEFAULT_ROUTE_CLASS;
  let bestLen = 0;

  for (const [pattern, cls] of Object.entries(ROUTE_CLASS_MAP)) {
    if (!pattern.endsWith("/*")) continue;
    const prefix = pattern.slice(0, -2);
    if (pathname.startsWith(prefix) && pattern.length > bestLen) {
      best = cls;
      bestLen = pattern.length;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/**
 * Build a Redis key for a rate-limit bucket. The key includes a window segment
 * that rotates every {@link RateLimitBudget.windowSeconds} seconds, ensuring
 * keys auto-expire (required by the `noeviction` Redis policy).
 *
 * @param routeClass  The resolved route class.
 * @param identity    IP address for `auth`, or `"schoolId:userId"` for `ai`/`default`.
 * @returns A Redis key of the form `rl:{scope}:{identity}:{window}`.
 */
export function buildRateLimitKey(routeClass: RouteClass, identity: string): string {
  const budget = RATE_LIMIT_BUDGETS[routeClass];
  const window = Math.floor(Date.now() / 1000 / budget.windowSeconds);

  if (routeClass === "auth" || routeClass === "auth-strict") {
    return `rl:${routeClass}:${identity}:${window}`;
  }

  return `rl:sch:${identity}:${routeClass}:${window}`;
}
