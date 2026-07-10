import { z } from "zod";

/**
 * Environment configuration for the realtime gateway. Parsed and validated once at bootstrap so
 * that an invalid environment fails fast — before the server binds a port or opens a Redis
 * connection — with a named, readable error.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().min(1).default("0.0.0.0"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  /**
   * Shared HMAC secret for the JWT handshake stub (see src/auth.ts). This is a placeholder for
   * the real identity provider — it defaults to a well-known value so `bun run dev` works without
   * extra setup, but production deployments must override it.
   */
  WS_JWT_SECRET: z.string().min(1).default("dev-insecure-secret-change-me"),
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
