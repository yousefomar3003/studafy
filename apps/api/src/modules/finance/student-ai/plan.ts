/**
 * The Student AI line's arithmetic (phase 3 of the AI revenue-share programme): which months an
 * opted-in student is charged for, and how that amount is spread over their tuition instalments.
 * Pure functions over plain values, so every rule is tested without a database
 * (docs/billing/student-ai-tuition-line.md).
 *
 * ## Months follow the school's academic year
 *
 * Nothing assumes 10. A calendar month belongs to the academic year when the year covers at least
 * half of its days: 1 Sep - 30 Jun is 10 months, 1 Sep - 30 Apr is 8, and a year that starts on
 * 25 Aug does not charge a whole August for its last week. A student is charged from their start
 * month (never before the year's first month) to the year's last month, or to the month before a
 * released or transferred seat stops.
 *
 * ## Spreading over instalments (whole months, so no rounding)
 *
 * The instalments considered are the student's own tuition instalments (their fee schedules) whose
 * due date falls in or after the start month and no later than the year's last month. Each charged
 * month is paid by the latest of those instalments due in or before it -- an instalment pays for
 * the months from its due date up to the next one, as tuition is paid in advance -- and months
 * before the first instalment are paid by the first. A portion is therefore a whole number of
 * months, and its amount is the monthly price times that number, already in minor units: uneven
 * splits (4 + 3 + 3 months) need no rounding, and the portions always add up to the total exactly.
 * A student with no instalment in that range pays month by month, each month due on its first day.
 *
 * Months already on an invoice are never planned again, and when auto-billing was switched back on
 * mid-year, months before that are the school's to bill (they are not planned either).
 */

import { academicYearMonths, monthIndex, monthKey, monthStart } from "@studafy/license-pricing";

import type { MonthIndex, MonthRange } from "@studafy/license-pricing";

// The month rule lives in @studafy/license-pricing (academic-months.ts) so phase 2's opt-in and
// phase 5's revenue share periods count exactly the same months as this line.
export { academicYearMonths, monthIndex, monthKey, monthStart };
export type { MonthIndex, MonthRange };

export interface PortionPlan {
  /** ISO date. */
  dueDate: string;
  /** First day of the first month paid, ISO date. */
  firstMonth: string;
  monthCount: number;
  amountMinor: number;
}

/**
 * The months a student is charged for: from the start month (not before the year's first month)
 * to the year's last month, stopping before `stopMonth` when the seat was released or transferred.
 */
export function chargedMonths(
  year: MonthRange,
  startMonth: MonthIndex,
  stopMonth: MonthIndex | null,
): MonthIndex[] {
  const from = Math.max(year.first, startMonth);
  const to = stopMonth === null ? year.last : Math.min(year.last, stopMonth - 1);
  const months: MonthIndex[] = [];
  for (let month = from; month <= to; month += 1) months.push(month);
  return months;
}

export interface AllocateInput {
  year: MonthRange;
  /** The student's start month (before clamping to the year). */
  startMonth: MonthIndex;
  /** What the student is charged for (chargedMonths). */
  charged: readonly MonthIndex[];
  /** The due dates of the student's tuition instalments, any order, duplicates allowed. */
  instalmentDueDates: readonly string[];
  monthlyPriceMinor: number;
  /** Months an invoice already carries. */
  billedMonths?: ReadonlySet<MonthIndex>;
  /** Months before this one are billed by the school itself (auto-billing switched back on). */
  billingFrom?: MonthIndex | null;
}

/** The planned portions for the months still to bill, ordered by due date then month. */
export function allocatePortions(input: AllocateInput): PortionPlan[] {
  const billed = input.billedMonths ?? new Set<MonthIndex>();
  const billingFrom = input.billingFrom ?? null;
  const toPlan = input.charged.filter(
    (month) => !billed.has(month) && (billingFrom === null || month >= billingFrom),
  );
  if (toPlan.length === 0) return [];

  const startIndex = Math.max(input.year.first, input.startMonth);
  const instalments = [...new Set(input.instalmentDueDates)]
    .filter((date) => {
      const month = monthIndex(date);
      return month >= startIndex && month <= input.year.last;
    })
    .sort();

  // Each month's due date: its instalment, or its own first day when there is none.
  const dueOf = (month: MonthIndex): string => {
    if (instalments.length === 0) return monthStart(month);
    let chosen = instalments[0]!;
    for (const date of instalments) {
      if (monthIndex(date) <= month) chosen = date;
    }
    return chosen;
  };

  // One portion per run of consecutive months sharing a due date.
  const portions: PortionPlan[] = [];
  let run: { dueDate: string; first: MonthIndex; count: number } | null = null;
  const flush = () => {
    if (!run) return;
    portions.push({
      dueDate: run.dueDate,
      firstMonth: monthStart(run.first),
      monthCount: run.count,
      amountMinor: input.monthlyPriceMinor * run.count,
    });
  };
  for (const month of [...toPlan].sort((a, b) => a - b)) {
    const dueDate = dueOf(month);
    if (run && run.dueDate === dueDate && run.first + run.count === month) {
      run.count += 1;
    } else {
      flush();
      run = { dueDate, first: month, count: 1 };
    }
  }
  flush();

  return portions.sort((a, b) =>
    a.dueDate === b.dueDate
      ? a.firstMonth.localeCompare(b.firstMonth)
      : a.dueDate.localeCompare(b.dueDate),
  );
}

/** The months a portion pays for. */
export function portionMonths(firstMonth: string, monthCount: number): MonthIndex[] {
  const first = monthIndex(firstMonth);
  return Array.from({ length: monthCount }, (_, i) => first + i);
}

/** Order-insensitive identity of a set of portions, to tell whether a plan changed. */
export function portionsFingerprint(portions: readonly PortionPlan[]): string {
  return portions
    .map((p) => `${p.dueDate}|${p.firstMonth}|${p.monthCount}|${p.amountMinor}`)
    .sort()
    .join(";");
}
