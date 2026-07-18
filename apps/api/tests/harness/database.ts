import { resolve } from "node:path";

import postgres from "postgres";

import { runMigrationCommand } from "../../../../packages/db/src/runner";

export interface TestDatabase {
  name: string;
  url: string;
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}

const REPOSITORY_MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

export { integrationEnabled };

function buildDatabaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start PostgreSQL with: docker compose -f db/compose.yml up -d",
    );
  }

  const name = `studafy_api_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl, { max: 1, ssl: false });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();

  const url = buildDatabaseUrl(adminUrl, name);
  const sql = postgres(url, { max: 4, ssl: false, prepare: false });

  return {
    name,
    url,
    sql,
    cleanup: async () => {
      await sql.end({ timeout: 1 });
      const cleanupAdmin = postgres(adminUrl, { max: 1, ssl: false });
      await cleanupAdmin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
      );
      await cleanupAdmin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await cleanupAdmin.end();
    },
  };
}

export async function migrateDatabase(
  databaseUrl: string,
  migrationsDir: string = REPOSITORY_MIGRATIONS,
): Promise<void> {
  await runMigrationCommand("migrate", {
    env: {
      DATABASE_URL: databaseUrl,
      DATABASE_SSL_MODE: "disable",
      MIGRATIONS_DIR: migrationsDir,
    },
    log: () => undefined,
  });
}
