import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";

import { erpNextWebhookRoutes } from "./erpnext/webhook";
import { healthRoutes } from "./health";
import {
  requestIdMiddleware,
  localeMiddleware,
  loggerMiddleware,
  errorHandlerMiddleware,
  rateLimiterMiddleware,
  idempotencyMiddleware,
  notFoundHandler,
} from "./middleware";
import { registerOpenApiComponents } from "./openapi/components";
import { OPENAPI_DOCUMENT_CONFIG } from "./openapi/config";
import { openApiValidationHook } from "./openapi/hook";

import type { Database } from "./db";
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
  /** Database client for routes that need it (webhook ingestion). Pass `null` to disable. */
  database?: Database | null;
  /**
   * Mount the interactive reference (`/docs`) and the served document (`/openapi.json`).
   *
   * Injected rather than read from NODE_ENV in here, like isReady and tracker, so a test can
   * exercise both arms without mutating the environment. Defaults to off: these are developer
   * tooling, and the default should be the one that exposes nothing.
   */
  docsEnabled?: boolean;
}

/**
 * Build the Hono application. It is deliberately free of any port binding so it can be exercised
 * directly via `app.request(...)` in tests. Every request is counted by the in-flight tracker so
 * shutdown can drain active work.
 *
 * Returns an OpenAPIHono — a Hono subclass, so every existing caller is unaffected — because the
 * OpenAPI document is generated from this app's own route registry. See src/openapi/document.ts.
 */
export function createApp({
  isReady,
  tracker,
  logger,
  generateRequestId,
  redis,
  database,
  docsEnabled = false,
}: AppOptions): OpenAPIHono<AppEnv> {
  // The defaultHook makes request-validation failures throw into errorHandlerMiddleware instead of
  // being answered by @hono/zod-validator's own un-enveloped 400. Sub-apps inherit it through
  // route(), but each one passes it explicitly too, so it is also correct when unit-tested alone.
  const app = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  registerOpenApiComponents(app);

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

  // Idempotency key middleware: captures and replays POST responses for financial and import
  // endpoints. Only triggers on requests with an `Idempotency-Key` header; all others pass through.
  if (redis) {
    app.use("/api/finance/*", idempotencyMiddleware({ redis }));
    app.use("/api/imports/*", idempotencyMiddleware({ redis }));
  }

  // The ALB in front of this service (infra/terraform/modules/edge) terminates TLS and forwards
  // plaintext to us; its listener actions can't inject response headers, so HSTS has to be set
  // here or nowhere. See docs/runbooks/edge-security.md.
  app.use("*", async (c, next) => {
    await next();
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  });

  app.route("/", healthRoutes(isReady));

  // ERPNext webhook ingestion — mounted only when a database is available. The route is public
  // (no auth middleware) because ERPNext authenticates via HMAC signature, not a session token.
  if (database) {
    app.route("/", erpNextWebhookRoutes(database, logger));
  }

  // The document and the reference site that reads it. Off by default and disabled in production:
  // Scalar's page pulls its bundle from a CDN, and production has no reason to depend on a third
  // party for a page it does not need. Registered from the same OPENAPI_DOCUMENT_CONFIG that
  // scripts/generate-openapi.ts uses, so the served document and the committed one cannot disagree.
  //
  // Both are registered after the routes they describe: OpenAPIHono.route() copies a sub-app's
  // definitions into this app's registry at mount time, and doc31 reads that registry.
  if (docsEnabled) {
    app.doc31("/openapi.json", OPENAPI_DOCUMENT_CONFIG);
    app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "Studafy API" }));
  }

  // One error envelope for the whole app, for both the ways a request can fail: no route matched it,
  // or a handler threw. Registered last for readability only: Hono attaches these to the app rather
  // than to the middleware chain, so registration order does not affect either.
  app.notFound(notFoundHandler);
  app.onError(errorHandlerMiddleware(logger));

  return app;
}
