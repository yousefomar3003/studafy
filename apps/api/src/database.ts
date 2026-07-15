import postgres from "postgres";

import type { Env } from "./env";
import type { TransactionSql } from "postgres";

export type Database = ReturnType<typeof postgres>;

export interface TenantDatabaseContext {
  schoolId: string;
  userId?: string;
}

export function createDatabase(env: Env): Database | null {
  if (!env.DATABASE_HOST) return null;

  return postgres({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT ?? 6432,
    database: env.DATABASE_NAME,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    ssl: { ca: env.DATABASE_CA_CERT, rejectUnauthorized: true },
    max: 10,
    idle_timeout: 20,
    connect_timeout: 5,
    prepare: false,
  });
}

export async function checkDatabase(database: Database | null): Promise<boolean> {
  if (!database) return true;
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

export async function withTenantTransaction<T>(
  database: Database,
  context: TenantDatabaseContext,
  operation: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await database.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL ROLE studafy_app");
    await transaction`SELECT set_config('app.school_id', ${context.schoolId}, true)`;
    if (context.userId !== undefined) {
      await transaction`SELECT set_config('app.user_id', ${context.userId}, true)`;
    }
    result = await operation(transaction);
  });
  return result as T;
}
