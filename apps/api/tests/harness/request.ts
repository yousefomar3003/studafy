import { ROLES } from "@studafy/constants";

import { createApp } from "../../src/app";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";
import { AUTH_CHANNELS, KeyStore, signAccessToken } from "../../src/modules/auth";

import type { Database } from "../../src/db";
import type { AppEnv } from "../../src/middleware/requestId";
import type { AuthChannel } from "../../src/modules/auth";
import type { RedisClient } from "../../src/redis";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Role } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

/** Issuer/audience the harness signs and the app verifies with. */
export const TEST_JWT_ISSUER = "studafy-test";
export const TEST_JWT_AUDIENCE = "studafy-api-test";

export interface TestAuthContext {
  schoolId: string;
  userId: string;
  /** Defaults to `[ORG_ADMIN]` — enough to reach any route without being SUPER_ADMIN. */
  roles?: Role[];
  /** Defaults to `api`. */
  channel?: AuthChannel;
  /** Seconds until the minted token expires. Negative values produce an already-expired token. */
  ttlSeconds?: number;
  /**
   * The `jti` to stamp on the token. Defaults to a fresh uuid.
   *
   * Set it to pair a token with a seeded `app.refresh_tokens` row carrying the same `access_jti`,
   * which is the invariant issueTokenPair maintains in production. The revocation suite needs that
   * pairing to assert a *specific* token stops working after its session is torn down.
   */
  jti?: string;
}

export interface TestAppOptions {
  database: Database | null;
  redis?: RedisClient | null;
  docsEnabled?: boolean;
}

/** A test app plus the key store whose keys its tokens must be signed with. */
export interface TestApp {
  app: OpenAPIHono<AppEnv>;
  keyStore: KeyStore;
}

/**
 * Build a Hono app wired to real database and Redis for integration testing.
 *
 * Authentication is genuine: the app runs the production jwtAuthMiddleware, and this factory hands
 * back the KeyStore so tests can mint tokens it will actually accept. An earlier version of this
 * harness injected `c.set("auth", …)` from `x-test-*` headers in a middleware appended after the
 * standard stack, which meant the auth context was invisible to requestIdMiddleware and the rate
 * limiter — so tests could not observe school_id in log lines or tenant-scoped rate-limit keys, and
 * could never have caught a regression in the middleware ordering. Signing a real token costs a few
 * milliseconds per test and exercises the whole path instead.
 *
 * Remember to call `keyStore.destroy()` in teardown: init() starts a rotation timer.
 */
export function createTestApp(options: TestAppOptions): TestApp & { ready: Promise<void> } {
  const logger = createLogger({ destination: () => undefined });
  const keyStore = new KeyStore(60_000);

  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    redis: options.redis ?? null,
    database: options.database,
    keyStore,
    jwtIssuer: TEST_JWT_ISSUER,
    jwtAudience: TEST_JWT_AUDIENCE,
    docsEnabled: options.docsEnabled ?? false,
  });

  return { app, keyStore, ready: keyStore.init() };
}

// ---------------------------------------------------------------------------
// Token minting
// ---------------------------------------------------------------------------

/**
 * Mint an access token the test app will accept, signed by the genuine signing service.
 *
 * Tests that need an *invalid* token should start here and then break the result — that way the
 * only difference from a working token is the thing under test.
 */
export function mintTestToken(keyStore: KeyStore, auth: TestAuthContext): Promise<string> {
  return signAccessToken(
    keyStore,
    {
      sub: auth.userId,
      school_id: auth.schoolId,
      roles: auth.roles ?? [ROLES.ORG_ADMIN],
      entitlements_ver: 1,
      channel: auth.channel ?? AUTH_CHANNELS.API,
    },
    {
      issuer: TEST_JWT_ISSUER,
      audience: TEST_JWT_AUDIENCE,
      ttlSeconds: auth.ttlSeconds ?? 900,
      ...(auth.jti !== undefined ? { jti: auth.jti } : {}),
    },
  );
}

// ---------------------------------------------------------------------------
// Authenticated request helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request against the test app carrying a real bearer token.
 *
 * @example
 * ```typescript
 * const { app, keyStore, ready } = createTestApp({ database });
 * await ready;
 * const res = await authenticatedRequest({ app, keyStore }, "GET", "/api/users", {
 *   schoolId: tenant.schoolId,
 *   userId: tenant.users.ORG_ADMIN.id,
 * });
 * expect(res.status).toBe(200);
 * ```
 */
export async function authenticatedRequest(
  { app, keyStore }: TestApp,
  method: string,
  path: string,
  auth: TestAuthContext,
  init?: RequestInit,
): Promise<Response> {
  const token = await mintTestToken(keyStore, auth);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return app.request(path, { ...init, method, headers });
}
