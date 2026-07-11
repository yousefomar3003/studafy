import postgres from "postgres";

import { loadMigrationConfig, redact, type MigrationConfig } from "./config";
import { discoverMigrations } from "./discovery";
import { MigrationExecutionError, MigrationLockError, MigrationValidationError } from "./errors";

import type { AppliedMigration, Migration, MigrationCommand, MigrationStatus } from "./types";

export const ADVISORY_LOCK_KEY = 6004517954832980272n;
export const TOOL_VERSION = "0.1.0";

type Sql = postgres.Sql;
type ReservedSql = postgres.ReservedSql;
type TransactionSql = postgres.TransactionSql;
type QuerySql = ReservedSql | TransactionSql;

interface HistoryRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  execution_duration_ms: string;
  tool_version: string;
}

export interface RunnerOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

function createClient(config: MigrationConfig): Sql {
  const options = {
    ssl: config.ssl,
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 10,
    target_session_attrs: "primary" as const,
    connection: { application_name: "studafy-migrations" },
  };
  if (config.url) return postgres(config.url, options);
  return postgres({
    ...options,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.username,
    password: config.password,
  });
}

async function acquireLock(sql: ReservedSql): Promise<void> {
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY.toString()}) AS locked
  `;
  if (!row?.locked) {
    throw new MigrationLockError("Another migration process holds the Studafy advisory lock");
  }
}

async function releaseLock(sql: ReservedSql): Promise<void> {
  await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY.toString()})`;
}

async function metadataExists<T extends QuerySql>(sql: T): Promise<boolean> {
  const [row] = await sql<{ table_name: string | null }[]>`
    SELECT to_regclass('public.schema_migrations')::text AS table_name
  `;
  return row?.table_name !== null;
}

async function initializeMetadata(sql: ReservedSql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version bigint CONSTRAINT pk_schema_migrations PRIMARY KEY,
      name text CONSTRAINT uq_schema_migrations_name UNIQUE NOT NULL,
      checksum text NOT NULL CONSTRAINT ck_schema_migrations_checksum
        CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      execution_duration_ms bigint NOT NULL
        CONSTRAINT ck_schema_migrations_duration CHECK (execution_duration_ms >= 0),
      tool_version text NOT NULL
    )
  `);
}

async function loadHistory<T extends QuerySql>(sql: T): Promise<AppliedMigration[]> {
  if (!(await metadataExists(sql))) return [];
  const rows = await sql<HistoryRow[]>`
    SELECT version, name, checksum, applied_at, execution_duration_ms, tool_version
    FROM public.schema_migrations
    ORDER BY version
  `;
  return rows.map((row) => ({
    version: BigInt(row.version),
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    executionDurationMs: BigInt(row.execution_duration_ms),
    toolVersion: row.tool_version,
  }));
}

function validateHistory(
  migrations: readonly Migration[],
  history: readonly AppliedMigration[],
): MigrationStatus {
  const filesByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set(history.map((migration) => migration.version));

  for (const applied of history) {
    const file = filesByVersion.get(applied.version);
    if (!file) {
      throw new MigrationValidationError(
        `Applied migration ${applied.version.toString().padStart(6, "0")}_${applied.name}.sql is missing`,
      );
    }
    if (file.name !== applied.name) {
      throw new MigrationValidationError(
        `Applied migration ${file.versionText} was renamed from ${applied.name} to ${file.name}`,
      );
    }
    if (file.checksum !== applied.checksum) {
      throw new MigrationValidationError(
        `Checksum mismatch for applied migration ${file.filename}; applied migrations are immutable`,
      );
    }
  }

  const maxApplied = history.at(-1)?.version;
  const pending = migrations.filter((migration) => !appliedVersions.has(migration.version));
  const outOfOrder = pending.find(
    (migration) => maxApplied !== undefined && migration.version < maxApplied,
  );
  if (outOfOrder) {
    throw new MigrationValidationError(
      `Pending migration ${outOfOrder.filename} is older than an applied migration`,
    );
  }

  return {
    initialized: history.length > 0,
    applied: migrations.filter((migration) => appliedVersions.has(migration.version)),
    pending,
  };
}

async function recordMigration<T extends QuerySql>(
  sql: T,
  migration: Migration,
  executionDurationMs: bigint,
): Promise<void> {
  await sql`
    INSERT INTO public.schema_migrations
      (version, name, checksum, execution_duration_ms, tool_version)
    VALUES
      (${migration.version.toString()}, ${migration.name}, ${migration.checksum}, ${executionDurationMs.toString()}, ${TOOL_VERSION})
  `;
}

async function applyMigration(sql: ReservedSql, migration: Migration): Promise<bigint> {
  const started = process.hrtime.bigint();
  try {
    if (migration.transactional) {
      // postgres@3's reserved connection has no `.begin()`; drive the transaction manually so the
      // migration and its history row commit atomically on the same session that holds the lock.
      await sql.unsafe("BEGIN");
      try {
        await sql.unsafe(migration.sql);
        const duration = (process.hrtime.bigint() - started) / 1_000_000n;
        await recordMigration(sql, migration, duration);
        await sql.unsafe("COMMIT");
      } catch (error) {
        await sql.unsafe("ROLLBACK");
        throw error;
      }
    } else {
      await sql.unsafe(migration.sql);
      const duration = (process.hrtime.bigint() - started) / 1_000_000n;
      await recordMigration(sql, migration, duration);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown PostgreSQL error";
    throw new MigrationExecutionError(`${migration.filename} failed: ${message}`);
  }
  return (process.hrtime.bigint() - started) / 1_000_000n;
}

export async function runMigrationCommand(
  command: MigrationCommand,
  options: RunnerOptions = {},
): Promise<MigrationStatus> {
  const config = loadMigrationConfig(options.env);
  const migrations = await discoverMigrations(config.migrationsDir);
  const log = options.log ?? console.log;
  const client = createClient(config);
  let reserved: ReservedSql | undefined;
  let locked = false;

  try {
    reserved = await client.reserve();
    await acquireLock(reserved);
    locked = true;

    if (command === "migrate") await initializeMetadata(reserved);
    let status = validateHistory(migrations, await loadHistory(reserved));

    if (command === "migrate") {
      for (const migration of status.pending) {
        const duration = await applyMigration(reserved, migration);
        log(`applied ${migration.filename} (${duration}ms)`);
      }
      status = validateHistory(migrations, await loadHistory(reserved));
      if (status.pending.length === 0) log("database is up to date");
    } else if (command === "status") {
      if (!status.initialized) log("migration history is not initialized");
      for (const migration of status.applied) log(`applied  ${migration.filename}`);
      for (const migration of status.pending) log(`pending  ${migration.filename}`);
    } else if (command === "pending") {
      for (const migration of status.pending) log(migration.filename);
      log(`${status.pending.length} pending migration(s)`);
    } else {
      log(`validated ${status.applied.length} applied migration(s)`);
      log(`${status.pending.length} pending migration(s)`);
    }

    return status;
  } catch (error) {
    if (error instanceof Error) error.message = redact(error.message, config.redactions);
    throw error;
  } finally {
    if (reserved && locked) {
      try {
        await releaseLock(reserved);
      } catch {
        // A lost session has already released its PostgreSQL advisory lock.
      }
    }
    reserved?.release();
    await client.end({ timeout: 5 });
  }
}
