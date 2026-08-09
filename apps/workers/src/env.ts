import { z } from "zod";

/**
 * Environment configuration for the workers process. Parsed and validated once at bootstrap so
 * that an invalid environment fails fast — before any Redis connection is opened — with a named,
 * readable error.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
    READ_DATABASE_URL: z.string().min(1).optional(),
    READ_DATABASE_HOST: z.string().min(1).optional(),
    READ_DATABASE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    READ_DATABASE_NAME: z.string().min(1).optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_APP_FILES_BUCKET: z.string().min(1).optional(),
    SCHOOL_IDS: z.string().min(1).default(""),
    // ERPNext integration — required for billing queue. Both must be set together.
    ERPNEXT_API_URL: z.string().url().optional(),
    ERPNEXT_API_KEY: z.string().min(1).optional(),
    // Stripe seat reconciliation (ST-136). Optional because the seat-reconciliation job is not the
    // billing queue's only consumer: when unset, every other billing job still runs, the scheduled
    // reconciliation fails loudly rather than silently skipping, and the env validation below
    // rejects it outright in production — billing must never silently stop reconciling.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    // SES transactional email (deliverability R-08). When SES_REGION is unset the email dispatcher
    // runs in dry-run mode: it renders, dedups, and records deliveries exactly as in production but
    // never calls AWS — the dev/test path, and a loud warning is logged at startup when a deployed
    // worker has no region.
    SES_REGION: z.string().min(1).optional(),
    SES_FROM_ADDRESS: z.string().email().default("invitations@mail.studafy.com"),
    // FCM push notifications (ST-139). A Google service-account JSON string. When unset the push
    // channel runs in dry-run mode: it resolves devices, applies the per-user cap and advances
    // dispatch logs exactly as in production but never calls FCM — the dev/test path, and a loud
    // warning is logged when a deployed worker has no service account.
    FIREBASE_SERVICE_ACCOUNT: z.string().min(1).optional(),
    // Malware scanning (file-scan queue). CLAMAV_HOST is optional in dev/test so the queue still
    // boots and scans fail closed at job time; the production validation below makes it mandatory,
    // the same reasoning as STRIPE_SECRET_KEY — silently serving un-scanned files is worse than a
    // failed deploy. CLAMAV_PORT/CLAMAV_TIMEOUT_MS/CLAMAV_MAX_FILE_BYTES mirror clamd's ListenPort,
    // timeout and StreamMaxLength defaults.
    CLAMAV_HOST: z.string().min(1).optional(),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    CLAMAV_MAX_FILE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(25 * 1024 * 1024),
    // Base URL for the action links embedded in emails. The verify/activate endpoints are the
    // API's (the only surface with an ALB), so the link host is the app's public origin.
    FRONTEND_URL: z.string().url().default("http://localhost:5173"),
    // Email dispatcher tunables. See queues/notifications/email/dispatcher.ts for how they bound
    // the polling loop.
    EMAIL_MAX_RATE_PER_SECOND: z.coerce.number().positive().default(5),
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
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "production") return;
    if ((env.ERPNEXT_API_URL === undefined) !== (env.ERPNEXT_API_KEY === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["ERPNEXT_API_URL"],
        message: "ERPNEXT_API_URL and ERPNEXT_API_KEY must be set together",
      });
    }

    // Seat reconciliation touches Stripe (ST-136). Silently skipping billing is worse than a
    // failed deploy, so a deployed worker without the secret fails fast at bootstrap.
    if (env.STRIPE_SECRET_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "STRIPE_SECRET_KEY is required in production",
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
 */
export function databaseUrlFrom(env: Env): string {
  if (env.DATABASE_HOST === undefined || env.DATABASE_USER === undefined) {
    return env.DATABASE_URL;
  }

  const port = env.DATABASE_PORT ?? 5432;
  const name = env.DATABASE_NAME ?? "postgres";
  const password = env.DATABASE_PASSWORD ?? "";
  const credentials = `${encodeURIComponent(env.DATABASE_USER)}:${encodeURIComponent(password)}`;

  return `postgresql://${credentials}@${env.DATABASE_HOST}:${port}/${name}`;
}

export function readDatabaseUrlFrom(env: Env): string {
  if (env.READ_DATABASE_HOST === undefined) {
    return env.READ_DATABASE_URL ?? databaseUrlFrom(env);
  }
  const port = env.READ_DATABASE_PORT ?? env.DATABASE_PORT ?? 6432;
  const name = env.READ_DATABASE_NAME ?? env.DATABASE_NAME ?? "api_read";
  const username = env.DATABASE_USER ?? "";
  const password = env.DATABASE_PASSWORD ?? "";
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${env.READ_DATABASE_HOST}:${port}/${name}`;
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
