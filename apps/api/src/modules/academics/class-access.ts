import type { TransactionSql } from "postgres";

/**
 * Whether the caller may manage a class's teaching content: they lead the school
 * (`app.current_user_is_school_admin()`: ORG_ADMIN, PRINCIPAL, SUPER_ADMIN) or teach the class
 * (`app.teaches_class`: its lead teacher or a teacher holding one of its timetable slots).
 *
 * Both are the SECURITY DEFINER helpers the RLS policies call, so "teaches this class" has one
 * definition across the system. They answer for any class id, visible or not, so a caller who
 * cannot see the class simply gets false.
 *
 * This is the class half of a write check. The permission half (assignment:*, material:*) is the
 * route's requirePermission gate, which runs first: a principal passes this check for every class
 * but still writes only what their permissions allow.
 */
export async function callerManagesClass(tx: TransactionSql, classId: string): Promise<boolean> {
  const [row] = await tx<{ allowed: boolean }[]>`
    SELECT (app.current_user_is_school_admin() OR app.teaches_class(${classId}::uuid)) AS allowed
  `;
  return row?.allowed === true;
}
