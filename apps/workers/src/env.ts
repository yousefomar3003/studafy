import { z } from "zod";

/**
 * Environment configuration for the workers process. Parsed and validated once at bootstrap so
 * that an invalid environment fails fast — before any Redis connection is opened — with a named,
 * readable error.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  DATABASE_URL: z.string().min(1).default("postgres://localhost:5432/studafy"),
  SCHOOL_IDS: z.string().min(1).default(""),
});

export type Env = z.infer<typeof envSchema>;

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
