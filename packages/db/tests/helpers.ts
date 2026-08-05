import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

const adminUrl = process.env.TEST_DATABASE_URL;

export const integrationEnabled = Boolean(adminUrl);

export async function migrationFixture(files: Record<string, string>): Promise<{
  directory: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "studafy-db-integration-"));
  await Promise.all(
    // Test filenames are fixed fixture input written only beneath the fresh temporary directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    Object.entries(files).map(([name, contents]) => writeFile(join(directory, name), contents)),
  );
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function testDatabase(): Promise<{
  name: string;
  url: string;
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}> {
  const name = `studafy_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl!, { max: 1, ssl: false });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = databaseUrl(name);
  const sql = postgres(url, { max: 2, ssl: false });
  return {
    name,
    url,
    sql,
    cleanup: async () => {
      await sql.end({ timeout: 1 });
      const cleanupAdmin = postgres(adminUrl!, { max: 1, ssl: false });
      await cleanupAdmin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
      await cleanupAdmin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await cleanupAdmin.end();
    },
  };
}

export function runnerEnv(url: string, directory: string): Record<string, string> {
  return {
    DATABASE_URL: url,
    DATABASE_SSL_MODE: "disable",
    MIGRATIONS_DIR: directory,
  };
}

// Env for a spawned CLI process. DATABASE_URL cannot be combined with discrete DATABASE_* values
// (see loadMigrationConfig), so the inherited environment is scrubbed of them. Spawners should also
// pass --no-env-file so the child's own bun startup cannot load the repo's ambient .env (whose
// discrete values would otherwise collide with the DATABASE_URL provided here).
export function cliEnv(url: string, extra: Record<string, string> = {}): Record<string, string> {
  const discreteDbKeys = new Set([
    "DATABASE_HOST",
    "DATABASE_PORT",
    "DATABASE_NAME",
    "DATABASE_USER",
    "DATABASE_PASSWORD",
  ]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !discreteDbKeys.has(key))),
    DATABASE_URL: url,
    DATABASE_SSL_MODE: "disable",
    ...extra,
  };
}
