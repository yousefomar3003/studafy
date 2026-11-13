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
 * - `scope` is the class name for IP-scoped classes (see {@link IP_SCOPED_ROUTE_CLASSES}) or `sch`
 *   (tenant-scoped for ai/messaging/default).
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

export type RouteClass =
  "auth" | "auth-strict" | "auth-login" | "auth-session" | "ai" | "messaging" | "default";

/**
 * Classes keyed on the caller's IP rather than on a signed-in user, because they serve requests
 * made before (or instead of) authentication. Their 429s are also reported as auth anomalies.
 */
export const IP_SCOPED_ROUTE_CLASSES: ReadonlySet<RouteClass> = new Set([
  "auth",
  "auth-strict",
  "auth-login",
  "auth-session",
]);

/**
 * Per-class token-bucket budgets.
 *
 * - `auth-strict`: Unauthenticated endpoints with brute-force or enumeration risk.
 *   5 tokens burst, ~5 req/min sustained.
 * - `auth-session`: `/api/auth/refresh` and `/api/auth/logout`. A whole school's devices usually
 *   share one public IP (the school's NAT), and every signed-in device refreshes about every 13
 *   minutes (15-minute access tokens), so a per-IP budget sized for one person 429s a school at the
 *   start of the day. Brute force is not what bounds these: a refresh token is a 256-bit random
 *   secret, single-use, with reuse detection revoking its family. 300 burst, 5/s sustained -- about
 *   3,900 active devices per address.
 * - `auth-login`: `/api/auth/login/member`. A class signing in together shares one IP. Guessing is
 *   bounded by the per-member-ID and platform-wide budgets below and by the account lockout, so the
 *   per-IP budget only has to stop one address dominating the platform-wide one. 30 burst,
 *   30/min sustained.
 * - `auth`: Authenticated admin-mutating endpoints (invitations). 10 tokens burst,
 *   ~10 req/min sustained.
 * - `ai`: Metered tenant+user scoped (existing).
 * - `messaging`: Sending a parent<->teacher message, tenant+user scoped. Not path-resolved: the
 *   send route mounts it explicitly for POST only (modules/messaging/routes.ts), so polling the
 *   same path for new messages stays on `default`. 20 burst, ~20 sends/min sustained.
 * - `default`: Generous catch-all for public/read endpoints (existing).
 */
export const RATE_LIMIT_BUDGETS: Record<RouteClass, RateLimitBudget> = {
  "auth-strict": { maxTokens: 5, refillRate: 0.08, windowSeconds: 60 },
  "auth-session": { maxTokens: 300, refillRate: 5, windowSeconds: 60 },
  "auth-login": { maxTokens: 30, refillRate: 0.5, windowSeconds: 60 },
  auth: { maxTokens: 10, refillRate: 0.17, windowSeconds: 60 },
  ai: { maxTokens: 30, refillRate: 0.5, windowSeconds: 60 },
  messaging: { maxTokens: 20, refillRate: 0.33, windowSeconds: 60 },
  default: { maxTokens: 100, refillRate: 1.67, windowSeconds: 60 },
};

/**
 * Member-ID sign-in (`/api/auth/login/member`) budgets that do not depend on the caller's IP
 * (QA-11), on top of its per-IP `auth-login` class, so rotating addresses buys an attacker nothing.
 * Every attempt takes a token from both buckets before any password is checked.
 *
 * - `username`: one member ID, whoever asks. 10 burst, ~10 per 15 minutes sustained — above the
 *   five-wrong-password lockout, so it never blocks someone the lockout would let through, and it
 *   also covers IDs that do not exist, which have no lockout.
 * - `global`: every member sign-in on the platform. A circuit breaker for a distributed spray across
 *   many IDs, sized well above a whole school signing in at once (600 burst, 10/s sustained). An
 *   attacker who drains it blocks member sign-in for everyone until it refills; that is the
 *   intended trade against letting the spray continue, and it raises the auth anomaly alert.
 */
export const MEMBER_LOGIN_BUDGETS = {
  username: { maxTokens: 10, refillRate: 10 / 900, windowSeconds: 900 },
  global: { maxTokens: 600, refillRate: 10, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitBudget>;

/**
 * "Add <child> to this phone" (000215): per parent. A family adds each child once per phone, so ten
 * an hour is generous for real use and stops a stolen parent session from minting child sessions in
 * bulk. On top of the per-IP `auth` class.
 */
export const GUARDIAN_DEVICE_SIGNIN_BUDGET = {
  maxTokens: 10,
  refillRate: 10 / 3600,
  windowSeconds: 3600,
} as const satisfies RateLimitBudget;

/** Redis key for one parent's guardian device sign-in bucket. */
export function buildGuardianDeviceSigninRateLimitKey(guardianUserId: string): string {
  const window = Math.floor(Date.now() / 1000 / GUARDIAN_DEVICE_SIGNIN_BUDGET.windowSeconds);
  return `rl:guardian-device:user:${guardianUserId}:${window}`;
}

/** Redis key for a member sign-in bucket: per normalized member ID, or the one global bucket. */
export function buildMemberLoginRateLimitKey(
  scope: keyof typeof MEMBER_LOGIN_BUDGETS,
  username?: string,
): string {
  // eslint-disable-next-line security/detect-object-injection -- `scope` is a closed union
  const window = Math.floor(Date.now() / 1000 / MEMBER_LOGIN_BUDGETS[scope].windowSeconds);
  return scope === "username"
    ? `rl:member-login:user:${(username ?? "").trim().toUpperCase()}:${window}`
    : `rl:member-login:global:${window}`;
}

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
  // Called by every signed-in device behind a school's shared IP; see `auth-session`.
  "/api/auth/refresh": "auth-session",
  "/api/auth/logout": "auth-session",
  "/api/auth/login/review": "auth-strict",
  // Staging only (env.ts refuses it in production). `auth` rather than `auth-strict` so one tester
  // can sign in as all 15 documented QA accounts well inside the QA-02 five-minute budget from one IP.
  "/api/auth/login/qa": "auth",
  "/api/auth/login/member": "auth-login",
  "/api/auth/password/change": "auth-strict",
  // Auth — authenticated, IP-scoped, sensitive mutations
  "/api/auth/sessions": "auth",
  "/api/auth/sessions/*": "auth",
  "/api/auth/devices/*": "auth",
  "/api/auth/guardian/*": "auth",
  // Invitations — authenticated, IP-scoped
  "/api/invitations": "auth",
  "/api/invitations/*": "auth",
  "/api/auth/invitations/*": "auth",
  // School registration — public, IP-scoped, brute-force target
  "/api/schools/register": "auth-strict",
  "/api/schools/verify-email/*": "auth-strict",
  "/api/schools/resend-verification": "auth-strict",
  // Public account deletion (ST-302) — sends email / consumes a bearer token, IP-scoped.
  "/api/account/deletion-requests": "auth-strict",
  // Public "Talk to us" form: unauthenticated and writes a row per call, so IP-scoped and strict.
  "/api/inquiries": "auth-strict",
  // School sign-up applicants: no account yet, so IP-scoped. `auth` rather than `auth-strict`
  // because one application takes several calls (status, upload URL, submit) from the same IP.
  "/api/school-applications/me": "auth",
  "/api/school-applications/me/*": "auth",
  "/api/auth/oauth/google/school-application/*": "auth-strict",
  "/api/auth/oauth/microsoft/school-application/*": "auth-strict",
  "/api/account/deletion-requests/confirm": "auth-strict",
  "/api/auth/oauth/google/start": "auth-strict",
  "/api/auth/oauth/google/callback": "auth-strict",
  // "/api/auth/login": "auth",
  // "/api/auth/register": "auth",
  // "/api/auth/forgot-password": "auth",
  // Discipline — authenticated CRUD
  "/api/discipline/incidents": "default",
  "/api/discipline/incidents/*": "default",
  // Parent<->teacher messaging — authenticated reads and polling. Sends are additionally limited by
  // the `messaging` class, mounted in modules/messaging/routes.ts.
  "/api/messaging/*": "default",
  // Finance gateway — authenticated, and every write is a synchronous call into ERPNext. Classed
  // explicitly rather than left to fall through, because the cost of a request here is paid by a
  // second system: a burst that this app would shrug off can still exhaust ERPNext's workers.
  "/api/finance/fee-structures": "default",
  "/api/finance/fee-structures/*": "default",
  "/api/finance/expenses": "default",
  "/api/finance/expenses/*": "default",
  // Mobile release floor (ST-257) — public, unauthenticated, IP-scoped, polled on app launch/resume.
  // Generous (default) budget: it is a tiny static read, and throttling it hard would only delay a
  // client learning it must force-update.
  "/api/mobile/config": "default",
  // Same endpoint, canonical name (ST-283) — see config-routes.ts.
  "/meta/mobile-versions": "default",
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

/**
 * Paths the rate limiter never touches. The orchestrator and synthetics poll these on a fixed
 * cadence from shared egress points, so throttling them would both 429 a probe and produce noise
 * in the buckets it shares with real traffic. Kept here (not in the lowercase middleware) so the
 * registry and the bypass cannot drift, and so app.test.ts can reuse it instead of hardcoding the
 * same two strings.
 */
export const RATE_LIMIT_EXEMPT_PATHS: readonly string[] = ["/healthz", "/readyz"];

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

  if (IP_SCOPED_ROUTE_CLASSES.has(routeClass)) {
    return `rl:${routeClass}:${identity}:${window}`;
  }

  return `rl:sch:${identity}:${routeClass}:${window}`;
}
