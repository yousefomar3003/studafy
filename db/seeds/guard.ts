// Production safeguard for the demo-tenant seed. Seeding writes a large amount of fabricated data as
// studafy_admin, so it must be structurally impossible to run against staging, pre-production, or
// production. The guard is intentionally layered: an explicit environment assertion AND a
// connection-host check, either of which alone terminates the run. It is called first in seed.ts,
// before a single connection is opened.
import type { MigrationConfig } from "../../packages/db/src/config";

export class SeedSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedSafetyError";
  }
}

// Hosts a disposable local/CI PostgreSQL is reachable at. app.school_id-forced RLS and the
// disposable-database test harness (packages/db/tests/helpers.ts) already assume loopback; this is the
// same trust boundary. The docker compose service name and the Docker host alias are included because
// the seed may run from inside a container against the sibling database service.
const LOCAL_HOSTS = new Set<string>([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "postgres",
  "db",
  "database",
  "host.docker.internal",
]);

// Hostname shapes that unambiguously belong to a managed or shared environment. A match here is fatal
// even if SEED_ALLOW_NONLOCAL is set, because these are never a legitimate seed target.
const FORBIDDEN_HOST_PATTERNS: readonly RegExp[] = [
  /rds\.amazonaws\.com$/i,
  /\.rds\./i,
  /(^|[.\-_])prod([.\-_]|$)/i,
  /(^|[.\-_])production([.\-_]|$)/i,
  /(^|[.\-_])staging([.\-_]|$)/i,
  /(^|[.\-_])stage([.\-_]|$)/i,
  /(^|[.\-_])preprod([.\-_]|$)/i,
  /(^|[.\-_])pre-prod([.\-_]|$)/i,
];

export interface GuardEnv {
  readonly NODE_ENV?: string;
  readonly APP_ENV?: string;
  // Escape hatch for the rare case of seeding a non-loopback but still disposable database (e.g. a
  // remote CI service container addressed by DNS name). Never bypasses the environment assertion or the
  // forbidden-host patterns above.
  readonly SEED_ALLOW_NONLOCAL?: string;
}

// The connection host, stripped of IPv6 brackets and lower-cased. Parses the URL form or reads the
// discrete DATABASE_HOST form; both are produced by loadMigrationConfig.
export function resolveHost(config: MigrationConfig): string {
  const raw = config.url ? new URL(config.url).hostname : config.host;
  if (!raw) {
    throw new SeedSafetyError(
      "CRITICAL SAFETY VIOLATION: could not determine the database host from the connection config",
    );
  }
  return raw.replace(/^\[/, "").replace(/\]$/, "").trim().toLowerCase();
}

// Throws SeedSafetyError if seeding must not proceed. Callers map that to process exit code 1.
export function assertSeedAllowed(env: GuardEnv, config: MigrationConfig): void {
  // Layer 1: explicit environment assertion.
  if (env.NODE_ENV === "production" || env.APP_ENV === "production") {
    throw new SeedSafetyError(
      "CRITICAL SAFETY VIOLATION: Seeding is strictly forbidden in production!",
    );
  }

  // Layer 2: connection-host analysis.
  const host = resolveHost(config);

  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new SeedSafetyError(
        `CRITICAL SAFETY VIOLATION: refusing to seed against a staging/production-shaped host "${host}"`,
      );
    }
  }

  if (!LOCAL_HOSTS.has(host) && env.SEED_ALLOW_NONLOCAL !== "true") {
    throw new SeedSafetyError(
      `CRITICAL SAFETY VIOLATION: host "${host}" is not a recognized local database. ` +
        "Seeding is limited to loopback hosts; set SEED_ALLOW_NONLOCAL=true only for a disposable " +
        "remote CI database you are certain is not shared.",
    );
  }
}
