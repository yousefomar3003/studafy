import { z } from "zod";

import { LOG_LEVEL_NAMES } from "./logger";

/**
 * Environment configuration for the API. It is parsed and validated once at bootstrap so that an
 * invalid environment fails fast — before the server binds a port — with a named, readable error.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    // Derived from the logger's own level names, so an added level cannot drift out of the
    // environment contract. The dependency runs one way: env knows the logger, never the reverse.
    LOG_LEVEL: z.enum(LOG_LEVEL_NAMES).default("info"),
    SERVICE_NAME: z.string().min(1).default("api"),
    // Names the running build in every log line. Deliberately absent from the production block
    // below: "unknown" is a diagnosable log value, whereas a container that refuses to boot over a
    // logging field is an outage. Deployments set it from IMAGE_TAG.
    RELEASE_VERSION: z.string().min(1).default("unknown"),
    DATABASE_HOST: z.string().min(1).optional(),
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    DATABASE_NAME: z.string().min(1).optional(),
    DATABASE_USER: z.string().min(1).optional(),
    DATABASE_PASSWORD: z.string().min(1).optional(),
    DATABASE_CA_CERT: z.string().min(1).optional(),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV !== "production") return;

    const requiredDatabaseValues = [
      ["DATABASE_HOST", env.DATABASE_HOST],
      ["DATABASE_PORT", env.DATABASE_PORT],
      ["DATABASE_NAME", env.DATABASE_NAME],
      ["DATABASE_USER", env.DATABASE_USER],
      ["DATABASE_PASSWORD", env.DATABASE_PASSWORD],
      ["DATABASE_CA_CERT", env.DATABASE_CA_CERT],
    ] as const;

    for (const [key, value] of requiredDatabaseValues) {
      if (value === undefined) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required in production`,
        });
      }
    }
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
