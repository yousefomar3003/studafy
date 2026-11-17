import type { RevenueShareCommitment } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * What the revenue share engine measures about a school, each behind one function so the phases
 * built in parallel plug in at a single place:
 *
 *   * countOptedInStudents       -- ADAPTER, phase 2 (opt-in). Temporary: the licence's student
 *                                   seats held at the end of the day.
 *   * uploadConsistencyForPeriod -- ADAPTER, phase 4 (upload consistency). Temporary: unknown (null),
 *                                   so the content bonus stays pending.
 *   * licenceCommitment          -- reads school_licenses.commitment once phase 2 adds it (000235);
 *                                   full_year until then (every licence sold so far is a fixed,
 *                                   non-cancellable term).
 *   * countEnrolledStudents      -- this phase's own definition of "enrolled".
 *
 * All run inside the caller's transaction, scoped to the armed school (app.school_id), and count as
 * of the END of `onDate` (UTC). Student status keeps no history, so "enrolled on a day" is today's
 * status for students who existed and were admitted by then: the workers take the locked measurement
 * on the day itself.
 */

/** YYYY-MM-DD dates, inclusive. */
export interface ConsistencyPeriod {
  schoolId: string;
  licenseId: string;
  from: string;
  to: string;
}

export interface RevenueShareMeasures {
  countEnrolledStudents(tx: TransactionSql, schoolId: string, onDate: string): Promise<number>;
  countOptedInStudents(
    tx: TransactionSql,
    schoolId: string,
    licenseId: string,
    onDate: string,
  ): Promise<number>;
  /** Basis points (school days with an upload / school days), or null while it is not known. */
  uploadConsistencyForPeriod(tx: TransactionSql, period: ConsistencyPeriod): Promise<number | null>;
  licenceCommitment(
    tx: TransactionSql,
    schoolId: string,
    licenseId: string,
  ): Promise<RevenueShareCommitment>;
}

/** Students enrolled in the armed school at the end of `onDate`: status enrolled, admitted by then. */
export async function countEnrolledStudents(
  tx: TransactionSql,
  _schoolId: string,
  onDate: string,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM app.students AS s
    WHERE s.school_id = current_setting('app.school_id')::uuid
      AND s.status = 'enrolled'
      AND s.created_at < ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND (s.admission_date IS NULL OR s.admission_date <= ${onDate}::date)
  `;
  return row?.count ?? 0;
}

/**
 * ADAPTER -- students opted in to Student AI on the licence at the end of `onDate`.
 *
 * TODO(ai-revshare phase 2 integration): count phase 2's opt-in records instead (app.ai_optins of
 * this licence's school and academic year, active at the end of `onDate`), and keep this signature.
 * Temporary implementation: the licence's student seats held at the end of the day -- what the
 * licensing model (000163) already records for every student given Student AI.
 */
export async function countOptedInStudents(
  tx: TransactionSql,
  _schoolId: string,
  licenseId: string,
  onDate: string,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    SELECT count(DISTINCT seat.student_id)::int AS count
    FROM app.license_seats AS seat
    WHERE seat.school_id = current_setting('app.school_id')::uuid
      AND seat.license_id = ${licenseId}::uuid
      AND seat.audience = 'student'
      AND seat.assigned_at < ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND (
        seat.unassigned_at IS NULL
        OR seat.unassigned_at >= ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
      )
  `;
  return row?.count ?? 0;
}

/**
 * ADAPTER -- upload consistency over the school days of `from`..`to` (inclusive), averaged across
 * the classes that have Student AI, in basis points; null while it cannot be known.
 *
 * TODO(ai-revshare phase 4 integration): return phase 4's
 * `uploadConsistency({ schoolId, from, to })` converted to basis points (null when it has nothing to
 * measure yet), and keep this signature. Temporary implementation: unknown, so every share's
 * content bonus is pending (bonus_pending) and the share stays pending until this returns a value
 * (the super admin's recompute, and the workers' hourly run, pick it up).
 */
export async function uploadConsistencyForPeriod(
  _tx: TransactionSql,
  _period: ConsistencyPeriod,
): Promise<number | null> {
  return null;
}

/**
 * The licence's commitment: `school_licenses.commitment` (phase 2, 000235) when the column exists,
 * else full_year. Read through to_jsonb so this works before and after phase 2's migration.
 *
 * TODO(ai-revshare phase 2 integration): read `l.commitment` directly.
 */
export async function licenceCommitment(
  tx: TransactionSql,
  _schoolId: string,
  licenseId: string,
): Promise<RevenueShareCommitment> {
  const [row] = await tx<{ commitment: string | null }[]>`
    SELECT to_jsonb(l) ->> 'commitment' AS commitment
    FROM app.school_licenses AS l
    WHERE l.school_id = current_setting('app.school_id')::uuid AND l.id = ${licenseId}::uuid
  `;
  return row?.commitment === "month_to_month" ? "month_to_month" : "full_year";
}

/** The measures the API and the workers use. Tests pass their own. */
export const REVENUE_SHARE_MEASURES: RevenueShareMeasures = {
  countEnrolledStudents,
  countOptedInStudents,
  uploadConsistencyForPeriod,
  licenceCommitment,
};
