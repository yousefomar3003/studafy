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
