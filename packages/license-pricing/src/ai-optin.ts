/**
 * Student AI opt-in pricing (phase 2 of the Student AI programme, docs/billing/ai-programme.md).
 *
 * A parent commits for the rest of the school's academic year: from the month they opt in (or the
 * academic year's first month, when they opt in before it starts) to the academic year's last month,
 * at the monthly price parents see. Months follow the school's own academic year -- 8, 10, 12 or
 * any other number -- never an assumed 10. Pure: dates are school-local `YYYY-MM-DD` strings.
 */

/** The terms a parent agrees to; recorded on every opt-in. Bump when the wording changes. */
export const AI_OPTIN_TERMS_VERSION = "2026-11-17";

export const AI_OPTIN_SOURCES = ["parent", "school_on_behalf", "transfer"] as const;
export type AiOptInSource = (typeof AI_OPTIN_SOURCES)[number];

export const AI_OPTIN_STATUSES = ["active", "released", "transferred"] as const;
export type AiOptInStatus = (typeof AI_OPTIN_STATUSES)[number];

export const LICENSE_COMMITMENTS = ["full_year", "month_to_month"] as const;
export type LicenseCommitment = (typeof LICENSE_COMMITMENTS)[number];

export interface AiOptInPeriod {
  /** First day of the first month covered. */
  startMonth: string;
  /** First day of the last month covered (the academic year's last month). */
  endMonth: string;
  months: number;
}

function monthIndex(date: string): number {
  const [year, month] = date.slice(0, 10).split("-").map(Number) as [number, number];
  return year * 12 + (month - 1);
}

function monthStart(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
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
 * or the year's first month (early), to the year's last month. Null once the year is over.
 */
export function aiOptInPeriod(
  academicYear: { startsOn: string; endsOn: string },
  today: string,
): AiOptInPeriod | null {
  const start = Math.max(monthIndex(academicYear.startsOn), monthIndex(today));
  const end = monthIndex(academicYear.endsOn);
  if (today.slice(0, 10) > academicYear.endsOn.slice(0, 10) || end < start) return null;
  return { startMonth: monthStart(start), endMonth: monthStart(end), months: end - start + 1 };
}

/** What parents see: the monthly price, times the months, as the total. */
export function aiOptInTotal(monthlyPriceMinor: number, months: number): number {
  return monthlyPriceMinor * months;
}
