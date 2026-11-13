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

export interface ReviewGuardEnv {
  // Must equal the review tenant's slug. An explicit, per-invocation statement of intent: the review
  // seed is the one seed meant to run against production, so it cannot rely on the host checks above.
  readonly REVIEW_TENANT_SEED_CONFIRM?: string;
}

// Guard for db/seeds/review-tenant.ts. Deliberately independent of assertSeedAllowed: that guard
// exists to keep fabricated local data out of shared databases, while the reviewer tenant must be
// provisioned in production. What keeps the reviewer tenant from being used as a real one is its
// profile (no SUPER_ADMIN, no billable plan, is_review_tenant) and migration 000116, not the host.
export function assertReviewSeedAllowed(env: ReviewGuardEnv, expectedSlug: string): void {
  if (env.REVIEW_TENANT_SEED_CONFIRM !== expectedSlug) {
    throw new SeedSafetyError(
      `Refusing to seed the reviewer tenant: set REVIEW_TENANT_SEED_CONFIRM=${expectedSlug} ` +
        "to confirm the target database.",
    );
  }
}

export interface QaGuardEnv {
  // NODE_ENV is deliberately not read: staging runs NODE_ENV=production, so it cannot tell the two
  // apart. APP_ENV can.
  readonly APP_ENV?: string;
  // Must equal QA_SEED_CONFIRMATION (qa-credentials.ts): an explicit, per-invocation statement of
  // intent, like the reviewer seed's.
  readonly QA_TENANT_SEED_CONFIRM?: string;
}

// Host shapes the QA seed may target: staging's RDS instance is `<project>-staging-postgres` (the
// naming module's name_prefix), and an SSM tunnel to it arrives on a loopback host.
const QA_HOST_PATTERNS: readonly RegExp[] = [
  /(^|[.\-_])staging([.\-_]|$)/i,
  /(^|[.\-_])stage([.\-_]|$)/i,
];

const PRODUCTION_HOST_PATTERNS: readonly RegExp[] = [
  /(^|[.\-_])prod([.\-_]|$)/i,
  /(^|[.\-_])production([.\-_]|$)/i,
];

// Guard for db/seeds/qa-tenant.ts. The QA tenants hold a SUPER_ADMIN that the QA login signs in to
// with a shared password, so unlike the reviewer seed this one must never reach production: the API
// refusing QA_LOGIN_PASSWORD in production is the primary rail, and this keeps the accounts from
// existing there at all. Layered like assertSeedAllowed: confirmation, environment, then host
// allowlist (local or staging-shaped only; production-shaped is always refused).
export function assertQaSeedAllowed(
  env: QaGuardEnv,
  config: MigrationConfig,
  expectedConfirmation: string,
): void {
  if (env.QA_TENANT_SEED_CONFIRM !== expectedConfirmation) {
    throw new SeedSafetyError(
      `Refusing to seed the QA tenants: set QA_TENANT_SEED_CONFIRM=${expectedConfirmation} ` +
        "to confirm the target database.",
    );
  }

  if (env.APP_ENV === "production") {
    throw new SeedSafetyError(
      "CRITICAL SAFETY VIOLATION: the QA tenants must never be seeded in production!",
    );
  }

  const host = resolveHost(config);
  if (PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new SeedSafetyError(
      `CRITICAL SAFETY VIOLATION: refusing to seed the QA tenants against a production-shaped host "${host}"`,
    );
  }
  if (!LOCAL_HOSTS.has(host) && !QA_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new SeedSafetyError(
      `Refusing to seed the QA tenants against "${host}": only a local or staging-shaped host is ` +
        "allowed. Tunnel to staging and connect through localhost if its host name does not say so.",
    );
  }
}
