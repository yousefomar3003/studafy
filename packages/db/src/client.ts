import postgres from "postgres";

import type { MigrationConfig } from "./config";

// Re-exported so code outside this package's node_modules (notably db/seeds) can name the driver's
// connection types without resolving the `postgres` module from its own directory.
export type Sql = postgres.Sql;
export type ReservedSql = postgres.ReservedSql;
export type TransactionSql = postgres.TransactionSql;

// Shared by the migration runner and the attendance partition maintenance command: both are
// administrative, single-connection, primary-only tools that must never be pooled or prepared.
export function createClient(config: MigrationConfig, applicationName: string): postgres.Sql {
  const options = {
    ssl: config.ssl,
    max: 1,
    prepare: false,
    // Generous for an administrative one-shot: Supabase's pooler holds back a failed login for
    // ~11 s once a tenant has seen several, and starts a tenant's session pool on first use. At
    // 10 s the driver gave up first and reported a bare CONNECT_TIMEOUT instead of the real cause.
    connect_timeout: 30,
    idle_timeout: 10,
    target_session_attrs: "primary" as const,
    connection: { application_name: applicationName },
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
