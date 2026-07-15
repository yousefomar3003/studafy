import { resolve } from "node:path";

import { MigrationConfigError } from "./errors";

import type { SslMode } from "./types";
import type { ConnectionOptions } from "node:tls";

const DISCRETE_KEYS = [
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
] as const;

export interface MigrationConfig {
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl: false | "require" | "verify-full" | ConnectionOptions;
  migrationsDir: string;
  seedsDir: string;
  redactions: string[];
}

function parseSslMode(value: string | undefined): SslMode {
  const mode = value ?? "require";
  if (["disable", "require", "verify-ca", "verify-full"].includes(mode)) {
    return mode as SslMode;
  }
  throw new MigrationConfigError(
    "DATABASE_SSL_MODE must be disable, require, verify-ca, or verify-full",
  );
}

function sslOptions(mode: SslMode, ca: string | undefined): MigrationConfig["ssl"] {
  if (mode === "disable") return false;
  if (mode === "require") return "require";
  if (!ca) throw new MigrationConfigError(`${mode} requires DATABASE_CA_CERT`);
  if (mode === "verify-ca") {
    return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  }
  return { ca, rejectUnauthorized: true };
}

function validateUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MigrationConfigError("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new MigrationConfigError("DATABASE_URL must use the postgres or postgresql scheme");
  }
  if (!url.hostname || !url.username || url.pathname.length <= 1) {
    throw new MigrationConfigError("DATABASE_URL must include host, username, and database name");
  }
  return url;
}

export function loadMigrationConfig(
  env: Record<string, string | undefined> = process.env,
): MigrationConfig {
  const urlValue = env.DATABASE_URL?.trim();
  // DISCRETE_KEYS is a closed, repository-owned allowlist rather than user-controlled property names.
  // eslint-disable-next-line security/detect-object-injection
  const providedDiscrete = DISCRETE_KEYS.filter((key) => env[key] !== undefined);
  if (urlValue && providedDiscrete.length > 0) {
    throw new MigrationConfigError(
      "DATABASE_URL cannot be combined with discrete DATABASE_HOST/PORT/NAME/USER/PASSWORD values",
    );
  }

  const parsedUrl = urlValue ? validateUrl(urlValue) : undefined;
  const mode = parseSslMode(
    env.DATABASE_SSL_MODE ?? parsedUrl?.searchParams.get("sslmode") ?? undefined,
  );
  const common = {
    ssl: sslOptions(mode, env.DATABASE_CA_CERT),
    migrationsDir: resolve(env.MIGRATIONS_DIR ?? resolve(process.cwd(), "db/migrations")),
    seedsDir: resolve(env.SEEDS_DIR ?? resolve(process.cwd(), "db/seeds")),
  };

  if (urlValue) {
    return {
      ...common,
      url: urlValue,
      redactions: [urlValue, parsedUrl?.password ?? ""].filter(Boolean),
    };
  }

  // eslint-disable-next-line security/detect-object-injection
  const missing = DISCRETE_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new MigrationConfigError(
      `DATABASE_URL is not set and these database values are missing: ${missing.join(", ")}`,
    );
  }
  const port = Number(env.DATABASE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MigrationConfigError("DATABASE_PORT must be an integer between 1 and 65535");
  }

  return {
    ...common,
    host: env.DATABASE_HOST,
    port,
    database: env.DATABASE_NAME,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    redactions: [env.DATABASE_PASSWORD ?? ""].filter(Boolean),
  };
}

export function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result),
    value,
  );
}
