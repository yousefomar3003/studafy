import { createApp } from "../../src/app";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";

import type { Database } from "../../src/db";
import type { AppEnv } from "../../src/middleware/requestId";
import type { RedisClient } from "../../src/redis";
import type { OpenAPIHono } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Auth context injection
// ---------------------------------------------------------------------------

export interface TestAuthContext {
  schoolId: string;
  userId: string;
}

// Header names consumed by the test auth middleware. These are never sent by
// real clients — the app instance that carries this middleware is test-only.
const HEADER_SCHOOL_ID = "x-test-school-id";
const HEADER_USER_ID = "x-test-user-id";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

export interface TestAppOptions {
  database: Database | null;
  redis?: RedisClient | null;
  docsEnabled?: boolean;
}

/**
 * Build a Hono app wired to real database and Redis for integration testing.
 *
 * The app carries an extra middleware (appended after the standard stack) that
 * reads `x-test-school-id` / `x-test-user-id` request headers and sets the
 * `auth` context. This app instance is never deployed — the headers are test
 * instrumentation, not a production interface.
 */
export function createTestApp(options: TestAppOptions): OpenAPIHono<AppEnv> {
  const logger = createLogger({ destination: () => undefined });

  const app = createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger,
    redis: options.redis ?? null,
    database: options.database,
    docsEnabled: options.docsEnabled ?? false,
  });

  // Test-only auth middleware: runs after requestId/rateLimiter (which is fine —
  // tests don't need school_id in the request log or tenant-scoped rate keys).
  // The middleware is registered last in the chain so it cannot mask production
  // middleware ordering.
  app.use("*", async (c, next) => {
    const schoolId = c.req.header(HEADER_SCHOOL_ID);
    const userId = c.req.header(HEADER_USER_ID);
    if (schoolId && userId) {
      c.set("auth", { schoolId, userId });
    }
    await next();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Authenticated request helper
// ---------------------------------------------------------------------------

/**
 * Make an HTTP request against the test app with injected auth context.
 *
 * The helper sets the `x-test-school-id` and `x-test-user-id` headers, which
 * the test auth middleware reads and converts into a `c.set("auth", ...)` call.
 *
 * @example
 * ```typescript
 * const res = await authenticatedRequest(app, "GET", "/api/users", {
 *   schoolId: tenant.schoolId,
 *   userId: tenant.users.ORG_ADMIN.id,
 * });
 * expect(res.status).toBe(200);
 * ```
 */
export function authenticatedRequest(
  app: OpenAPIHono<AppEnv>,
  method: string,
  path: string,
  auth: TestAuthContext,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set(HEADER_SCHOOL_ID, auth.schoolId);
  headers.set(HEADER_USER_ID, auth.userId);
  return Promise.resolve(app.request(path, { method, headers, ...init }));
}
