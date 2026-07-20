import postgres from "postgres";

import type { Env } from "../env";

export type Database = ReturnType<typeof postgres>;

/** Production pool capacity. Benchmarks use the same value so contention is representative. */
export const DATABASE_MAX_CONNECTIONS = 16;

export function createDatabase(env: Env): Database | null {
  if (!env.DATABASE_HOST) {
    return null;
  }

  return postgres({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT ?? 6432,
    database: env.DATABASE_NAME,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    ssl: { ca: env.DATABASE_CA_CERT, rejectUnauthorized: true },
    max: DATABASE_MAX_CONNECTIONS,
    idle_timeout: 20,
    connect_timeout: 5,
    prepare: false,
  });
}

export async function checkDatabase(database: Database | null): Promise<boolean> {
  if (!database) {
    return true;
  }
  try {
    await database`select 1 as healthy`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(database: Database | null): Promise<void> {
  await database?.end({ timeout: 5 });
}
