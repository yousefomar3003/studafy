/**
 * THE month rule of the Student AI programme (AI-REVSHARE-PLAN "One month rule everywhere"): which
 * calendar months a school's academic year -- or a licence term -- counts. The parent's opt-in
 * (phase 2, `aiOptInPeriod`), the tuition line (phase 3, apps/api finance/student-ai/plan.ts) and
 * the revenue share's instalment periods (phase 5, `instalmentPeriods`) all use it, so the licence,
 * the parent line and the school's payments count the same months.
 *
 * A calendar month counts when the range covers at least half of its days: 1 Sep - 30 Jun is 10
 * months, 1 Sep - 30 Apr is 8, and a year that starts on 25 Aug does not charge a whole August for
 * its last week. Nothing assumes 10. Pure; dates are `YYYY-MM-DD` strings.
 */

/** A month as one integer: year * 12 + (month - 1). */
export type MonthIndex = number;

export interface MonthRange {
  first: MonthIndex;
  last: MonthIndex;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function parts(date: string): [number, number, number] {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`Not an ISO date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function monthIndex(date: string): MonthIndex {
  const [year, month] = parts(date);
  return year * 12 + (month - 1);
}

/** The first day of a month, as an ISO date. */
export function monthStart(index: MonthIndex): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

/** "2026-09" for a month: how the API names months. */
export function monthKey(index: MonthIndex): string {
  return monthStart(index).slice(0, 7);
}

function daysInMonth(index: MonthIndex): number {
  const year = Math.floor(index / 12);
  const month = index % 12;
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The last day of a month, as an ISO date. */
export function monthEnd(index: MonthIndex): string {
  return `${monthKey(index)}-${String(daysInMonth(index)).padStart(2, "0")}`;
}

/**
 * The months of an academic year (or any range) from its first and last day (inclusive): the
 * calendar months it covers at least half of. Null when it covers no month that far (a range
 * shorter than ~half a month).
 */
export function academicYearMonths(startsOn: string, endsOn: string): MonthRange | null {
  const startIndex = monthIndex(startsOn);
  const endIndex = monthIndex(endsOn);
  const startDay = parts(startsOn)[2];
  const endDay = parts(endsOn)[2];

  const counts = (index: MonthIndex): boolean => {
    const days = daysInMonth(index);
    const from = index === startIndex ? startDay : 1;
    const to = index === endIndex ? Math.min(endDay, days) : days;
    return (to - from + 1) * 2 >= days;
  };

  let first = startIndex;
  while (first <= endIndex && !counts(first)) first += 1;
  let last = endIndex;
  while (last >= first && !counts(last)) last -= 1;
  return first <= last ? { first, last } : null;
}

/** How many months a range counts (0 for none). */
export function monthCount(range: MonthRange | null): number {
  return range ? range.last - range.first + 1 : 0;
}
