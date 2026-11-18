import { uploadConsistency } from "./upload-consistency";

import type { LicenseCommitment } from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * What the revenue share engine measures about a school, each behind one function:
 *
 *   * countEnrolledStudents      -- students enrolled at the end of the day.
 *   * countStudentAiHolders      -- enrolled students the school provides Student AI to in a month:
 *                                   an opt-in covering the month, or a student seat the school
 *                                   assigned, held at the end of the day (not in-app purchases).
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
  countStudentAiHolders(
    tx: TransactionSql,
    schoolId: string,
    licenseId: string,
    month: string,
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
 * Enrolled students the school provides Student AI to in `month` (YYYY-MM-01), as of the END of
 * `onDate` -- the numerator of the month's conversion (owner, 2026-11-18: conversion is the
 * students holding Student AI each month, not opt-ins alone):
 *
 *   * a phase 2 opt-in (app.ai_optins) covering the month: taken by then, starting on or before the
 *     month and ending on or after it, not released from it (`released_effective_month`), and not
 *     ended by then (released or transferred after the day still count); or
 *   * a student seat the school assigned (app.license_seats, any of its licences), held at the end
 *     of the day.
 *
 * Each student once, and only students counted as enrolled that day (`countEnrolledStudents`), so
 * the conversion never passes 100%. A student's own in-app purchase is not a school seat and does
 * not count. `licenseId` is kept for the signature: opt-ins are the school's year's (a renewal
 * measures the year's choices rather than 0) and seats are counted across its licences.
 */
export async function countStudentAiHolders(
  tx: TransactionSql,
  _schoolId: string,
  _licenseId: string,
  month: string,
  onDate: string,
): Promise<number> {
  const [row] = await tx<{ count: number }[]>`
    WITH holders AS (
      SELECT o.student_id
      FROM app.ai_optins AS o
      WHERE o.school_id = current_setting('app.school_id')::uuid
        AND o.opted_in_at < ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND o.start_month <= ${month}::date AND o.end_month >= ${month}::date
        AND (o.released_effective_month IS NULL OR o.released_effective_month > ${month}::date)
        AND (
          o.status = 'active'
          OR o.ended_at >= ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
        )
      UNION
      SELECT s.student_id
      FROM app.license_seats AS s
      WHERE s.school_id = current_setting('app.school_id')::uuid
        AND s.audience = 'student'
        AND s.assigned_at < ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND (
          s.unassigned_at IS NULL
          OR s.unassigned_at >= ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
        )
    )
    SELECT count(*)::int AS count
    FROM holders AS h
    JOIN app.students AS st
      ON st.id = h.student_id AND st.school_id = current_setting('app.school_id')::uuid
    WHERE st.status = 'enrolled'
      AND st.created_at < ((${onDate}::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND (st.admission_date IS NULL OR st.admission_date <= ${onDate}::date)
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
  countStudentAiHolders,
  uploadConsistencyForPeriod,
  licenceCommitment,
};
