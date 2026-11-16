import { keyringHoldsDevelopmentKey, parseRecordKeyring } from "@studafy/records";
import { z } from "zod";

/**
 * An empty environment variable is an unset one: it is present only because a deployment template
 * always injects the key. Same helper as apps/api/src/env.ts.
 */
function emptyAsUnset(value: unknown): unknown {
  return value === "" ? undefined : value;
}

/**
 * Environment configuration for the workers process. Parsed and validated once at bootstrap so
 * that an invalid environment fails fast — before any Redis connection is opened — with a named,
 * readable error.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    SERVICE_NAME: z.string().min(1).default("workers"),
    // Names the running build for error monitoring; see apps/api/src/env.ts's own RELEASE_VERSION.
    // Deployments set it from IMAGE_TAG.
    RELEASE_VERSION: z.string().min(1).default("unknown"),
    // Sentry error monitoring: see apps/api/src/env.ts's own SENTRY_DSN/SENTRY_ENVIRONMENT. Empty is
    // unset, since the task definition always injects the key from the tier's env file.
    SENTRY_DSN: z.preprocess(emptyAsUnset, z.string().url().optional()),
    SENTRY_ENVIRONMENT: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // apps/workers has no HTTP surface of its own (infra/docker/README.md), so unlike api/realtime
    // this is not "a separate port from PORT" — it is the *only* port this process listens on, and
    // it exists solely for @studafy/observability's Prometheus-format /metrics endpoint (ST-259).
    // 9464 is Prometheus's own registered default port.
    METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
    // Distributed tracing (ST-260): see apps/api/src/env.ts's own OTEL_EXPORTER_OTLP_ENDPOINT for
    // what this is, why it's optional, and why an empty string is also accepted.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal("")),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    DATABASE_URL: z.string().min(1).default("postgres://localhost:5432/studafy"),
    // Production supplies the database as discrete parts rather than a URL: the ECS task definition
    // takes host/port/name from the PgBouncer template and user/password from Secrets Manager, which
    // cannot be concatenated into a URL there. Optional, because local development and tests set
    // DATABASE_URL instead. See databaseUrlFrom().
    DATABASE_HOST: z.string().min(1).optional(),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    DATABASE_NAME: z.string().min(1).optional(),
    DATABASE_USER: z.string().min(1).optional(),
    DATABASE_PASSWORD: z.string().optional(),
    DATABASE_CA_CERT: z.string().min(1).optional(),
    // verify-full: TLS with certificate verification on every pool (databaseUrlFrom), for a
    // database reached over the internet. Unset keeps the plain connection a private PgBouncer used.
    DATABASE_SSL_MODE: z.preprocess(emptyAsUnset, z.enum(["verify-full"]).optional()),
    READ_DATABASE_URL: z.string().min(1).optional(),
    READ_DATABASE_HOST: z.string().min(1).optional(),
    READ_DATABASE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    READ_DATABASE_NAME: z.string().min(1).optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_APP_FILES_BUCKET: z.string().min(1).optional(),
    SCHOOL_IDS: z.string().min(1).default(""),
    // ERPNext integration — required for billing queue. Both must be set together.
    ERPNEXT_API_URL: z.preprocess(emptyAsUnset, z.string().url().optional()),
    ERPNEXT_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // Daily finance reconciliation (queues/billing/finance-reconciliation.ts): apps/api's base URL
    // and the service key its POST /api/finance/reconciliation/run checks. Unset key = no ERPNext
    // integration to reconcile, a logged skip.
    API_BASE_URL: z.preprocess(emptyAsUnset, z.string().url().optional()),
    RECONCILIATION_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // Stripe (ST-136), optional: schools in Tap's markets (Jordan, the Gulf, Egypt) are billed
    // through Tap, so a deployment serving only them has no Stripe account at all. Seat
    // reconciliation still never stops silently -- without a key it fails loudly the moment any
    // active subscription is billed through Stripe (queues/billing/worker.ts).
    // The records keyring (ADR-019; see apps/api/src/env.ts). The import worker seals sensitive
    // template columns with it. Production requires a real one; elsewhere the development key.
    RECORDS_ENCRYPTION_KEYS: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    RECORDS_ENCRYPTION_CURRENT_KEY_ID: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    STRIPE_SECRET_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // Google Play Developer API, optional: lets the account-deletion sweep turn off renewal of a
    // deleted student's AI add-on bought through Google Play (stripe-ai-billing-canceller.ts's Play
    // counterpart). The same package name and service account as apps/api/src/env.ts; set together.
    // Unset, the sweep logs and skips the call -- the person was told to cancel in the store.
    GOOGLE_PLAY_PACKAGE_NAME: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    GOOGLE_PLAY_SERVICE_ACCOUNT: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // Transactional email through Resend (deliverability R-08). When RESEND_API_KEY is unset the
    // email dispatcher runs in dry-run mode: it renders, dedups, and records deliveries exactly as in
    // production but never calls Resend — the dev/test path. A production worker refuses to boot that
    // way unless EMAIL_DRY_RUN=true says so on purpose, so a missing key can never silently stop every
    // invitation and password email. EMAIL_FROM_ADDRESS must be on a domain verified in Resend;
    // bounces and complaints reach the API's /email/webhooks/resend.
    RESEND_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    EMAIL_FROM_ADDRESS: z.preprocess(
      emptyAsUnset,
      z.string().email().default("no-reply@send.studafy.com"),
    ),
    EMAIL_FROM_NAME: z.preprocess(emptyAsUnset, z.string().min(1).default("Studafy")),
    EMAIL_DRY_RUN: z.preprocess(
      emptyAsUnset,
      z
        .enum(["true", "false"])
        .optional()
        .transform((value) => value === "true"),
    ),
    // FCM push notifications (ST-139). A Google service-account JSON string. When unset the push
    // channel runs in dry-run mode: it resolves devices, applies the per-user cap and advances
    // dispatch logs exactly as in production but never calls FCM — the dev/test path. A production
    // worker refuses to boot that way unless PUSH_DRY_RUN=true says so on purpose, the same rule as
    // EMAIL_DRY_RUN. Empty means unset: the task definition always injects the secret's key.
    FIREBASE_SERVICE_ACCOUNT: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    PUSH_DRY_RUN: z.preprocess(
      emptyAsUnset,
      z
        .enum(["true", "false"])
        .optional()
        .transform((value) => value === "true"),
    ),
    // Malware scanning (file-scan queue). CLAMAV_HOST is optional in dev/test so the queue still
    // boots and scans fail closed at job time; the production validation below makes it mandatory:
    // silently serving un-scanned files is worse than a failed deploy. CLAMAV_PORT/CLAMAV_TIMEOUT_MS/CLAMAV_MAX_FILE_BYTES mirror clamd's ListenPort,
    // timeout and StreamMaxLength defaults.
    CLAMAV_HOST: z.string().min(1).optional(),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    CLAMAV_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    // Base URL for the action links embedded in emails: the web app's public origin. Every link
    // must open a web page (email/resolve.ts); the API is on a separate host on Fly, so an
    // `/api/...` path here would land on the web app's 404 page.
    FRONTEND_URL: z.string().url().default("http://localhost:5180"),
    // Email dispatcher tunables. See queues/notifications/email/dispatcher.ts for how they bound
    // the polling loop.
    // Resend's default API limit is 2 requests/second per team; a 429 is retried, but pacing under
    // the limit keeps a burst (a digest run) from spending its cycles on rejected requests.
    EMAIL_MAX_RATE_PER_SECOND: z.coerce.number().positive().default(2),
    EMAIL_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
    EMAIL_BATCH_SIZE: z.coerce.number().int().positive().default(25),
    // ST-133. 500ms rather than the email dispatcher's 1s: this consumer carries the <5s entitlement
    // propagation SLA, and the poll interval is the dominant term in that budget.
    ENTITLEMENT_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(500),
    ENTITLEMENT_BATCH_SIZE: z.coerce.number().int().positive().default(100),
    // OCR (ai-ingestion). OCR_LOW_CONFIDENCE_THRESHOLD is the mean per-word confidence below which an
    // OCR'd page is flagged for the teacher; default matches the engine's own. OCR_WORKER_PATH and
    // OCR_LANG_PATH point at the bundled tesseract worker-script, its WASM cores, and the
    // `<language>.traineddata` files in the production image (which has no node_modules); unset in
    // dev/test, where the engine defaults resolve tesseract.js's own worker and the checked-in
    // traineddata next to this source file.
    OCR_LOW_CONFIDENCE_THRESHOLD: z.coerce.number().int().min(0).max(100).default(60),
    OCR_WORKER_PATH: z.string().min(1).optional(),
    OCR_LANG_PATH: z.string().min(1).optional(),
    // Per-tenant ingestion concurrency cap (ST-161). BullMQ's queue `concurrency` bounds jobs per
    // worker process; this bounds jobs per school across the whole fleet, via the Redis semaphore
    // in queues/ai-ingestion/semaphore.ts. A school is a cluster-wide resource (embedding spend is
    // metered per material), so one over-subscribed school must not swamp the shared queue.
    INGESTION_MAX_CONCURRENCY_PER_SCHOOL: z.coerce.number().int().min(1).default(2),
    // Exam-mode item-bank generation (ST-171). Same names as apps/api/src/env.ts's ANTHROPIC_*
    // vars -- both processes call the same provider with the same credential. Optional: unlike
    // malware scanning, an unconfigured key does not risk silent data corruption, it fails the
    // specific generation job closed (app.exam_sessions marked 'failed' with a clear reason) the
    // same way a missing CLAMAV_HOST fails a scan job closed, just without CLAMAV_HOST's
    // production-required check -- there is no safety property at stake in leaving this feature off.
    // Empty counts as unset: the deployment template always injects these keys.
    ANTHROPIC_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    ANTHROPIC_BASE_URL: z.preprocess(emptyAsUnset, z.string().url().optional()),
    // AI_LLM_PROVIDER=openai-compatible (Together AI and the like) uses AI_LLM_API_KEY and
    // AI_LLM_BASE_URL instead -- the same variables, and the same provider, as apps/api.
    AI_LLM_PROVIDER: z.preprocess(
      emptyAsUnset,
      z.enum(["anthropic", "openai-compatible"]).default("anthropic"),
    ),
    AI_LLM_API_KEY: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    AI_LLM_BASE_URL: z.preprocess(emptyAsUnset, z.string().url().optional()),
  })
  .superRefine((env, context) => {
    if (
      (env.RECORDS_ENCRYPTION_KEYS === undefined) !==
      (env.RECORDS_ENCRYPTION_CURRENT_KEY_ID === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["RECORDS_ENCRYPTION_KEYS"],
        message:
          "RECORDS_ENCRYPTION_KEYS and RECORDS_ENCRYPTION_CURRENT_KEY_ID must be set together",
      });
    } else if (env.RECORDS_ENCRYPTION_KEYS !== undefined) {
      try {
        const keyring = parseRecordKeyring(
          env.RECORDS_ENCRYPTION_KEYS,
          env.RECORDS_ENCRYPTION_CURRENT_KEY_ID!,
        );
        if (env.NODE_ENV === "production" && keyringHoldsDevelopmentKey(keyring)) {
          context.addIssue({
            code: "custom",
            path: ["RECORDS_ENCRYPTION_KEYS"],
            message: "RECORDS_ENCRYPTION_KEYS must not hold the development key in production",
          });
        }
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["RECORDS_ENCRYPTION_KEYS"],
          message: (error as Error).message,
        });
      }
    }

    if (
      (env.GOOGLE_PLAY_PACKAGE_NAME === undefined) !==
      (env.GOOGLE_PLAY_SERVICE_ACCOUNT === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_PLAY_SERVICE_ACCOUNT"],
        message: "GOOGLE_PLAY_PACKAGE_NAME and GOOGLE_PLAY_SERVICE_ACCOUNT must be set together",
      });
    } else if (env.GOOGLE_PLAY_SERVICE_ACCOUNT !== undefined) {
      try {
        JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["GOOGLE_PLAY_SERVICE_ACCOUNT"],
          message: "GOOGLE_PLAY_SERVICE_ACCOUNT must be the service account's JSON key",
        });
      }
    }

    if (env.NODE_ENV !== "production") return;

    if (env.RECORDS_ENCRYPTION_KEYS === undefined) {
      context.addIssue({
        code: "custom",
        path: ["RECORDS_ENCRYPTION_KEYS"],
        message: "RECORDS_ENCRYPTION_KEYS is required in production",
      });
    }
    if ((env.ERPNEXT_API_URL === undefined) !== (env.ERPNEXT_API_KEY === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["ERPNEXT_API_URL"],
        message: "ERPNEXT_API_URL and ERPNEXT_API_KEY must be set together",
      });
    }

    if (env.RESEND_API_KEY === undefined && !env.EMAIL_DRY_RUN) {
      context.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message:
          "RESEND_API_KEY is required in production (set EMAIL_DRY_RUN=true to run without sending on purpose)",
      });
    }

    if (env.FIREBASE_SERVICE_ACCOUNT === undefined && !env.PUSH_DRY_RUN) {
      context.addIssue({
        code: "custom",
        path: ["FIREBASE_SERVICE_ACCOUNT"],
        message:
          "FIREBASE_SERVICE_ACCOUNT is required in production (set PUSH_DRY_RUN=true to run without sending on purpose)",
      });
    }

    // Malware scanning is a hard fail-closed gate: without a ClamAV host a deployed worker could
    // confirm materials and never scan them. Fail fast at bootstrap rather than let files sit in
    // 'scanning' or, worse, appear to complete without a verdict.
    if (env.CLAMAV_HOST === undefined) {
      context.addIssue({
        code: "custom",
        path: ["CLAMAV_HOST"],
        message: "CLAMAV_HOST is required in production",
      });
    }

    for (const [name, value] of [
      ["READ_DATABASE_HOST", env.READ_DATABASE_HOST],
      ["READ_DATABASE_NAME", env.READ_DATABASE_NAME],
    ] as const) {
      if (value === undefined) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name} is required in production`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * The connection string to use, whichever way the environment expressed it.
 *
 * Discrete DATABASE_HOST/USER/PASSWORD win over DATABASE_URL when present, because they are what
 * production sets and DATABASE_URL still carries its local-development default — preferring the
 * URL would silently point a deployed worker at localhost.
 *
 * The password is URL-encoded: Secrets Manager generates passwords containing characters that are
 * structural in a URI (`@`, `/`, `:`), and one of those would otherwise truncate the host.
 *
 * DATABASE_SSL_MODE=verify-full is carried in the URL (`sslmode`), so every pool built from it
 * verifies the server certificate, against the system store plus NODE_EXTRA_CA_CERTS.
 */
export function databaseUrlFrom(env: Env): string {
  if (env.DATABASE_HOST === undefined || env.DATABASE_USER === undefined) {
    return env.DATABASE_URL;
  }

  const port = env.DATABASE_PORT ?? 5432;
  const name = env.DATABASE_NAME ?? "postgres";
  const password = env.DATABASE_PASSWORD ?? "";
  const credentials = `${encodeURIComponent(env.DATABASE_USER)}:${encodeURIComponent(password)}`;

  return `postgresql://${credentials}@${env.DATABASE_HOST}:${port}/${name}${sslQuery(env)}`;
}

export function readDatabaseUrlFrom(env: Env): string {
  if (env.READ_DATABASE_HOST === undefined) {
    return env.READ_DATABASE_URL ?? databaseUrlFrom(env);
  }
  const port = env.READ_DATABASE_PORT ?? env.DATABASE_PORT ?? 6432;
  const name = env.READ_DATABASE_NAME ?? env.DATABASE_NAME ?? "api_read";
  const username = env.DATABASE_USER ?? "";
  const password = env.DATABASE_PASSWORD ?? "";
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${env.READ_DATABASE_HOST}:${port}/${name}${sslQuery(env)}`;
}

function sslQuery(env: Env): string {
  return env.DATABASE_SSL_MODE === "verify-full" ? "?sslmode=verify-full" : "";
}

/**
 * Thrown when environment variables fail validation. The distinct name makes a bootstrap failure
 * unambiguous in logs and in tests.
 */
export class EnvValidationError extends Error {
  constructor(details: string) {
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Parse and validate environment variables. Throws {@link EnvValidationError} on any invalid
 * value; returns a fully typed, defaulted {@link Env} on success.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(z.prettifyError(result.error));
  }
  return result.data;
}
