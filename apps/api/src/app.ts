import { Hono } from "hono";

import { healthRoutes } from "./health";
import {
  requestIdMiddleware,
  localeMiddleware,
  loggerMiddleware,
  errorHandlerMiddleware,
  rateLimiterMiddleware,
  notFoundHandler,
} from "./middleware";

import type { InflightTracker } from "./lifecycle";
import type { Logger } from "./logger";
import type { AppEnv } from "./middleware/requestId";
import type { RedisClient } from "./redis";

export interface AppOptions {
  isReady: () => boolean | Promise<boolean>;
  tracker: InflightTracker;
  /**
   * Root logger. Injected like isReady and tracker so tests can supply one writing to an array;
   * required rather than defaulted, because a default would write real NDJSON to stdout under
   * `bun test`.
   */
  logger: Logger;
  /** Seam for deterministic request ids in tests. Defaults to crypto.randomUUID. */
  generateRequestId?: () => string;
  /** Redis client for rate limiting and caching. Pass `null` to disable rate limiting. */
  redis?: RedisClient | null;
}

/**
 * Build the Hono application. It is deliberately free of any port binding so it can be exercised
 * directly via `app.request(...)` in tests. Every request is counted by the in-flight tracker so
 * shutdown can drain active work.
 */
export function createApp({
  isReady,
  tracker,
  logger,
  generateRequestId,
  redis,
}: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Outermost, and it must stay there: its `finally` has to be the last thing to run so shutdown
  // drains a request even when everything inside it fails.
  app.use("*", async (_c, next) => {
    tracker.begin();
    try {
      await next();
    } finally {
      tracker.end();
    }
  });

  // Request ID middleware: generates unique ID per request, creates child logger, stamps X-Request-Id
  app.use("*", requestIdMiddleware({ logger, generateRequestId }));

  // Locale middleware: parses Accept-Language header and attaches locale to request context
  app.use("*", localeMiddleware());

  // Structured logger middleware: logs request/response lifecycle (excludes health checks)
  app.use("*", loggerMiddleware({ logger, excludePaths: ["/healthz", "/readyz"] }));

  // Rate limiter middleware: token-bucket rate limiting via Redis. Registered after the logger
  // so rate-limited requests are still logged for observability, but before routes so they
  // short-circuit before any handler runs.
  if (redis) {
    app.use("*", rateLimiterMiddleware({ redis }));
  }

  // The ALB in front of this service (infra/terraform/modules/edge) terminates TLS and forwards
  // plaintext to us; its listener actions can't inject response headers, so HSTS has to be set
  // here or nowhere. See docs/runbooks/edge-security.md.
  app.use("*", async (c, next) => {
    await next();
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  });

  app.route("/", healthRoutes(isReady));

  // One error envelope for the whole app, for both the ways a request can fail: no route matched it,
  // or a handler threw. Registered last for readability only: Hono attaches these to the app rather
  // than to the middleware chain, so registration order does not affect either.
  app.notFound(notFoundHandler);
  app.onError(errorHandlerMiddleware(logger));

  return app;
}
