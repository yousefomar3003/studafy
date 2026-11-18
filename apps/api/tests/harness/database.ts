import { resolve } from "node:path";

import postgres from "postgres";

import { runMigrationCommand } from "../../../../packages/db/src/runner";

export interface TestDatabase {
  name: string;
  url: string;
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}

export interface TestDatabaseOptions {
  /** Connection capacity for the disposable database client. Defaults to the test-safe value 4. */
  maxConnections?: number;
}

const REPOSITORY_MIGRATIONS = resolve(import.meta.dir, "../../../../db/migrations");

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);

export { integrationEnabled };

// ---------------------------------------------------------------------------
// Least-privilege app connections (QA-003)
// ---------------------------------------------------------------------------

/**
 * `user:password` of a least-privilege login (db/test-roles/runtime-role.sql) for the *app under
 * test*. Unset: the app shares the fixture connection, as it always has. Set: fixtures keep seeding
 * through the superuser connection, but `appDatabaseFor` hands the app a second connection to the
 * same database that logs in as this role -- not a superuser, no BYPASSRLS, owning nothing -- so any
 * code path that only worked because the login could bypass RLS now fails.
 */
const APP_DB_ROLE = process.env.TEST_APP_DB_ROLE;

const urlBySql = new WeakMap<postgres.Sql, string>();
const appSqlBySql = new WeakMap<postgres.Sql, postgres.Sql>();
const verifiedAppSql = new WeakSet<postgres.Sql>();

/**
 * The connection the app under test should use for a test database created here: the fixture
 * connection itself, or -- when TEST_APP_DB_ROLE is set -- a connection as that least-privilege
 * login. Pass it wherever a test hands `database` to the app.
 */
export function appDatabaseFor(sql: postgres.Sql): postgres.Sql {
  if (!APP_DB_ROLE) return sql;
  const existing = appSqlBySql.get(sql);
  if (existing) return existing;
  const url = urlBySql.get(sql) ?? urlFromOptions(sql);
  const [user, password] = APP_DB_ROLE.split(":");
  const appUrl = new URL(url);
  appUrl.username = user!;
  appUrl.password = password ?? "";
  const appSql = postgres(appUrl.toString(), { max: 4, ssl: false, prepare: false });
  appSqlBySql.set(sql, appSql);
  return appSql;
}

/** Rebuild a URL from a postgres.js client's own options (for connections made outside this file). */
function urlFromOptions(sql: postgres.Sql): string {
  const { host, port, database } = sql.options as unknown as {
    host: string[];
    port: number[];
    database: string;
  };
  return `postgres://placeholder@${host[0]}:${port[0]}/${database}`;
}

/** Throws unless the app connection really is least-privilege (guards against a misconfigured run). */
export async function assertLeastPrivilege(appSql: postgres.Sql): Promise<void> {
  if (!APP_DB_ROLE || verifiedAppSql.has(appSql)) return;
  const [row] = await appSql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `;
  if (!row || row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `TEST_APP_DB_ROLE login ${row?.rolname ?? "?"} must be NOSUPERUSER NOBYPASSRLS ` +
        `(rolsuper=${row?.rolsuper}, rolbypassrls=${row?.rolbypassrls})`,
    );
  }
  verifiedAppSql.add(appSql);
}

function buildDatabaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start PostgreSQL with: docker compose up -d test-postgres test-redis",
    );
  }

  const name = `studafy_api_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(adminUrl, { max: 1, ssl: false });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  if (APP_DB_ROLE) {
    // The migrations revoke CONNECT from PUBLIC, and the least-privilege login inherits nothing
    // (INHERIT FALSE), so -- exactly like a production runtime login -- it needs CONNECT granted on
    // the database itself. The role name is a fixed test identifier, never caller input.
    const appUser = APP_DB_ROLE.split(":")[0]!;
    if (!/^[a-z_][a-z0-9_]*$/.test(appUser))
      throw new Error("TEST_APP_DB_ROLE user is not a plain role name");
    await admin.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO ${appUser}`);
  }
  await admin.end();

  const url = buildDatabaseUrl(adminUrl, name);
  const sql = postgres(url, { max: options.maxConnections ?? 4, ssl: false, prepare: false });
  urlBySql.set(sql, url);

  return {
    name,
    url,
    sql,
    cleanup: async () => {
      await appSqlBySql.get(sql)?.end({ timeout: 1 });
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
