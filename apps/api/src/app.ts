import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";

import { emailEventWebhookRoutes } from "./email/webhook";
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
  roomRoutes,
  enrollmentRoutes,
  timetableRoutes,
  examRoutes,
  materialRoutes,
} from "./modules/academics";
import { assignmentRoutes } from "./modules/academics/assignments";
import { submissionRoutes } from "./modules/academics/submissions";
import {
  AI_EXAM_MAX_RESERVE_TOKENS,
  AI_LLM_MAX_RESERVE_TOKENS,
  aiAskRoutes,
  aiConceptsRoutes,
  aiEntitlementGate,
  aiExamRoutes,
  aiExplainRoutes,
  aiFlashcardRoutes,
  aiGatewayRoutes,
  aiQuizRoutes,
  aiReportRoutes,
  aiMetricsRoutes,
  aiRetrievalRoutes,
  aiSummaryRoutes,
  aiUsageRoutes,
  createAiTokenMeter,
  createConceptsCache,
  createDeterministicCrossEncoderReranker,
  createDeterministicQueryEmbedder,
  createSummaryCache,
} from "./modules/ai";
import { announcementRoutes } from "./modules/announcements";
import {
  attendanceCorrectionRoutes,
  attendanceReportRoutes,
  attendanceSessionRoutes,
} from "./modules/attendance";
import { auditRoutes } from "./modules/audit";
import {
  activationOAuthRoutes,
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
import { bulkInviteRoutes } from "./modules/auth/invitation/bulk-invite-routes";
import { invitationRoutes } from "./modules/auth/invitation/route";
import { disciplineRoutes, evaluationRoutes } from "./modules/discipline";
import {
  EnvCredentialResolver,
  expenseRoutes,
  familyFinancialViewRoutes,
  feeStructureRoutes,
  financeInvoiceRoutes,
  financeReportRoutes,
  installmentRoutes,
  paymentRoutes,
  paymentWebhookRoutes,
  reconciliationRoutes,
  refundRoutes,
  refundWebhookRoutes,
  scholarshipDiscountRoutes,
  TenantErpNextFactory,
} from "./modules/finance";
import {
  approvalQueueRoutes,
  gradebookConfigRoutes,
  gradeEntryRoutes,
  publishedGradeRoutes,
} from "./modules/grades";
import { importRoutes } from "./modules/imports";
import { notificationRoutes, notificationPreferencesRoutes } from "./modules/notifications";
import { childComparisonRoutes } from "./modules/reports";
import { storageRoutes } from "./modules/storage";
import {
  checkoutRoutes,
  schoolCheckoutRoutes,
  aiCheckoutRoutes,
  webhookRoutes,
  planRoutes,
  adminSubscriptionRoutes,
  billingOverviewRoutes,
  invoiceRoutes,
  cancellationRoutes,
  createEntitlementService,
} from "./modules/subscriptions";
import { lookupsRoutes } from "./modules/tenancy/lookups/route";
import { provisioningRoutes } from "./modules/tenancy/provisioning/route";
import { registerSchoolRoutes } from "./modules/tenancy/registration/route";
import { schoolSettingsRoutes } from "./modules/tenancy/settings/route";
import { emailVerificationRoutes } from "./modules/tenancy/verification/route";
import { familyRoutes, userRoutes, studentRoutes, teacherRoutes } from "./modules/users";
import { registerOpenApiComponents } from "./openapi/components";
import { OPENAPI_DOCUMENT_CONFIG } from "./openapi/config";
import { openApiValidationHook } from "./openapi/hook";

import type { Database } from "./db";
import type { SecurityEventSink } from "./lib/security/securityEventSink";
import type { StorageService } from "./lib/storage";
import type { InflightTracker } from "./lifecycle";
import type { Logger } from "./logger";
import type { AppEnv } from "./middleware/requestId";
import type { AiModelTier, LlmProvider } from "./modules/ai";
import type { KeyStore } from "./modules/auth";
import type { PaymentProviderPort } from "./modules/subscriptions";
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
  /** Read-replica pool for analytical routes. Defaults to database outside production. */
  readDatabase?: Database | null;
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
   * Cross-encoder re-ranking (ST-163) kill switch. When true, the hybrid-retrieval route mounts with
   * a re-ranker that re-scores the fused top-20 and returns the top 6. Off by default so an unset
   * environment deploys the previous RRF-only behavior. Injected rather than read from the
   * environment in here, so a test can exercise both arms without mutating the environment.
   */
  aiRerankEnabled?: boolean;
  /**
   * LLM provider for the gateway (ST-164). Null (or absent) when the AI_LLM_ENABLED kill switch is
   * off: the generate route still registers — so the published contract does not depend on a
   * deployment's environment, the storage-upload precedent — and answers 503 AI_LLM_DISABLED at
   * request time. Injected rather than constructed in here because building the provider needs the
   * environment and the per-school circuit breaker, both owned by src/index.ts, and so a test can
   * inject a fake.
   */
  aiLlmProvider?: LlmProvider | null;
  /**
   * Model-id overrides for the gateway's routing table (`AI_LLM_SMALL_MODEL` / `AI_LLM_LARGE_MODEL`).
   * Threaded from the environment by src/index.ts so flipping a model is an env change, not a code
   * change.
   */
  aiLlmModelOverrides?: Partial<Record<AiModelTier, string>>;
  /**
   * Seam for account activation's Microsoft OIDC verification (ST-078). Defaults to the real ST-077
   * ID-token validation; injected in tests so activation can run without a live Microsoft JWKS, the
   * same way `logger` and `securityEventSink` are injected.
   */
  microsoftIdentityVerifier?: (
    idToken: string,
    nonce: string,
  ) => Promise<{ subject: string; email: string }>;
  /**
   * S3-compatible object storage for assignment attachments (ST-103).
   *
   * Nullable and defaulted to null, like `redis`: dev, test, and the OpenAPI generator all run
   * without a bucket. Routes that need it still register — so the published contract does not
   * depend on a deployment's environment — and answer 503 at request time. See
   * modules/academics/assignments/routes/assignment-routes.ts.
   */
  storage?: StorageService | null;
  /**
   * Stripe payment provider for subscription billing.
   *
   * Nullable: when absent, checkout, portal, and webhook routes still register (so the OpenAPI
   * contract does not depend on a deployment's environment) and answer 503 at request time.
   */
  stripeProvider?: PaymentProviderPort | null;
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
  readDatabase,
  keyStore,
  jwtIssuer = "studafy",
  jwtAudience = "studafy-api",
  jwtAccessTtlSeconds = 900,
  jwtRefreshTtlSeconds = 30 * 24 * 60 * 60,
  securityEventSink,
  docsEnabled = false,
  aiRerankEnabled = false,
  aiLlmProvider = null,
  aiLlmModelOverrides = {},
  microsoftIdentityVerifier,
  storage = null,
  stripeProvider = null,
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

  // The entitlement service (ST-133). Shared between the JWT middleware's staleness check and any
  // route that needs to resolve entitlements, for the same reason the denylist is shared: one
  // instance makes it structurally impossible for the two sides to drift onto different key
  // prefixes. Requires a database — without one there is nothing to resolve against, and the
  // middleware degrades to the same "not enforced" warning it gives without a denylist.
  const entitlements = database
    ? createEntitlementService({ database, redis: redis ?? null, logger })
    : null;

  if (keyStore) {
    app.use(
      "/api/*",
      jwtAuthMiddleware({
        keyStore,
        denylist: jtiDenylist,
        entitlements,
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
    app.use("/api/attendance/records/batch", idempotencyMiddleware({ redis }));
  }

  app.route("/", healthRoutes(isReady));

  // ERPNext webhook ingestion — mounted only when a database is available. The route is public
  // (no auth middleware) because ERPNext authenticates via HMAC signature, not a session token.
  //
  // The payment-confirmation receiver (ST-121) is mounted alongside it and for the same reason: it
  // authenticates by HMAC over the raw body, so it must sit outside the bearer-token chain. It gets
  // its own URL rather than sharing the generic one because payment confirmation carries an SLA the
  // rest of the ingest does not, and a single-purpose path can be monitored and alerted on its own.
  // Both share one projection (modules/finance/payments/projection.ts) and one dedup table.
  if (database) {
    app.route("/", erpNextWebhookRoutes(database, logger));
    app.route("/", paymentWebhookRoutes(database, logger));
    app.route("/", refundWebhookRoutes(database, logger));
  }

  // SES → SNS email-event webhook (deliverability R-08). Mounted with the other webhooks for the
  // same reason: it authenticates by SNS's RSA signature plus a topic ARN allowlist, not by a
  // session token, so it must sit outside the bearer-token chain. It is mounted only when a
  // database is available because ingestion writes the event ledger, suppression list, and delivery
  // status.
  if (database) {
    app.route("/", emailEventWebhookRoutes(database, logger));
  }

  // School self-registration — public, no authentication. Protected by Turnstile captcha and
  // rate limiting (auth-strict class). Needs a database to create the school, admin user,
  // and activation invitation in a single transaction.
  if (database) {
    app.route("/", registerSchoolRoutes(database, logger));
  }

  // Reference-data lookups (countries, currencies) — public, no authentication, read-only.
  // Feeds the country/currency selectors on the school self-registration form.
  if (database) {
    app.route("/", lookupsRoutes(database));
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

  // Finance gateway (ST-119). A pass-through to each school's ERPNext site: ERPNext owns fee
  // validation, currency rules and totals, and this only routes, crosswalks ids, and maintains the
  // read model. The Host header selects the tenant's Frappe site, so the client is built per
  // school rather than shared. Idempotency on /api/finance/* is already wired above.
  if (database) {
    const erpnextFactory = new TenantErpNextFactory({
      resolver: new EnvCredentialResolver({
        baseUrl: process.env.ERPNEXT_API_URL,
        apiKey: process.env.ERPNEXT_API_KEY,
      }),
      logger,
      redis,
    });

    app.route("/", feeStructureRoutes(database, erpnextFactory));
    app.route("/", financeInvoiceRoutes(database, redis ?? null));
    app.route("/", financeReportRoutes(database, erpnextFactory, redis ?? null, storage));
    app.route("/", familyFinancialViewRoutes(database, process.env.PAYMENT_REDIRECT_BASE_URL));
    app.route("/", expenseRoutes(database, erpnextFactory, storage));
    app.route("/", paymentRoutes(database, erpnextFactory));
    app.route("/", scholarshipDiscountRoutes(database, erpnextFactory));
    app.route("/", refundRoutes(database, erpnextFactory));
    app.route("/", installmentRoutes(database, erpnextFactory));
    app.route("/", reconciliationRoutes(database, erpnextFactory, logger));
  }

  // JWKS endpoint — public, no authentication required. Clients fetch this to verify access tokens.
  if (keyStore) {
    app.route("/", jwksRoutes(keyStore));
  }

  // Invitation routes — requires database for persistence and outbox event emission.
  if (database) {
    app.route("/", invitationRoutes(database, logger));
    app.route("/", bulkInviteRoutes(database, redis ?? null));
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

  // Account activation (ST-078). Consumes an invitation, provisions the user, links the OAuth
  // identity, and issues the first session token pair in one transaction. Public like the OAuth
  // callbacks (the invitation token is the credential), and needs a database plus a key store to mint
  // that first token pair.
  if (database && keyStore) {
    const sessionTokenConfig = {
      keyStore,
      issuer: jwtIssuer,
      audience: jwtAudience,
      accessTtlSeconds: jwtAccessTtlSeconds,
      refreshTtlSeconds: jwtRefreshTtlSeconds,
    };
    app.route(
      "/",
      activationRoutes(
        database,
        sessionTokenConfig,
        logger,
        microsoftIdentityVerifier ? { verifyMicrosoftIdentity: microsoftIdentityVerifier } : {},
      ),
    );
    // Browser-redirect arm of the same flow: /start + /invitation/callback give an invited user the
    // full-page OAuth round trip and run activation server-side (see activation-oauth-routes.ts).
    app.route("/", activationOAuthRoutes(database, sessionTokenConfig, logger));
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

  // In-app notification inbox (ST-142). The authenticated user's own notifications: keyset-paginated
  // list, unread count, and mark-read/mark-all-read. No permission or channel guard — RLS fences
  // every row to its owner, so no role can reach anyone else's inbox, and mark-read must work from
  // mobile. Read-state mutations return the new unread count and raise notification.read /
  // notification.allRead outbox events for cross-device badge sync.
  if (database) {
    app.route("/", notificationRoutes(database));
  }

  // Notification preferences (ST-143). The authenticated user's own per-type, per-channel toggles,
  // digest mode on eligible types, and personal attendance-alert threshold. Self-service on the
  // caller's own rows for the same RLS reason as the inbox routes above; mandatory types and digest
  // eligibility are rejected with 422 here and rejected again by CHECK constraints in the database
  // (migration 000083), so the rule holds regardless of caller.
  if (database) {
    app.route("/", notificationPreferencesRoutes(database));
  }

  // Student profiles (CRUD). Demographics, guardians, and admission data with finance-visible
  // field projection and role-based view scoping. Gated on STUDENT_* permissions.
  if (database) {
    app.route("/", studentRoutes(database));
    app.route("/", familyRoutes(database));
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

  // Room directory (read-only). Rooms are provisioned during school setup; this only exposes the
  // list so the timetable builder can resolve names and offer a picker (ST-191).
  if (database) {
    app.route("/", roomRoutes(database));
  }

  // Timetable builder: draft version management, slot CRUD with teacher/room conflict
  // detection, approval workflow, and copy-from-previous-term.
  if (database) {
    app.route("/", timetableRoutes(database));
  }

  // Assignments (ST-103). Teacher CRUD scoped to the classes they teach, a student view scoped to
  // active enrolments, and file attachments served as short-lived pre-signed URLs. Gated on
  // ASSIGNMENT_* permissions per method; `storage` may be null, in which case the attachment
  // endpoints answer 503 and download URLs come back null.
  if (database) {
    app.route("/", assignmentRoutes(database, storage));
  }

  // Submissions (ST-104). Student hand-in with atomic resubmission and database-derived late
  // flagging, teacher grading with a draft/publish split, and attachments the owning student
  // controls. Gated on SUBMISSION_* permissions per method; `storage` is nullable on the same
  // terms as the assignments module above.
  if (database) {
    app.route("/", submissionRoutes(database, storage));
  }

  // Exam scheduling: CRUD with timetable conflict warnings, gradebook weight linkage,
  // and student/parent visibility via RLS.
  if (database) {
    app.route("/", examRoutes(database));
  }

  // Gradebook configuration (ST-112). Weighted assessment categories per gradebook and
  // versioned grading schemes per term. Gated on GRADE_READ/GRADE_UPDATE permissions
  // and class-level teacher authorization.
  if (database) {
    app.route("/", gradebookConfigRoutes(database));
  }

  // Grade entry (ST-113). Teacher draft grade entry with bulk cell updates, max_score
  // validation, updated_at concurrency guard, and submission status transitions. Gated on
  // GRADE_READ / GRADE_UPDATE permissions and class-level teacher authorization.
  if (database) {
    app.route("/", gradeEntryRoutes(database, redis ?? null));
  }

  // Published grades (ST-116). Student/parent-only snapshots with explicit relationship
  // authorization, synchronous term summaries, and optional Redis cache-aside reads.
  if (database) {
    app.route("/", publishedGradeRoutes(database, redis ?? null, logger));
  }

  // Approval queue — unified pending-approvals feed for administrators. Queries grade
  // submissions (status = submitted) and timetable versions (status = pending) into a single
  // list with type-specific diff payloads. Bulk decision delegates to the existing grade and
  // timetable decision functions with per-item partial-failure reporting. Gated on
  // APPROVAL_REVIEW permission (ORG_ADMIN+).
  if (database) {
    app.route("/", approvalQueueRoutes(database));
  }

  // Attendance sessions (ST-107). Idempotent session management per class period with
  // batch record-keeping. Gated on ATTENDANCE_RECORD_CREATE permission.
  if (database) {
    app.route("/", attendanceSessionRoutes(database, redis ?? null));
  }

  // Attendance corrections (ST-109). Amends submitted records into an immutable version chain and
  // exposes that chain. Gated on ATTENDANCE_RECORD_CORRECT / ATTENDANCE_RECORD_READ, with
  // ATTENDANCE_CORRECTION_OVERRIDE deciding whether a caller may correct past the school's window.
  if (database) {
    app.route("/", attendanceCorrectionRoutes(database, redis ?? null));
    app.route(
      "/",
      attendanceReportRoutes(database, readDatabase ?? database, redis ?? null, storage),
    );
    app.route("/", childComparisonRoutes(database, readDatabase ?? database));
  }

  // Audit explorer (ST-046x). Paged, filterable reads of the school's audit log plus an async CSV
  // export job, all gated on AUDIT_LOG_READ / AUDIT_LOG_EXPORT. Each paged read writes its own
  // 'read' audit row (target_table 'audit_logs') inside the same transaction.
  if (database) {
    app.route("/", auditRoutes(database, redis ?? null, storage));
  }

  // Announcement management (ST-194). Compose/publish admin- and role/class-targeted notices, with
  // scheduled publishing (apps/workers/src/queues/announcements' sweep claims due rows) and history
  // reach stats off app.announcement_recipients. Gated on NOTIFICATION_MANAGE.
  if (database) {
    app.route("/", announcementRoutes(database));
  }

  // Discipline incidents and actions: teacher reporting, principal management (actions,
  // resolution, severity), and parent visibility of own child's resolved incidents per
  // school policy flag. All mutations are audited.
  if (database) {
    app.route("/", disciplineRoutes(database));
  }

  // Teacher evaluations: principal evaluation cycles with criteria templates, scoring,
  // narrative, and share-with-teacher toggle. Principal-only mutations, teacher read
  // access to shared evaluations. All mutations are audited.
  if (database) {
    app.route("/", evaluationRoutes(database));
  }

  // Learning materials: CRUD, pre-signed upload flow, AI visibility toggle.
  // Storage client is optional — upload endpoints return 503 when unconfigured. Redis is optional
  // the same way: when absent, confirm still flips the material to 'scanning' but no scan job is
  // enqueued.
  if (database) {
    app.route("/", materialRoutes(database, storage, redis ?? null));
  }

  // Generic object storage gateway (SAD §22). Content-class-gated pre-signed upload + confirm,
  // reusing the temp/ -> permanent/ scheme the assignments/submissions/materials flows use, plus a
  // pre-signed download leg (5-minute URLs) whose row-scope check is a tenant-scoped query under
  // RLS. The upload endpoints are database-free, so they mount regardless of the database guard;
  // `storage` is nullable and the endpoints answer 503 when it is absent. The download route is
  // registered only when a database is present, since it cannot verify row scope without one.
  // Authorization is per content class, asserted in the handler via requirePermissionIn() (or
  // hasPermission() where a class's permission is any-of).
  app.route("/", storageRoutes(storage, database));

  // Tenant provisioning status & manual trigger (ST-089). Authenticated and admin-scoped.
  // Provides read access to provisioning status and manual provisioning trigger.
  if (database) {
    app.route("/", provisioningRoutes(database, logger));
  }

  // Stripe subscription billing. Routes register even without a provider so the OpenAPI contract
  // is stable; they answer 503 at request time when the provider is absent.
  if (database) {
    app.route("/", planRoutes(database));
    app.route("/", checkoutRoutes(database, stripeProvider));
    app.route("/", schoolCheckoutRoutes(database, stripeProvider));
    app.route("/", aiCheckoutRoutes(database, stripeProvider));
    // The event sink is threaded in so a rejected webhook signature rides the same ST-082 alerting
    // path as a CSRF or rate-limit rejection, rather than a second one invented for billing.
    app.route("/", webhookRoutes(database, stripeProvider, logger, { eventSink, redis }));
    app.route("/", adminSubscriptionRoutes(database, stripeProvider, logger));
    // School billing portal (ST-137): current plan/seats/cancellation overview, invoices read
    // through to the provider, and end-of-period cancellation. The payment-method portal session
    // link already exists at POST /api/subscriptions/portal (checkoutRoutes above).
    app.route("/", billingOverviewRoutes(database));
    app.route("/", invoiceRoutes(database, stripeProvider));
    app.route("/", cancellationRoutes(database, stripeProvider));
  }

  // AI entitlement & quota gate (ST-155). Mounted only when both a database (to resolve
  // entitlements) and Redis (to meter the monthly token budget) are present. The gate deliberately
  // does not fail open like rate limiting: an admitted request it could not meter would spend
  // unbilled budget, so the whole surface is absent rather than un-metered. Routes under /api/ai/*
  // that predate this gate are likewise absent until both dependencies exist.
  if (database && redis && entitlements) {
    const aiMeter = createAiTokenMeter({ redis });
    app.use(
      "/api/ai/*",
      aiEntitlementGate({
        entitlements,
        meter: aiMeter,
        // The LLM gateway (ST-164) can generate up to 16,384 output tokens, which no default-size
        // hold can cover, so the generate path resolves the worst-case hold (AI_LLM_MAX_RESERVE_TOKENS).
        // The ask path (ST-165) bounds its grounded prompt with AI_ASK_SOURCE_LIMIT × the chunk text
        // cap plus the question, so it is held at the same worst case — see config.ts. The summarize
        // path (the material-summarizer) likewise feeds an open-ended generation and is held at the
        // same worst case — its input is bounded (AI_SUMMARY_CHUNK_LIMIT × chunk cap), but its output
        // ceiling still exceeds any default-size hold, and a summary that raced its reservation would
        // trip the meter's out-of-range guard. Key-concept extraction (ST-169) is held at the same
        // worst case for the same reason -- see config.ts's AI_CONCEPTS_* reservation math -- it
        // reuses the summary loader's input budget and caps its JSON output. Quiz generation (ST-167)
        // is held at the same worst case for the same reason -- see config.ts's AI_QUIZ_* reservation
        // math -- but only the generate path (POST .../quizzes); grading (POST .../quizzes/{quizId}/grade)
        // makes no LLM call and stays on the default hold. Flashcard deck generation (ST-168) is held
        // at the same worst case for the same reason -- see config.ts's AI_FLASHCARD_* reservation
        // math -- but only the generate path (POST .../decks); the review paths (GET/POST
        // .../decks/{deckId}/review) make no LLM call and stay on the default hold. Simplified
        // explanations (ST-170) are held at the same worst case for the same reason -- their single
        // passage is bounded (AI_EXPLAIN_MAX_INPUT_CHARS), but the open-ended rewrite's output
        // ceiling still exceeds any default-size hold. Exam mode (ST-171) is different in kind, not
        // degree: create (POST .../exams) does not call the model itself -- generation runs in a
        // worker -- so there is no post-hoc usage to meter. It commits AI_EXAM_MAX_RESERVE_TOKENS in
        // full at create time instead (see config.ts and docs/rag/exam-mode.md), a larger ceiling
        // than every synchronous surface's shared AI_LLM_MAX_RESERVE_TOKENS because its scope (up to
        // AI_EXAM_MAX_MATERIALS materials, AI_EXAM_MAX_QUESTIONS items) is deliberately bigger than a
        // single quiz's. get/start/submit (.../exams/{examId}[/start|/submit]) make no LLM call and
        // stay on the default hold, the same posture quiz grading takes.
        resolveReserveTokens: (c) => {
          if (c.req.path.endsWith("/exams")) return AI_EXAM_MAX_RESERVE_TOKENS;
          return c.req.path.endsWith("/generate") ||
            c.req.path.endsWith("/ask") ||
            c.req.path.endsWith("/summarize") ||
            c.req.path.endsWith("/concepts") ||
            c.req.path.endsWith("/explain") ||
            c.req.path.endsWith("/quizzes") ||
            c.req.path.endsWith("/decks")
            ? AI_LLM_MAX_RESERVE_TOKENS
            : undefined;
        },
      }),
    );
    app.route("/", aiUsageRoutes({ entitlements, meter: aiMeter }));
    // Hybrid retrieval (ST-162). Mounted under the same gate so a search reserves and commits the
    // caller's AI quota, and only when the gate's dependencies (a database for entitlements, Redis
    // for the meter) exist — the retrieval surface must never run un-metered. Cross-encoder
    // re-ranking (ST-163) rides the AI_RERANK_ENABLED kill switch: off, the route returns the raw
    // RRF ranking; on, the deterministic re-ranker is constructed here and swapped in at the one
    // place the route depends on.
    app.route(
      "/",
      aiRetrievalRoutes({
        database,
        embedder: createDeterministicQueryEmbedder(),
        reranker: aiRerankEnabled ? createDeterministicCrossEncoderReranker() : null,
      }),
    );
    // LLM gateway (ST-164). Mounted under the same gate so a generation reserves and commits the
    // caller's AI quota, and only when the gate's dependencies exist — the generate surface must
    // never run un-metered. The provider may be null (AI_LLM_ENABLED off): the route still
    // registers and answers 503 AI_LLM_DISABLED at request time.
    app.route(
      "/",
      aiGatewayRoutes({
        database,
        provider: aiLlmProvider,
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Ask AI streaming (ST-165). Mounted under the same gate so a grounded answer reserves and
    // commits the caller's AI quota, and only when the gate's dependencies exist — the ask surface
    // must never run un-metered. The provider may be null on the same kill-switch terms as the
    // gateway: the route still registers and answers 503 AI_LLM_DISABLED at request time.
    app.route(
      "/",
      aiAskRoutes({
        database,
        provider: aiLlmProvider,
        embedder: createDeterministicQueryEmbedder(),
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Study-material summarizer. Mounted under the same gate so a generated summary reserves and
    // commits the caller's AI quota, and only when the gate's dependencies exist — the summarize
    // surface must never run un-metered. The provider may be null on the same kill-switch terms as
    // the gateway. A Redis-backed cache (createSummaryCache, sharing the gate's redis client)
    // serves repeat summaries of the same material to the same student with a zero-token commit;
    // it is an accelerator — a miss or a Redis error regenerates.
    app.route(
      "/",
      aiSummaryRoutes({
        database,
        provider: aiLlmProvider,
        cache: createSummaryCache(redis),
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Key-concept extraction (ST-169). Mounted under the same gate so a generated concept list
    // reserves and commits the caller's AI quota, and only when the gate's dependencies exist --
    // the concepts surface must never run un-metered. The provider may be null on the same
    // kill-switch terms as the gateway. A Redis-backed cache (createConceptsCache, sharing the
    // gate's redis client) serves repeat concept lists of the same material to the same student
    // with a zero-token commit; it is an accelerator -- a miss or a Redis error regenerates.
    app.route(
      "/",
      aiConceptsRoutes({
        database,
        provider: aiLlmProvider,
        cache: createConceptsCache(redis),
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Simplified explanations (ST-170). Mounted under the same gate so a generated explanation
    // reserves and commits the caller's AI quota, and only when the gate's dependencies exist --
    // the explain surface must never run un-metered. The provider may be null on the same
    // kill-switch terms as the gateway. Explanations are deliberately not cached: a paraphrase is
    // only as useful as it is freshly faithful to one student's retrieval.
    app.route(
      "/",
      aiExplainRoutes({
        database,
        provider: aiLlmProvider,
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Quiz generation and grading (ST-167). Mounted under the same gate so a generated quiz reserves
    // and commits the caller's AI quota, and only when the gate's dependencies exist -- generation
    // must never run un-metered. The provider may be null on the same kill-switch terms as the
    // gateway; grading makes no provider call at all and is unaffected by the kill switch.
    app.route(
      "/",
      aiQuizRoutes({
        database,
        provider: aiLlmProvider,
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Flashcard deck generation and spaced-repetition reviews (ST-168). Mounted under the same gate
    // so a generated deck reserves and commits the caller's AI quota, and only when the gate's
    // dependencies exist -- generation must never run un-metered. The provider may be null on the
    // same kill-switch terms as the gateway; the review paths make no provider call at all and are
    // unaffected by the kill switch.
    app.route(
      "/",
      aiFlashcardRoutes({
        database,
        provider: aiLlmProvider,
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Exam mode (ST-171). Mounted under the same gate so create reserves and commits the caller's
    // AI quota, and only when the gate's dependencies exist -- generation must never run
    // un-metered. Unlike every other AI surface here, this route does not take `provider`: it never
    // calls the model itself, only enqueues onto QUEUE_NAMES.AI_EXAM_GENERATION for
    // apps/workers/src/queues/exam-generation to consume -- `redis` backs that queue's producer, on
    // the same terms every other BullMQ producer in this app is constructed inside its own route
    // factory (see finance/reports/routes.ts).
    app.route(
      "/",
      aiExamRoutes({
        database,
        redis,
        modelOverrides: aiLlmModelOverrides,
      }),
    );
    // Answer report route. Students flag AI answers for teacher review. No LLM call, no quota
    // spend — the route only writes to app.ai_answer_reports.
    app.route("/", aiReportRoutes({ database }));
    // AI metrics dashboard (ST-155). Cross-tenant per-tenant usage and cost metrics for the
    // platform team. SUPER_ADMIN only, no quota consumption — the route reads the durable ledger
    // via withSystemTx (same cross-tenant mechanism as the webhook processor). Mounted outside
    // the gate's quota reservation via the reserveQuota skip in entitlement-gate.ts.
    app.route("/", aiMetricsRoutes({ database }));
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
