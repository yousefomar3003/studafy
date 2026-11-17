import { academicYearMonths, monthIndex, monthStart } from "./academic-months";

/**
 * Student AI opt-in pricing (phase 2 of the Student AI programme, docs/billing/ai-programme.md).
 *
 * A parent commits for the rest of the school's academic year: from the month they opt in (or the
 * academic year's first month, when they opt in before it starts) to the academic year's last month,
 * at the monthly price parents see. Months follow the school's own academic year -- 8, 10, 12 or
 * any other number -- never an assumed 10 -- counted by THE month rule (`academicYearMonths`: a
 * calendar month counts when the year covers at least half of it), the same months the tuition line
 * and the revenue share count. Opt-ins are per academic year: parents choose again each new year,
 * and a licence renewal does not carry them over. Pure: dates are school-local `YYYY-MM-DD` strings.
 */

/** The terms a parent agrees to; recorded on every opt-in. Bump when the wording changes. */
export const AI_OPTIN_TERMS_VERSION = "2026-11-18";

export const AI_OPTIN_SOURCES = ["parent", "school_on_behalf", "transfer"] as const;
export type AiOptInSource = (typeof AI_OPTIN_SOURCES)[number];

export const AI_OPTIN_STATUSES = ["active", "released", "transferred"] as const;
export type AiOptInStatus = (typeof AI_OPTIN_STATUSES)[number];

/**
 * A licence's commitment (school_licenses.commitment, 000235): full_year -- committed for the
 * school's whole academic year, earns the revenue share -- or month_to_month (cancellable; the share
 * is scaled by monthToMonthShareBps, 0 by default). The one list the licence, the quote and the
 * revenue share engine use.
 */
export const LICENSE_COMMITMENTS = ["full_year", "month_to_month"] as const;
export type LicenseCommitment = (typeof LICENSE_COMMITMENTS)[number];

export interface AiOptInPeriod {
  /** First day of the first month covered. */
  startMonth: string;
  /** First day of the last month covered (the academic year's last month). */
  endMonth: string;
  months: number;
}

/** The first day of `date`'s month. */
export function firstOfMonth(date: string): string {
  return monthStart(monthIndex(date));
}

/** The first day of the month after `date`'s. */
export function firstOfNextMonth(date: string): string {
  return monthStart(monthIndex(date) + 1);
}

/** Whole calendar months from `startMonth` to `endMonth`, both included. */
export function monthsBetween(startMonth: string, endMonth: string): number {
  return monthIndex(endMonth) - monthIndex(startMonth) + 1;
}

/**
 * The months an opt-in made on `today` covers in an academic year: from today's month (late opt-in)
 * or the year's first counted month (early), to the year's last counted month (`academicYearMonths`).
 * Null once the year is over, or when no counted month is left.
 */
export function aiOptInPeriod(
  academicYear: { startsOn: string; endsOn: string },
  today: string,
): AiOptInPeriod | null {
  if (today.slice(0, 10) > academicYear.endsOn.slice(0, 10)) return null;
  const year = academicYearMonths(academicYear.startsOn, academicYear.endsOn);
  if (!year) return null;
  const start = Math.max(year.first, monthIndex(today));
  const end = year.last;
  if (end < start) return null;
  return { startMonth: monthStart(start), endMonth: monthStart(end), months: end - start + 1 };
}

/** What parents see: the monthly price, times the months, as the total. */
export function aiOptInTotal(monthlyPriceMinor: number, months: number): number {
  return monthlyPriceMinor * months;
}
