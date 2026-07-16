import postgres from "postgres";

import type { Env } from "./env";
import type { TransactionSql } from "postgres";

export type Database = ReturnType<typeof postgres>;

export interface TenantDatabaseContext {
  schoolId: string;
  userId?: string;
  /**
   * The API request making this change, for app.audit_logs.request_id (000026). Optional by
   * construction rather than by omission: the migrations CLI, the workers, and scheduled jobs all
   * write with no HTTP request behind them.
   */
  requestId?: string;
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
    // school_id first: it is the tenant boundary, so nothing else is established until it is.
    await transaction`SELECT set_config('app.school_id', ${context.schoolId}, true)`;
    if (context.userId !== undefined) {
      await transaction`SELECT set_config('app.user_id', ${context.userId}, true)`;
    }
    // Transaction-local (the third argument), for the same reason as the two above: PgBouncer runs
    // in transaction mode, so a session-level SET would leak this request's id onto whichever
    // request borrows the physical connection next.
    //
    // These stay separate statements. Collapsing them into one SELECT looks tempting, but
    // set_config(name, NULL, true) sets the GUC to the empty string rather than leaving it unset,
    // which turns the 42704 that RLS helpers rely on into a 22P02 and quietly changes the
    // fail-closed behaviour packages/db/tests/audit-logs.test.ts asserts.
    if (context.requestId !== undefined) {
      await transaction`SELECT set_config('app.request_id', ${context.requestId}, true)`;
    }
    result = await operation(transaction);
  });
  return result as T;
}
