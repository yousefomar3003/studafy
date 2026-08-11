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
    // Analytics are isolated on a dedicated PgBouncer database backed by an RDS read replica.
    // Local development and tests may omit these values and reuse the primary pool.
    READ_DATABASE_HOST: z.string().min(1).optional(),
    READ_DATABASE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    READ_DATABASE_NAME: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    ERPNEXT_WEBHOOK_SECRET: z.string().min(1).optional(),
    // SNS topic ARN for SES email-event webhook ingestion (deliverability R-08). Optional: when
    // absent, the webhook route answers 500 so a misconfigured topic cannot silently pass as secure.
    EMAIL_EVENTS_SNS_TOPIC_ARN: z.string().min(1).optional(),
    // ERPNext integration (ST-089). All optional — activates only when both are set.
    ERPNEXT_API_URL: z.string().url().optional(),
    ERPNEXT_API_KEY: z.string().min(1).optional(),
    // ERPNext site domain for auto-provisioned sites (e.g., "erpnext.studafy.com").
    ERPNEXT_SITE_DOMAIN: z.string().min(1).optional(),
    // JWT access-token signing
    JWT_ISSUER: z.string().min(1).default("studafy"),
    JWT_AUDIENCE: z.string().min(1).default("studafy-api"),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    // Refresh-token lifetime, reapplied in full on every rotation — the window slides forward as
    // long as a session stays in use, and 30 days of inactivity ends it. There is deliberately no
    // absolute cap on a family's total age; see the follow-up noted in
    // docs/architecture/SAD_13_session_model.md.
    JWT_REFRESH_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 24 * 60 * 60),
    JWT_KEY_ROTATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(7 * 24 * 60 * 60 * 1000),
    // Google OAuth (OIDC). All optional — the feature activates only when all three are set.
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
    // Microsoft OAuth (OIDC). All optional — the feature activates only when all three are set.
    MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    MICROSOFT_OAUTH_REDIRECT_URI: z.string().url().optional(),
    // Where to redirect after a successful OAuth callback. Not setting it disables the redirect.
    FRONTEND_URL: z.string().url().optional(),
    // Base URL for the pay-online redirect entry point served on outstanding invoices in the family
    // financial view (ST-127). Optional: when absent, pay_online_url comes back null and the client
    // simply has no redirect target to navigate to.
    PAYMENT_REDIRECT_BASE_URL: z.string().url().optional(),
    // Cloudflare Turnstile secret key for captcha verification on public endpoints.
    // When absent, captcha checks are skipped (development only).
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    // S3-compatible object storage for the app-files bucket (ST-103). All optional and validated
    // as a group below: the feature activates only when the whole set is present, so dev and test
    // boot without object storage and attachment endpoints answer 503 instead of the app failing to
    // start. S3_ENDPOINT is optional even within the group — absent means AWS S3 proper; set it for
    // MinIO or any other S3-compatible provider.
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_APP_FILES_BUCKET: z.string().min(1).optional(),
    // Lifetime of a pre-signed URL. Bounded to the 15–60 minute window ST-103 specifies: short
    // enough that a leaked URL expires before it is useful, long enough to survive a slow upload.
    S3_PRESIGN_TTL_SECONDS: z.coerce.number().int().min(900).max(3600).default(900),
    // Stripe billing integration. All optional — activates only when both are set.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Cross-encoder re-ranking (ST-163) kill switch. Off by default: an unset or "false" value leaves
    // the retrieval route on the raw RRF ranking with zero re-ranking cost. Validated as an explicit
    // two-value string so a typo ("yes") fails bootstrap instead of silently flipping the feature on.
    AI_RERANK_ENABLED: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    // LLM gateway (ST-164) kill switch. Off by default: the generate route registers but answers
    // 503 AI_LLM_DISABLED until a deployment opts in with AI_LLM_ENABLED=true and an API key.
    AI_LLM_ENABLED: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    // Anthropic API key for the LLM gateway. Required by the refinement below when AI_LLM_ENABLED.
    // Treated as a credential: never logged, and error payloads are scrubbed for its literal value.
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Override the Anthropic API endpoint (gateway/proxy). Defaults to https://api.anthropic.com/v1.
    ANTHROPIC_BASE_URL: z.string().url().optional(),
    // Model ids for the small and large routing tiers. Defaults are the catalog ids current when
    // ST-164 shipped (modules/ai/config.ts); see docs/runbooks/anthropic-provider-config.md.
    AI_LLM_SMALL_MODEL: z.string().min(1).optional(),
    AI_LLM_LARGE_MODEL: z.string().min(1).optional(),
    // Server default for max_tokens when a request omits it. Bounded to the route's ceiling so the
    // reservation math in config.ts (AI_LLM_MAX_RESERVE_TOKENS) stays valid.
    AI_LLM_MAX_TOKENS: z.coerce.number().int().min(1).max(16_384).optional(),
    // Whole-call timeout (connect + wait + read). Bounded so a hung provider cannot pin a worker.
    AI_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).optional(),
    // Zero-retention posture: never send the metadata.user_id field the provider retains for abuse
    // monitoring. See docs/runbooks/anthropic-provider-config.md.
    AI_LLM_ZERO_RETENTION: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
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

    // Google OAuth: all three must be present or all absent.
    const googleVars = [
      env.GOOGLE_OAUTH_CLIENT_ID,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      env.GOOGLE_OAUTH_REDIRECT_URI,
    ];
    const googleSetCount = googleVars.filter((v) => v !== undefined).length;
    if (googleSetCount > 0 && googleSetCount < 3) {
      const missing = [
        !env.GOOGLE_OAUTH_CLIENT_ID && "GOOGLE_OAUTH_CLIENT_ID",
        !env.GOOGLE_OAUTH_CLIENT_SECRET && "GOOGLE_OAUTH_CLIENT_SECRET",
        !env.GOOGLE_OAUTH_REDIRECT_URI && "GOOGLE_OAUTH_REDIRECT_URI",
      ]
        .filter(Boolean)
        .join(", ");
      context.addIssue({
        code: "custom",
        path: ["GOOGLE_OAUTH_CLIENT_ID"],
        message: `All Google OAuth variables must be set together. Missing: ${missing}`,
      });
    }

    // Microsoft OAuth: all three must be present or all absent.
    const microsoftVars = [
      env.MICROSOFT_OAUTH_CLIENT_ID,
      env.MICROSOFT_OAUTH_CLIENT_SECRET,
      env.MICROSOFT_OAUTH_REDIRECT_URI,
    ];
    const microsoftSetCount = microsoftVars.filter((v) => v !== undefined).length;
    if (microsoftSetCount > 0 && microsoftSetCount < 3) {
      const missing = [
        !env.MICROSOFT_OAUTH_CLIENT_ID && "MICROSOFT_OAUTH_CLIENT_ID",
        !env.MICROSOFT_OAUTH_CLIENT_SECRET && "MICROSOFT_OAUTH_CLIENT_SECRET",
        !env.MICROSOFT_OAUTH_REDIRECT_URI && "MICROSOFT_OAUTH_REDIRECT_URI",
      ]
        .filter(Boolean)
        .join(", ");
      context.addIssue({
        code: "custom",
        path: ["MICROSOFT_OAUTH_CLIENT_ID"],
        message: `All Microsoft OAuth variables must be set together. Missing: ${missing}`,
      });
    }

    // ERPNext API: both URL and key must be present or both absent.
    if (env.ERPNEXT_API_URL !== undefined && env.ERPNEXT_API_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ERPNEXT_API_KEY"],
        message: "ERPNEXT_API_KEY is required when ERPNEXT_API_URL is set",
      });
    }
    if (env.ERPNEXT_API_KEY !== undefined && env.ERPNEXT_API_URL === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ERPNEXT_API_URL"],
        message: "ERPNEXT_API_URL is required when ERPNEXT_API_KEY is set",
      });
    }

    // LLM gateway: the kill switch is opt-in, but it must never be armed without a credential to
    // call — that would mount a route that only ever answers 503 AI_LLM_DISABLED while claiming to
    // be enabled.
    if (env.AI_LLM_ENABLED && env.ANTHROPIC_API_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when AI_LLM_ENABLED is true",
      });
    }
    if (!env.AI_LLM_ENABLED && env.ANTHROPIC_API_KEY !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is set but AI_LLM_ENABLED is not true",
      });
    }

    // Bucket and region activate storage. Access keys are optional because production uses an ECS
    // task role; when supplied for local S3-compatible storage they must remain a complete pair.
    const storageVars = [
      ["S3_REGION", env.S3_REGION],
      ["S3_APP_FILES_BUCKET", env.S3_APP_FILES_BUCKET],
    ] as const;
    const storageSetCount = storageVars.filter(([, value]) => value !== undefined).length;
    if (storageSetCount > 0 && storageSetCount < storageVars.length) {
      const missing = storageVars
        .filter(([, value]) => value === undefined)
        .map(([key]) => key)
        .join(", ");
      context.addIssue({
        code: "custom",
        path: ["S3_APP_FILES_BUCKET"],
        message: `All object storage variables must be set together. Missing: ${missing}`,
      });
    }
    if ((env.S3_ACCESS_KEY_ID === undefined) !== (env.S3_SECRET_ACCESS_KEY === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["S3_ACCESS_KEY_ID"],
        message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together",
      });
    }

    // Stripe: both SK and webhook secret must be present or both absent.
    if (env.STRIPE_SECRET_KEY !== undefined && env.STRIPE_WEBHOOK_SECRET === undefined) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_WEBHOOK_SECRET"],
        message: "STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set",
      });
    }
    if (env.STRIPE_WEBHOOK_SECRET !== undefined && env.STRIPE_SECRET_KEY === undefined) {
      context.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "STRIPE_SECRET_KEY is required when STRIPE_WEBHOOK_SECRET is set",
      });
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

    if (env.READ_DATABASE_HOST === undefined) {
      context.addIssue({
        code: "custom",
        path: ["READ_DATABASE_HOST"],
        message: "READ_DATABASE_HOST is required in production",
      });
    }
    if (env.READ_DATABASE_NAME === undefined) {
      context.addIssue({
        code: "custom",
        path: ["READ_DATABASE_NAME"],
        message: "READ_DATABASE_NAME is required in production",
      });
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
