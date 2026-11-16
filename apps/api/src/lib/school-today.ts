import type { TransactionSql } from "postgres";

/**
 * The armed school's local date, YYYY-MM-DD (QA-044): `app.school_today()` in the caller's tenant
 * transaction. Use it wherever a date defaults to "today" -- never the server's UTC date.
 */
export async function schoolToday(tx: TransactionSql): Promise<string> {
  const [row] = await tx<{ today: string }[]>`SELECT app.school_today()::text AS today`;
  return row!.today;
}
