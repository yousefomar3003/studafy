/**
 * The monthly window an AI token budget is counted in.
 *
 * The budget is per month, but the grant behind it can be longer: a yearly AI add-on, or a
 * school-license seat that covers the whole school year. Counting against the grant's own period
 * would give a yearly student one month's budget for the entire year. So the grant period is cut
 * into consecutive one-month windows, each counted under its own meter key (the key is the
 * window's start date), and the budget resets at the start of every window.
 *
 * Rules:
 *   - Window n starts at periodStart + n calendar months (always from the anchor, so a 31st does
 *     not drift to the 28th and stay there) and ends one month later, or at periodEnd.
 *   - A last window shorter than {@link SHORT_TAIL_DAYS} is folded into the one before it. A
 *     monthly subscription whose provider counts the month a day differently, or a license that
 *     ends a few days past a month boundary, then stays one window instead of gaining a bonus
 *     budget for a couple of days.
 *   - When the window is the whole grant period (every monthly subscription), the period strings
 *     come back unchanged, so the meter key is the same one it has always been.
 *   - A clock outside the period (the gate refuses those before metering anyway) is clamped to
 *     the first or last window.
 */

const SHORT_TAIL_DAYS = 7;
const DAY_MS = 86_400_000;

export interface BudgetWindow {
  periodStart: string;
  periodEnd: string;
}

/** `date` plus `months` calendar months in UTC, clamping the day to the target month's length. */
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export function monthlyBudgetWindow(
  periodStart: string,
  periodEnd: string,
  now: Date = new Date(),
): BudgetWindow {
  const start = new Date(periodStart);
  const endMs = Date.parse(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endMs) || endMs <= start.getTime()) {
    return { periodStart, periodEnd };
  }

  // Only windows that begin before the cut-off are real; anything later is a short tail.
  const lastStartBefore = endMs - SHORT_TAIL_DAYS * DAY_MS;
  const clock = Math.min(Math.max(now.getTime(), start.getTime()), endMs - 1);

  let n = 0;
  while (true) {
    const next = addMonths(start, n + 1).getTime();
    if (next > clock || next >= lastStartBefore) break;
    n += 1;
  }

  const windowStart = addMonths(start, n);
  const nextStart = addMonths(start, n + 1).getTime();
  const windowEndMs = nextStart >= lastStartBefore ? endMs : nextStart;

  if (n === 0 && windowEndMs === endMs) return { periodStart, periodEnd };
  return {
    periodStart: n === 0 ? periodStart : windowStart.toISOString(),
    periodEnd: windowEndMs === endMs ? periodEnd : new Date(windowEndMs).toISOString(),
  };
}
