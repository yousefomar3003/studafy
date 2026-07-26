import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";

import { ErpNextClient } from "./erpnext/client";
import { erpNextWebhookRoutes } from "./erpnext/webhook";
import { healthRoutes } from "./health";
import { createNoopSecurityEventSink } from "./lib/security/securityEventSink";
import {
  requestIdMiddleware,
  localeMiddleware,
  loggerMiddleware,
  errorHandlerMiddleware,
  rateLimiterMiddleware,
  idempotencyMiddleware,
  notFoundHandler,
  corsMiddleware,
  csrfMiddleware,
  securityHeadersMiddleware,
  jwtAuthMiddleware,
  tenantLifecycleGuard,
} from "./middleware";
import {
  academicYearRoutes,
  termRoutes,
  subjectRoutes,
  courseRoutes,
  classRoutes,
  enrollmentRoutes,
} from "./modules/academics";
import {
  activationRoutes,
  adminDeviceRoutes,
  configureRefreshCookie,
  createJtiDenylist,
  googleOAuthRoutes,
  jwksRoutes,
  microsoftOAuthRoutes,
  providerLinkRoutes,
  returningUserLoginRoutes,
  sessionRoutes,
} from "./modules/auth";
import { invitationRoutes } from "./modules/auth/invitation/route";
import { importRoutes } from "./modules/imports";
import { provisioningRoutes } from "./modules/tenancy/provisioning/route";
import { registerSchoolRoutes } from "./modules/tenancy/registration/route";
import { schoolSettingsRoutes } from "./modules/tenancy/settings/route";
import { emailVerificationRoutes } from "./modules/tenancy/verification/route";
import { userRoutes, studentRoutes, teacherRoutes } from "./modules/users";
import { registerOpenApiComponents } from "./openapi/components";
import { OPENAPI_DOCUMENT_CONFIG } from "./openapi/config";
import { openApiValidationHook } from "./openapi/hook";

import type { Database } from "./db";
import type { SecurityEventSink } from "./lib/security/securityEventSink";
import type { InflightTracker } from "./lifecycle";
import type { Logger } from "./logger";
import type { AppEnv } from "./middleware/requestId";
import type { KeyStore } from "./modules/auth";
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
   * JWT key store for signing and JWKS endpoint.
   *
   * Pass `null` to disable both the JWKS route and the authentication middleware — without keys
   * there is nothing to verify against, and mounting the middleware anyway would answer every
   * `/api/*` request with a 503.
   */
  keyStore?: KeyStore | null;
  /** Required `iss` claim on access tokens. Threaded from env.JWT_ISSUER. */
  jwtIssuer?: string;
  /** Required `aud` claim on access tokens. Threaded from env.JWT_AUDIENCE. */
  jwtAudience?: string;
  /** Access-token lifetime in seconds. Threaded from env.JWT_ACCESS_TTL_SECONDS. */
  jwtAccessTtlSeconds?: number;
  /** Refresh-token lifetime in seconds, reapplied on every rotation. From env.JWT_REFRESH_TTL_SECONDS. */
  jwtRefreshTtlSeconds?: number;
  /**
   * Where CORS and CSRF rejections are persisted (app.security_events).
   *
   * Injected rather than constructed from `database` in here, and defaulting to a no-op, for the
   * same reason `logger` is injected: the default must be the one that writes nothing, so `bun
   * test` never issues background INSERTs. src/index.ts owns the real sink and its shutdown.
   */
  securityEventSink?: SecurityEventSink | null;
  /**
   * Mount the interactive reference (`/docs`) and the served document (`/openapi.json`).
   *
   * Injected rather than read from NODE_ENV in here, like isReady and tracker, so a test can
   * exercise both arms without mutating the environment. Defaults to off: these are developer
   * tooling, and the default should be the one that exposes nothing.
   */
  docsEnabled?: boolean;
  /**
   * Seam for account activation's Microsoft OIDC verification (ST-078). Defaults to the real ST-077
   * ID-token validation; injected in tests so activation can run without a live Microsoft JWKS, the
   * same way `logger` and `securityEventSink` are injected.
   */
  microsoftIdentityVerifier?: (
    idToken: string,
    nonce: string,
  ) => Promise<{ subject: string; email: string }>;
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
  keyStore,
  jwtIssuer = "studafy",
  jwtAudience = "studafy-api",
  jwtAccessTtlSeconds = 900,
  jwtRefreshTtlSeconds = 30 * 24 * 60 * 60,
  securityEventSink,
  docsEnabled = false,
  microsoftIdentityVerifier,
}: AppOptions): OpenAPIHono<AppEnv> {
  const eventSink = securityEventSink ?? createNoopSecurityEventSink();
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

  // CORS middleware: first of the security chain, so a preflight is answered and a disallowed
  // origin is dropped before any downstream middleware claims a connection or a lock.
  app.use("*", corsMiddleware({ eventSink }));

  // Security headers: CSP, HSTS, X-Frame-Options, and friends on every response.
  //
  // HSTS lives here rather than at the edge because the ALB in front of this service
  // (infra/terraform/modules/edge) terminates TLS and forwards plaintext to us; its listener
  // actions can't inject response headers, so HSTS has to be set here or nowhere. See
  // docs/runbooks/edge-security.md.
  app.use("*", securityHeadersMiddleware());

  // CSRF: double-submit cookie check on state-mutating requests that are not Bearer-authenticated.
  // After CORS so preflights are already answered and never reach it.
  app.use("/api/*", csrfMiddleware({ eventSink }));

  // Locale middleware: parses Accept-Language header and attaches locale to request context
  app.use("*", localeMiddleware());

  // Structured logger middleware: logs request/response lifecycle (excludes health checks)
  app.use("*", loggerMiddleware({ logger, excludePaths: ["/healthz", "/readyz"] }));

  // JWT authentication: deny-by-default on every /api/* route, with an explicit exemption list
  // inside the middleware for endpoints that authenticate by other means (the ERPNext webhook uses
  // an HMAC signature). A new route under /api is therefore protected the moment it is mounted —
  // nobody has to remember to opt in.
  //
  // Placed after the logger so a rejected request is still logged, and deliberately *before* the
  // rate limiter: buildRateLimitKey (src/config/rateLimits.ts) keys authenticated traffic on
  // schoolId:userId and falls back to the client IP when no auth context exists, so mounting it
  // after the limiter would silently collapse every user behind a shared NAT into one bucket.
  // It also runs after csrfMiddleware, which already exempts Bearer-authenticated requests.
  // Built once and shared between the middleware that reads it and the revocation services that
  // write it (ST-072). Two clients over the same Redis would behave identically, but a single
  // instance makes it structurally impossible for the read side and the write side of the revocation
  // boundary to drift onto different connections or key prefixes.
  const jtiDenylist = redis ? createJtiDenylist(redis) : null;

  if (keyStore) {
    app.use(
      "/api/*",
      jwtAuthMiddleware({
        keyStore,
        denylist: jtiDenylist,
        issuer: jwtIssuer,
        audience: jwtAudience,
      }),
    );
  }

  // Tenant lifecycle guard: enforces subscription state machine (ST-092). Runs after JWT auth
  // so the auth context (including subscriptionStatus claim) is available. Runs before the rate
  // limiter so lifecycle blocks short-circuit before any quota consumption.
  app.use("/api/*", tenantLifecycleGuard());

  // Rate limiter middleware: token-bucket rate limiting via Redis. Registered after the logger
  // so rate-limited requests are still logged for observability, but before routes so they
  // short-circuit before any handler runs.
  if (redis) {
    app.use("*", rateLimiterMiddleware({ redis, eventSink }));
  }

  // Idempotency key middleware: captures and replays POST responses for financial and import
  // endpoints. Only triggers on requests with an `Idempotency-Key` header; all others pass through.
  if (redis) {
    app.use("/api/finance/*", idempotencyMiddleware({ redis }));
    app.use("/api/imports/*", idempotencyMiddleware({ redis }));
  }

  app.route("/", healthRoutes(isReady));

  // ERPNext webhook ingestion — mounted only when a database is available. The route is public
  // (no auth middleware) because ERPNext authenticates via HMAC signature, not a session token.
  if (database) {
    app.route("/", erpNextWebhookRoutes(database, logger));
  }

  // School self-registration — public, no authentication. Protected by Turnstile captcha and
  // rate limiting (auth-strict class). Needs a database to create the school, admin user,
  // and activation invitation in a single transaction.
  if (database) {
    app.route("/", registerSchoolRoutes(database, logger));
  }

  // School email verification — public, no authentication. Rate-limited (auth-strict class).
  // Verify consumes a one-time token and activates the school; resend regenerates the token.
  // Triggers async tenant provisioning (trial subscription, ERPNext bootstrap) on success.
  if (database) {
    const erpNextClient =
      process.env.ERPNEXT_API_URL && process.env.ERPNEXT_API_KEY
        ? new ErpNextClient({
            baseUrl: process.env.ERPNEXT_API_URL,
            apiKey: process.env.ERPNEXT_API_KEY,
          })
        : null;
    app.route("/", emailVerificationRoutes(database, logger, erpNextClient));
  }

  // JWKS endpoint — public, no authentication required. Clients fetch this to verify access tokens.
  if (keyStore) {
    app.route("/", jwksRoutes(keyStore));
  }

  // Invitation routes — requires database for persistence and outbox event emission.
  if (database) {
    app.route("/", invitationRoutes(database, logger));
  }

  // Session lifecycle (ST-071). Needs both a key store to mint access tokens and a database to hold
  // the refresh-token families, so it mounts only when both exist.
  //
  // /api/auth/refresh and /api/auth/logout are exempt from the authentication boundary above via
  // DEFAULT_PUBLIC_PATHS in middleware/jwtAuth.ts — they authenticate with a refresh token, and
  // requiring an access token would make them unreachable exactly when a client needs them. The
  // session enumeration and termination routes in the same sub-app are *not* exempt and run behind
  // the normal boundary.
  if (keyStore && database) {
    configureRefreshCookie(jwtRefreshTtlSeconds);
    app.route(
      "/",
      sessionRoutes(
        database,
        {
          keyStore,
          issuer: jwtIssuer,
          audience: jwtAudience,
          accessTtlSeconds: jwtAccessTtlSeconds,
          refreshTtlSeconds: jwtRefreshTtlSeconds,
        },
        jtiDenylist,
        eventSink,
      ),
    );
  }

  // Google OAuth (OIDC). Requires a database to look up oauth_identities and issue tokens, plus
  // a key store to sign the resulting access tokens.
  if (database && keyStore) {
    app.route(
      "/",
      googleOAuthRoutes(
        database,
        {
          keyStore,
          issuer: jwtIssuer,
          audience: jwtAudience,
          accessTtlSeconds: jwtAccessTtlSeconds,
          refreshTtlSeconds: jwtRefreshTtlSeconds,
        },
        logger,
      ),
    );
  }

  // Microsoft OAuth (OIDC). Same requirements as Google — database for identity lookup, key store
  // for access-token signing. Uses the Microsoft identity platform common endpoint, which accepts
  // tokens from any Entra ID tenant.
  if (database && keyStore) {
    app.route(
      "/",
      microsoftOAuthRoutes(
        database,
        {
          keyStore,
          issuer: jwtIssuer,
          audience: jwtAudience,
          accessTtlSeconds: jwtAccessTtlSeconds,
          refreshTtlSeconds: jwtRefreshTtlSeconds,
        },
        logger,
      ),
    );
  }

  // Account activation (ST-078). Consumes an invitation, provisions the user, links the Microsoft
  // identity, and issues the first session token pair in one transaction. Public like the OAuth
  // callbacks (the invitation token is the credential), and needs a database plus a key store to mint
  // that first token pair.
  if (database && keyStore) {
    app.route(
      "/",
      activationRoutes(
        database,
        {
          keyStore,
          issuer: jwtIssuer,
          audience: jwtAudience,
          accessTtlSeconds: jwtAccessTtlSeconds,
          refreshTtlSeconds: jwtRefreshTtlSeconds,
        },
        logger,
        microsoftIdentityVerifier ? { verifyMicrosoftIdentity: microsoftIdentityVerifier } : {},
      ),
    );
  }

  // Returning-user OAuth login (ST-079). Authenticates an active user via a verified Microsoft
  // OIDC id_token, matches against oauth_identities, enforces tenant suspension policy, and
  // issues session tokens. Public like the OAuth callbacks — the id_token is the credential.
  if (database && keyStore) {
    app.route(
      "/",
      returningUserLoginRoutes(
        database,
        {
          keyStore,
          issuer: jwtIssuer,
          audience: jwtAudience,
          accessTtlSeconds: jwtAccessTtlSeconds,
          refreshTtlSeconds: jwtRefreshTtlSeconds,
        },
        logger,
        microsoftIdentityVerifier ? { verifyMicrosoftIdentity: microsoftIdentityVerifier } : {},
      ),
    );
  }

  // OAuth provider linking (R-03). Lets authenticated users link a second provider for lockout
  // resilience, and admins unlink providers. Needs database for identity CRUD and the state store
  // for the linking OAuth flow.
  if (database && keyStore) {
    app.route(
      "/",
      providerLinkRoutes(
        database,
        {
          keyStore,
          issuer: jwtIssuer,
          audience: jwtAudience,
          accessTtlSeconds: jwtAccessTtlSeconds,
          refreshTtlSeconds: jwtRefreshTtlSeconds,
        },
        logger,
      ),
    );
  }

  // Administrative device revocation (ST-072). Needs only a database — it revokes and denylists but
  // never mints, so no key store is involved. Mounted under /api/admin, inside the authentication
  // boundary above, and additionally gated per-route on PERMISSIONS.USER_SUSPEND by
  // middleware/authz.ts. It is the first surface in this app that acts on a user other than the
  // caller; see the header of routes/admin-device-routes.ts.
  if (database) {
    app.route("/", adminDeviceRoutes(database, jtiDenylist));
  }

  // School settings (GET/PATCH /api/schools/current/settings). Authenticated, admin-only,
  // web-channel only. Needs database for settings CRUD and audit logging.
  if (database) {
    app.route("/", schoolSettingsRoutes(database));
  }

  // User management & administration (ST-093). CRUD endpoints for managing school users,
  // role assignments, and deactivation with session/invitation revocation. Gated on USER_*
  // and ROLE_* permissions, with web-only channel guard on all mutations.
  if (database) {
    app.route("/", userRoutes(database, jtiDenylist));
  }

  // Student profiles (CRUD). Demographics, guardians, and admission data with finance-visible
  // field projection and role-based view scoping. Gated on STUDENT_* permissions.
  if (database) {
    app.route("/", studentRoutes(database));
  }

  // Student CSV import (upload → validate → confirm → async processing).
  // Gated on STUDENT_IMPORT permission. Idempotency key middleware pre-wired on /api/imports/*.
  if (database) {
    app.route("/", importRoutes(database, redis ?? null));
  }

  // Teacher profiles (CRUD). Employment data with role-based view scoping. Admin full CRUD,
  // teacher self-view of own profile read-only. Gated on TEACHER_* permissions.
  if (database) {
    app.route("/", teacherRoutes(database));
  }

  // Academic year & term management (ST-091). Full CRUD plus a rollover action that transitions
  // academic years and archives enrollments atomically. Authenticated and tenant-scoped.
  if (database) {
    app.route("/", academicYearRoutes(database));
    app.route("/", termRoutes(database));
  }

  // Subject & course catalog (CRUD). Subjects are top-level catalog entities; courses belong
  // to a subject. Delete archives instead of hard-deleting when referenced by dependents.
  if (database) {
    app.route("/", subjectRoutes(database));
    app.route("/", courseRoutes(database));
  }

  // Class delivery & enrollment management. Classes represent scheduled course offerings;
  // enrollments bind students to classes with capacity enforcement and transfer history.
  if (database) {
    app.route("/", classRoutes(database));
    app.route("/", enrollmentRoutes(database));
  }

  // Tenant provisioning status & manual trigger (ST-089). Authenticated and admin-scoped.
  // Provides read access to provisioning status and manual provisioning trigger.
  if (database) {
    app.route("/", provisioningRoutes(database, logger));
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
