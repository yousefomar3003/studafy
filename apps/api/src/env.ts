import { z } from "zod";

import { LOG_LEVEL_NAMES } from "./logger";

/**
 * Split a comma-separated origin list into trimmed, non-empty entries.
 *
 * Exported so the security config parses the variable exactly the way the schema validated it —
 * one parser, so a value that passes bootstrap validation cannot be read back differently.
 */
export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * True when the value is a bare origin: scheme, host, optional port, and nothing else.
 *
 * Rejects trailing paths and wildcards. The allowlist is compared by exact match, so an entry
 * carrying a path would never match a real `Origin` header and would sit in the config looking
 * like protection it does not provide.
 */
export function isAbsoluteOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return false;
  if (value.includes("*")) return false;
  // new URL() normalizes a trailing slash in, so compare against the origin it derived rather than
  // the raw string, which may or may not have carried one.
  return value.replace(/\/$/, "") === url.origin;
}

/**
 * Environment configuration for the API. It is parsed and validated once at bootstrap so that an
 * invalid environment fails fast — before the server binds a port — with a named, readable error.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // The deployment tier, which NODE_ENV cannot express: staging runs a production build
    // (NODE_ENV=production) against non-production origins and secrets. Terraform already models
    // the three tiers (infra/terraform/environments/{dev,staging,prod}), so the application needs a
    // matching axis to resolve its CORS allowlist against.
    APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
    // Comma-separated absolute origins permitted by the CORS allowlist. Deliberately data, not a
    // compiled-in table: the previous hardcoded map had already drifted from infra, listing
    // studafy.com/www.studafy.com while prod.tfvars provisions app.studafy.com. Required in
    // staging/production by the refinement below, so a deployed tier cannot fall back to the
    // localhost defaults and quietly accept credentialed cross-origin requests it should not.
    CORS_ALLOWED_ORIGINS: z.string().optional(),
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
    REDIS_URL: z.string().min(1).optional(),
    ERPNEXT_WEBHOOK_SECRET: z.string().min(1).optional(),
  })
  .superRefine((env, context) => {
    // Checked before the NODE_ENV gate below: this constraint keys off the deployment tier, and a
    // staging box may legitimately run with either NODE_ENV.
    if (env.APP_ENV !== "development") {
      const origins = parseOriginList(env.CORS_ALLOWED_ORIGINS);
      if (origins.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["CORS_ALLOWED_ORIGINS"],
          message: `CORS_ALLOWED_ORIGINS is required and must be non-empty when APP_ENV is ${env.APP_ENV}`,
        });
      }

      for (const origin of origins) {
        if (!isAbsoluteOrigin(origin)) {
          context.addIssue({
            code: "custom",
            path: ["CORS_ALLOWED_ORIGINS"],
            message: `"${origin}" is not a bare absolute origin (expected scheme://host[:port], no path and no wildcard)`,
          });
        }
      }
    }

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
