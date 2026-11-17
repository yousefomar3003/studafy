import { z } from "zod";

import { isBareOrigin, parseOriginList } from "./limits";

/** The development default for WS_JWT_SECRET. Production refuses to boot with it. */
export const DEV_WS_JWT_SECRET = "dev-insecure-secret-change-me";

/** Shortest WS_JWT_SECRET production accepts: 256 bits of HMAC key, as hex or base64 or longer. */
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * An empty environment variable is an unset one: it is present only because a deployment template
 * always injects the key. Same helper as apps/api/src/env.ts.
 */
function emptyAsUnset(value: unknown): unknown {
  return value === "" ? undefined : value;
}

/**
 * Same helper as apps/api/src/env.ts. QA-066: whether a Redis URL keeps its traffic encrypted. `rediss://` is TLS. Plain `redis://` is
 * accepted only for a host on Fly's private network (`*.internal`, `*.flycast`), whose 6PN links are
 * WireGuard tunnels already. Anything else, including a URL that does not parse, is refused.
 */
export function isEncryptedRedisUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "rediss:") return true;
  if (url.protocol !== "redis:") return false;
  const host = url.hostname.toLowerCase();
  return host.endsWith(".internal") || host.endsWith(".flycast");
}

export const PLAINTEXT_REDIS_MESSAGE =
  "must use rediss:// (TLS) in production, unless its host is on Fly's private network (.internal or .flycast)";

/**
 * Environment configuration for the realtime gateway. Parsed and validated once at bootstrap so
 * that an invalid environment fails fast — before the server binds a port or opens a Redis
 * connection — with a named, readable error.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().min(1).default("0.0.0.0"),
    SERVICE_NAME: z.string().min(1).default("realtime"),
    // Names the running build for error monitoring; see apps/api/src/env.ts's own RELEASE_VERSION.
    // Deployments set it from IMAGE_TAG.
    RELEASE_VERSION: z.string().min(1).default("unknown"),
    // Sentry error monitoring: see apps/api/src/env.ts's own SENTRY_DSN/SENTRY_ENVIRONMENT. Empty is
    // unset, since the task definition always injects the key from the tier's env file.
    SENTRY_DSN: z.preprocess(emptyAsUnset, z.string().url().optional()),
    SENTRY_ENVIRONMENT: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // A separate port from PORT, on purpose (ST-259): the Prometheus-format /metrics endpoint
    // (@studafy/observability's startMetricsServer) must never be reachable through the public ALB
    // path PORT is, since it carries no auth of its own — only the monitoring security group can
    // route to it. 9464 is Prometheus's own registered default port. Distinct from this app's own
    // existing GET /metrics (src/health.ts) — the JSON fan-out-counter debug endpoint, unchanged.
    METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
    // QA-072: the address the metrics endpoint binds. Unset means every interface (local runs and
    // tests). On fly.io it is `fly-local-6pn`, the machine's private-network address, which fly's
    // metrics scraper uses; the endpoint has no auth of its own, so it listens nowhere else.
    METRICS_HOST: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    // Distributed tracing (ST-260): see apps/api/src/env.ts's own OTEL_EXPORTER_OTLP_ENDPOINT for
    // what this is, why it's optional, and why an empty string is also accepted.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional().or(z.literal("")),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    /**
     * The Redis database holding the API's auth keys: its access-token denylist, which the gateway
     * reads to close revoked sessions, and the spent-ticket markers it writes (src/session-guard.ts).
     * Deployed tiers point REDIS_URL at the pub/sub database and the API at another, so a gateway
     * reading the denylist through REDIS_URL would find nothing and never revoke anything. Required
     * in production for that reason; defaults to REDIS_URL elsewhere, where there is one database.
     */
    AUTH_REDIS_URL: z.preprocess(emptyAsUnset, z.string().min(1).optional()),
    /**
     * HMAC key for handshake tickets (src/auth.ts, F-05). The API signs with the same value, which
     * both read from Secrets Manager. Defaults to a well-known value so `bun run dev` works without
     * setup; production refuses that value, and anything shorter than 32 characters.
     */
    WS_JWT_SECRET: z.string().min(1).default(DEV_WS_JWT_SECRET),
    /**
     * Comma-separated browser origins allowed to open a socket (F-16), e.g. the web app's origin.
     * A handshake whose `Origin` header is not listed gets 403; one with no `Origin` (non-browser
     * clients) is let through — see src/limits.ts's isOriginAllowed. Required in production; in
     * development an empty list turns the check off so any local web port works.
     */
    WS_ALLOWED_ORIGINS: z.string().optional().transform(parseOriginList),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === "production") {
      if (env.WS_JWT_SECRET === DEV_WS_JWT_SECRET) {
        context.addIssue({
          code: "custom",
          path: ["WS_JWT_SECRET"],
          message: "WS_JWT_SECRET must not be the development default when NODE_ENV is production",
        });
      } else if (env.WS_JWT_SECRET.length < MIN_PRODUCTION_SECRET_LENGTH) {
        context.addIssue({
          code: "custom",
          path: ["WS_JWT_SECRET"],
          message: `WS_JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters when NODE_ENV is production`,
        });
      }
      if (env.AUTH_REDIS_URL === undefined) {
        context.addIssue({
          code: "custom",
          path: ["AUTH_REDIS_URL"],
          message: "AUTH_REDIS_URL is required when NODE_ENV is production",
        });
      }
      // QA-066: the localhost default fails this too, so a deploy cannot forget REDIS_URL either.
      for (const [name, value] of [
        ["REDIS_URL", env.REDIS_URL],
        ["AUTH_REDIS_URL", env.AUTH_REDIS_URL],
      ] as const) {
        if (value !== undefined && !isEncryptedRedisUrl(value)) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name} ${PLAINTEXT_REDIS_MESSAGE}`,
          });
        }
      }
    }
    if (env.NODE_ENV === "production" && env.WS_ALLOWED_ORIGINS.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["WS_ALLOWED_ORIGINS"],
        message: "WS_ALLOWED_ORIGINS is required and must be non-empty when NODE_ENV is production",
      });
    }
    for (const origin of env.WS_ALLOWED_ORIGINS) {
      if (!isBareOrigin(origin)) {
        context.addIssue({
          code: "custom",
          path: ["WS_ALLOWED_ORIGINS"],
          message: `"${origin}" is not a bare origin (expected scheme://host[:port], no path or wildcard)`,
        });
      }
    }
  });

export type Env = z.output<typeof envSchema>;

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
