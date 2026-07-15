import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createClient } from "./client";
import { loadMigrationConfig, redact } from "./config";
import { SeedError } from "./errors";

const SEED_FILENAME = /^(\d{3})_([a-z][a-z0-9_]*)\.sql$/;

interface SeedFile {
  order: number;
  name: string;
  filename: string;
  sql: string;
}

export async function discoverSeedFiles(directory: string): Promise<SeedFile[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown filesystem error";
    throw new SeedError(`Cannot read seed directory: ${message}`);
  }

  const sqlEntries = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  const files: SeedFile[] = [];
  const orders = new Set<number>();

  for (const entry of sqlEntries) {
    const match = SEED_FILENAME.exec(entry.name);
    if (!match) {
      throw new SeedError(`Invalid seed filename ${entry.name}; expected 001_canonical_name.sql`);
    }
    const [, orderText, name] = match;
    const order = Number(orderText);
    if (orders.has(order)) {
      throw new SeedError(`Duplicate seed order ${order}`);
    }
    orders.add(order);

    // entry.name comes from this directory and must pass SEED_FILENAME before access.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const bytes = await readFile(join(directory, entry.name));
    const sql = bytes.toString("utf8");
    if (sql.charCodeAt(0) === 0xfeff) {
      throw new SeedError(`${entry.name} must not contain a UTF-8 BOM`);
    }
    if (!sql.trim()) throw new SeedError(`${entry.name} must contain SQL`);
    files.push({ order, name, filename: entry.name, sql });
  }

  files.sort((left, right) => left.order - right.order);
  return files;
}

async function checkMigrationsCurrent(migrationsDir: string): Promise<void> {
  const { discoverMigrations } = await import("./discovery");
  const { loadMigrationConfig: loadConfig } = await import("./config");

  // We only need the migrations directory from config; database check happens in the main runner.
  const migrations = await discoverMigrations(migrationsDir);
  if (migrations.length === 0) return;

  // We cannot query schema_migrations here without a database connection, so we rely on
  // the caller to pass the sql client. This check is done in runSeedCommand instead.
}

async function assertMigrationsCurrent(
  sql: { unsafe: (query: string) => Promise<unknown[]> },
  migrationsDir: string,
): Promise<void> {
  const { discoverMigrations } = await import("./discovery");
  const migrations = await discoverMigrations(migrationsDir);
  if (migrations.length === 0) return;

  const rows = (await sql.unsafe(
    "SELECT version::text AS version FROM public.schema_migrations ORDER BY version",
  )) as { version: string }[];

  const applied = new Set(rows.map((r) => r.version));
  const pending = migrations.filter((m) => !applied.has(m.versionText));

  if (pending.length > 0) {
    const names = pending.map((m) => m.filename).join(", ");
    throw new SeedError(
      `${pending.length} pending migration(s) must be applied before seeding: ${names}`,
    );
  }
}

export interface SeedOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

export async function runSeedCommand(options: SeedOptions = {}): Promise<void> {
  const env = options.env ?? process.env;

  if (env.NODE_ENV === "production") {
    throw new SeedError("Seed data cannot be loaded in production");
  }

  const config = loadMigrationConfig(env);
  const log = options.log ?? console.log;
  const files = await discoverSeedFiles(config.seedsDir);

  if (files.length === 0) {
    log("no seed files found");
    return;
  }

  const client = createClient(config, "studafy-seed");
  try {
    // Verify all migrations are applied before seeding.
    await assertMigrationsCurrent(client, config.migrationsDir);

    let schoolId: string | undefined;

    await client.begin(async (sql) => {
      for (const file of files) {
        log(`seeding ${file.filename}`);
        const rows = await sql.unsafe(file.sql);

        // Capture school_id from the school insert (file 002) for subsequent files.
        // The school insert returns a row with an id column.
        if (file.name === "school" && Array.isArray(rows) && rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          if (typeof row.id === "string") {
            schoolId = row.id;
          }
        }
      }
    });

    log(`seeded ${files.length} file(s)${schoolId ? ` (school: ${schoolId})` : ""}`);
  } catch (error) {
    if (error instanceof SeedError) throw error;
    const message = error instanceof Error ? error.message : "unknown error";
    throw new SeedError(redact(message, config.redactions));
  } finally {
    await client.end({ timeout: 5 });
  }
}
