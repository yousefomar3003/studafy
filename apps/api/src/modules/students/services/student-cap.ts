import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";

import type { TransactionSql } from "postgres";

/**
 * Result of a student cap check.
 */
export interface StudentCapCheck {
  /** Current number of students in the tenant. */
  currentCount: number;
  /** Maximum allowed students (from subscriptions.student_cap). */
  cap: number;
  /** Whether the requested enrollment would stay within the cap. */
  allowed: boolean;
}

/**
 * Atomic student cap check against the tenant's subscription.
 *
 * Runs a single query that counts current students and reads the cap from the subscription row
 * in one round trip. The count is inherently consistent within the transaction's snapshot, so
 * concurrent enrollments are serialized by the database's transaction isolation.
 *
 * Must be called inside `withTenantTx` so that `app.school_id` is set.
 *
 * @param tx - Active transaction with tenant context set.
 * @param additionalStudents - Number of students about to be added (default 1 for single creation).
 * @returns The current count, cap, and whether the operation is allowed.
 *
 * @example
 * ```typescript
 * await withTenantTx(database, tenantContext, async (tx) => {
 *   const cap = await checkStudentCap(tx);
 *   if (!cap.allowed) {
 *     throw new CodedHttpException(402, ERROR_CODES.LIMIT_EXCEEDED_STUDENT_CAP,
 *       `Student cap of ${cap.cap} reached. Upgrade your plan.`);
 *   }
 *   // ... proceed with student creation
 * });
 * ```
 */
export async function checkStudentCap(
  tx: TransactionSql,
  additionalStudents = 1,
): Promise<StudentCapCheck> {
  const [row] = await tx<{ current_count: string; cap: string }[]>`
    SELECT
      (SELECT count(*)::text FROM app.students
       WHERE school_id = current_setting('app.school_id')::uuid) AS current_count,
      (SELECT student_cap::text FROM app.subscriptions
       WHERE school_id = current_setting('app.school_id')::uuid) AS cap
  `;

  const currentCount = Number(row?.current_count ?? 0);
  const cap = Number(row?.cap ?? 50);

  return {
    currentCount,
    cap,
    allowed: currentCount + additionalStudents <= cap,
  };
}

/**
 * Assert that the tenant has room for additional students.
 *
 * Throws a 402 Payment Required with LIMIT_EXCEEDED_STUDENT_CAP if the cap would be exceeded.
 * Convenience wrapper around {@link checkStudentCap} for the common case where you want to
 * fail fast rather than inspect the result.
 *
 * @param tx - Active transaction with tenant context set.
 * @param additionalStudents - Number of students about to be added (default 1).
 * @throws {CodedHttpException} 402 if the student cap would be exceeded.
 */
export async function assertStudentCap(
  tx: TransactionSql,
  additionalStudents = 1,
): Promise<StudentCapCheck> {
  const result = await checkStudentCap(tx, additionalStudents);

  if (!result.allowed) {
    throw new CodedHttpException(
      402,
      ERROR_CODES.LIMIT_EXCEEDED_STUDENT_CAP,
      `Student cap of ${result.cap} reached. You currently have ${result.currentCount} students. Upgrade your plan to add more.`,
    );
  }

  return result;
}
