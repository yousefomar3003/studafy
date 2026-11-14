/**
 * How a license invoice is paid: at once, monthly over the license term, or on a custom schedule
 * the super admin sets on the quote. Pure, so the API (which stores the instalments) and the
 * calculator (which previews them) split money exactly the same way.
 *
 * Every amount is integer minor units; every date a UTC calendar date (YYYY-MM-DD). The instalments
 * of an invoice always add up to its total, exactly.
 */

export const PAYMENT_PLANS = ["in_full", "monthly", "custom"] as const;
export type PaymentPlan = (typeof PAYMENT_PLANS)[number];

/** A custom schedule's largest number of instalments (a monthly one has one per license month). */
export const MAX_CUSTOM_INSTALMENTS = 24;

export interface ScheduledInstalment {
  /** 1-based, in due-date order. */
  position: number;
  amountMinor: number;
  /** YYYY-MM-DD (UTC). */
  dueDate: string;
}

export interface CustomInstalmentInput {
  amountMinor: number;
  dueDate: string;
}

export type CustomScheduleError =
  "empty" | "too_many" | "invalid_date" | "non_positive" | "not_ascending" | "sum_mismatch";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** `date` plus `months` calendar months, kept on the last day of a shorter month (Jan 31 + 1 → Feb 28). */
export function addMonthsUtc(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * `totalMinor` in `count` parts as equal as whole minor units allow; the remainder goes on the first
 * part. Fewer parts when the total is smaller than `count` (every part is at least one minor unit),
 * and a single part of 0 for a total of 0.
 */
export function splitEvenly(totalMinor: number, count: number): number[] {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) throw new RangeError("total must be >= 0");
  if (totalMinor === 0) return [0];
  const parts = Math.max(1, Math.min(Math.floor(count), totalMinor));
  const base = Math.floor(totalMinor / parts);
  const amounts = Array.from({ length: parts }, () => base);
  amounts[0]! += totalMinor - base * parts;
  return amounts;
}

function latest(a: string, b: string): string {
  return a >= b ? a : b;
}

export interface ScheduleInput {
  plan: PaymentPlan;
  totalMinor: number;
  /** The license term in months: the number of monthly instalments. */
  months: number;
  /** YYYY-MM-DD: when the license (or what this quote adds to it) starts. */
  startDate: string;
  /** YYYY-MM-DD: the invoice's issue date. No instalment falls due before it. */
  issueDate: string;
  /** YYYY-MM-DD: when an invoice paid at once falls due (issue date + the due-days setting). */
  inFullDueDate: string;
  /** The custom schedule, for `plan: "custom"`. */
  custom?: readonly CustomInstalmentInput[] | null;
}

/**
 * The instalments of an invoice.
 *
 * - `in_full`: one instalment, due on `inFullDueDate` (today's behaviour).
 * - `monthly`: one per license month, due on the start date and the same day of each following
 *   month; any due date before the issue date moves to the issue date.
 * - `custom`: the super admin's amounts and dates (validated with `customScheduleErrors`); a date
 *   before the issue date moves to the issue date.
 */
export function buildSchedule(input: ScheduleInput): ScheduledInstalment[] {
  const { plan, totalMinor, issueDate } = input;
  if (plan === "in_full" || totalMinor === 0) {
    return [
      { position: 1, amountMinor: totalMinor, dueDate: latest(input.inFullDueDate, issueDate) },
    ];
  }
  if (plan === "monthly") {
    return splitEvenly(totalMinor, input.months).map((amountMinor, index) => ({
      position: index + 1,
      amountMinor,
      dueDate: latest(addMonthsUtc(input.startDate, index), issueDate),
    }));
  }
  const custom = input.custom ?? [];
  const errors = customScheduleErrors(totalMinor, custom);
  if (errors.length > 0) throw new RangeError(`invalid custom schedule: ${errors.join(", ")}`);
  return custom.map((instalment, index) => ({
    position: index + 1,
    amountMinor: instalment.amountMinor,
    dueDate: latest(instalment.dueDate, issueDate),
  }));
}

/** Everything wrong with a custom schedule for an invoice of `totalMinor`; empty when it is valid. */
export function customScheduleErrors(
  totalMinor: number,
  instalments: readonly CustomInstalmentInput[],
): CustomScheduleError[] {
  const errors = new Set<CustomScheduleError>();
  if (instalments.length === 0) errors.add("empty");
  if (instalments.length > MAX_CUSTOM_INSTALMENTS) errors.add("too_many");
  let previous: string | null = null;
  let sum = 0;
  for (const instalment of instalments) {
    if (!isDate(instalment.dueDate)) errors.add("invalid_date");
    else {
      if (previous !== null && instalment.dueDate < previous) errors.add("not_ascending");
      previous = instalment.dueDate;
    }
    if (!Number.isInteger(instalment.amountMinor) || instalment.amountMinor <= 0) {
      errors.add("non_positive");
    }
    sum += instalment.amountMinor;
  }
  if (instalments.length > 0 && sum !== totalMinor) errors.add("sum_mismatch");
  return [...errors];
}

export type InstalmentStatus = "due" | "partially_paid" | "paid";

export interface AllocatedInstalment {
  position: number;
  amountMinor: number;
  paidMinor: number;
  status: InstalmentStatus;
}

/**
 * Spread what has been paid on an invoice over its instalments, earliest first: each instalment is
 * filled before the next gets anything. Recomputed from the invoice's paid total on every payment and
 * every void, so voiding a payment re-applies the rest the same way.
 */
export function allocatePayments(
  instalments: readonly { position: number; amountMinor: number }[],
  paidMinor: number,
): AllocatedInstalment[] {
  let left = paidMinor;
  return [...instalments]
    .sort((a, b) => a.position - b.position)
    .map((instalment) => {
      const paid = Math.min(instalment.amountMinor, Math.max(0, left));
      left -= paid;
      const status: InstalmentStatus =
        paid === instalment.amountMinor ? "paid" : paid > 0 ? "partially_paid" : "due";
      return {
        position: instalment.position,
        amountMinor: instalment.amountMinor,
        paidMinor: paid,
        status,
      };
    });
}
