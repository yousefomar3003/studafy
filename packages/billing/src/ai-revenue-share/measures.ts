import { uploadConsistency } from "./upload-consistency";

import type { LicenseCommitment } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * What the revenue share engine measures about a school, each behind one function:
 *
 *   * countEnrolledStudents      -- students enrolled at the end of the day.
 *   * countOptedInStudents       -- phase 2's opt-ins (app.ai_optins) active at the end of the day,
 *                                   for the academic year covering it.
 *   * uploadConsistencyForPeriod -- phase 4's upload consistency over the days a payment covers
 *                                   (./upload-consistency.ts, the same read the API's views use),
 *                                   once those days are over.
 *   * licenceCommitment          -- school_licenses.commitment (000235).
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
  ): Promise<LicenseCommitment>;
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
 * Students opted in to Student AI at the end of `onDate`: the school's phase 2 opt-ins
 * (app.ai_optins) for the academic year covering `onDate` -- or, before any year has begun, the next
 * one (parents opt in before the year starts) -- taken by then and not ended by then (released or
 * transferred after the day still count), each student once.
 *
 * Opt-ins are per academic year: parents choose again each new year, and a licence renewal does NOT
 * carry them over. They are counted for the school's year, not only this licence's, so a renewal (or
 * a second licence in the same year) measures the year's opt-ins rather than 0. `licenseId` is kept
 * for the signature; it does not narrow the count.
 */
export async function countOptedInStudents(
  tx: TransactionSql,
  _schoolId: string,
  _licenseId: string,
  onDate: string,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    WITH year AS (
      SELECT ay.id
      FROM app.academic_years AS ay
      WHERE ay.school_id = current_setting('app.school_id')::uuid
        AND ay.ends_on >= ${onDate}::date
      ORDER BY (ay.starts_on <= ${onDate}::date) DESC,
               CASE WHEN ay.starts_on <= ${onDate}::date THEN ay.starts_on END DESC,
               ay.starts_on ASC
      LIMIT 1
    )
    SELECT count(DISTINCT o.student_id)::int AS count
    FROM app.ai_optins AS o
    JOIN year ON year.id = o.academic_year_id
    WHERE o.school_id = current_setting('app.school_id')::uuid
      AND o.opted_in_at < ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND (
        o.status = 'active'
        OR o.ended_at >= ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
      )
  `;
  return row?.count ?? 0;
}

/**
 * Upload consistency over the school days of `from`..`to` (inclusive), averaged across the classes
 * that have Student AI, in basis points (phase 4, ./upload-consistency.ts). Null while it cannot be
 * known yet: until the last day of the period has passed in the school's timezone, the bonus waits
 * (the share stays bonus-pending and the workers' hourly job, or the next payment or recompute,
 * works it out once the days are over). A finished period with no class to measure is 0.
 */
export async function uploadConsistencyForPeriod(
  tx: TransactionSql,
  period: ConsistencyPeriod,
): Promise<number | null> {
  const report = await uploadConsistency(tx, { from: period.from, to: period.to });
  if (report.today <= period.to) return null;
  return report.consistencyBps ?? 0;
}

/** The licence's commitment: `school_licenses.commitment` (000235). */
export async function licenceCommitment(
  tx: TransactionSql,
  _schoolId: string,
  licenseId: string,
): Promise<LicenseCommitment> {
  const [row] = await tx<{ commitment: LicenseCommitment }[]>`
    SELECT l.commitment
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
