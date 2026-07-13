import postgres from "postgres";

import type { MigrationConfig } from "./config";

// Shared by the migration runner and the attendance partition maintenance command: both are
// administrative, single-connection, primary-only tools that must never be pooled or prepared.
export function createClient(config: MigrationConfig, applicationName: string): postgres.Sql {
  const options = {
    ssl: config.ssl,
    max: 1,
    prepare: false,
    connect_timeout: 10,
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
