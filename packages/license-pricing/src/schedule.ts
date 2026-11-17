/**
 * How a license invoice is paid: at once, monthly over the license term, once per licence year, or
 * on a custom schedule. The school proposes the length and the plan when it asks for a licence
 * (a custom plan as dates and shares of the total, since it has no price yet); the super admin
 * prices the quote, keeping the school's choice or changing it with a reason. Pure, so the API (which stores the instalments) and the
 * calculator (which previews them) split money exactly the same way.
 *
 * Every amount is integer minor units; every date a UTC calendar date (YYYY-MM-DD). The instalments
 * of an invoice always add up to its total, exactly.
 */

export const PAYMENT_PLANS = ["in_full", "monthly", "yearly", "custom"] as const;
export type PaymentPlan = (typeof PAYMENT_PLANS)[number];

/** The plans a school chooses from when it asks for a licence. */
export const SCHOOL_PAYMENT_PLANS = ["monthly", "yearly", "custom"] as const;
export type SchoolPaymentPlan = (typeof SCHOOL_PAYMENT_PLANS)[number];

/** The licence lengths a school may ask for, in months (the super admin may quote up to 120). */
export const MIN_REQUEST_MONTHS = 1;
export const MAX_REQUEST_MONTHS = 36;

/** A share of the total in basis points: 10_000 is all of it. */
export const SHARE_SCALE = 10_000;

const MONTHS_IN_YEAR = 12;

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
  const [year, month, day] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
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
 * - `yearly`: one per licence year, due on the start date and each anniversary; each year pays for
 *   its own months (a 13-month licence is 12/13 then 1/13 of the total). A due date before the
 *   issue date moves to the issue date.
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
  if (plan === "yearly") {
    const years = licenceYears(input.startDate, input.months);
    const amounts = splitByLicenceYears(totalMinor, input.months);
    return years
      .map((year, index) => ({ amountMinor: amounts[index]!, dueDate: year.startDate }))
      .filter((instalment) => instalment.amountMinor > 0)
      .map((instalment, index) => ({
        position: index + 1,
        amountMinor: instalment.amountMinor,
        dueDate: latest(instalment.dueDate, issueDate),
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

/**
 * The months a payment schedule spreads over: the term, or for a seat increase (charged for the days
 * left) the months left, to the nearest month, so no instalment falls long after the licence ends.
 */
export function scheduleMonths(months: number, prorateDays: number | null): number {
  return prorateDays === null ? months : Math.max(1, Math.round(prorateDays / (365.25 / 12)));
}

// ---------------------------------------------------------------------------------------------------
// Licence years
// ---------------------------------------------------------------------------------------------------

/** One year of a licence term: the last one may be shorter (a 13-month licence is 12 + 1). */
export interface LicenceYear {
  /** 1-based. */
  year: number;
  /** YYYY-MM-DD, the first day of this licence year. */
  startDate: string;
  /** YYYY-MM-DD, the day after its last day (the next year's start, or the term's end). */
  endDate: string;
  months: number;
}

/** The licence years of a term of `months` from `startDate` (anniversaries keep the start day). */
export function licenceYears(startDate: string, months: number): LicenceYear[] {
  const start = startDate.slice(0, 10);
  const total = Math.max(1, Math.floor(months));
  const years: LicenceYear[] = [];
  for (let first = 0, year = 1; first < total; first += MONTHS_IN_YEAR, year += 1) {
    const length = Math.min(MONTHS_IN_YEAR, total - first);
    years.push({
      year,
      startDate: addMonthsUtc(start, first),
      endDate: addMonthsUtc(start, first + length),
      months: length,
    });
  }
  return years;
}

/**
 * `totalMinor` over the licence years, each year in proportion to its months; the rounding
 * remainder goes on the first year. Always adds up to the total.
 */
export function splitByLicenceYears(totalMinor: number, months: number): number[] {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) throw new RangeError("total must be >= 0");
  const total = Math.max(1, Math.floor(months));
  const lengths: number[] = [];
  for (let first = 0; first < total; first += MONTHS_IN_YEAR) {
    lengths.push(Math.min(MONTHS_IN_YEAR, total - first));
  }
  const amounts = lengths.map((length) =>
    Number((BigInt(totalMinor) * BigInt(length)) / BigInt(total)),
  );
  amounts[0]! += totalMinor - amounts.reduce((sum, amount) => sum + amount, 0);
  return amounts;
}

/** What is paid in one licence year: the instalments falling due in it. */
export interface LicenceYearTotal extends LicenceYear {
  amountMinor: number;
  /** How many instalments fall due in this year. */
  payments: number;
}

/**
 * The total due in each licence year: every instalment counted in the year its due date falls in. One
 * due before the licence starts (paid ahead) counts in year 1; one due after it ends, in the last year.
 */
export function yearTotals(
  instalments: readonly { amountMinor: number; dueDate: string }[],
  startDate: string,
  months: number,
): LicenceYearTotal[] {
  const years = licenceYears(startDate, months).map((year) => ({
    ...year,
    amountMinor: 0,
    payments: 0,
  }));
  for (const instalment of instalments) {
    const due = instalment.dueDate.slice(0, 10);
    let index = 0;
    for (let i = 0; i < years.length; i += 1) if (years[i]!.startDate <= due) index = i;
    years[index]!.amountMinor += instalment.amountMinor;
    years[index]!.payments += 1;
  }
  return years;
}

// ---------------------------------------------------------------------------------------------------
// The school's custom proposal: dates and shares, before there is a price
// ---------------------------------------------------------------------------------------------------

/** One payment a school proposes: when, and what share of the (not yet priced) total. */
export interface ProposedInstalment {
  /** YYYY-MM-DD. */
  dueDate: string;
  /** Basis points of the total (SHARE_SCALE is all of it). */
  shareBps: number;
}

export type ProposalError =
  | "empty"
  | "too_many"
  | "invalid_date"
  | "non_positive"
  | "not_ascending"
  | "share_mismatch"
  | "before_today"
  | "after_term";

/**
 * Everything wrong with a school's custom proposal; empty when it is valid. The shares add up to the
 * whole total; the dates are in order, from today, and before the term ends (`termEnd`, exclusive).
 */
export function proposalErrors(
  proposal: readonly ProposedInstalment[],
  bounds: { today: string; termEnd: string },
): ProposalError[] {
  const errors = new Set<ProposalError>();
  if (proposal.length === 0) errors.add("empty");
  if (proposal.length > MAX_CUSTOM_INSTALMENTS) errors.add("too_many");
  let previous: string | null = null;
  let sum = 0;
  for (const instalment of proposal) {
    if (!isDate(instalment.dueDate)) errors.add("invalid_date");
    else {
      if (previous !== null && instalment.dueDate < previous) errors.add("not_ascending");
      if (instalment.dueDate < bounds.today) errors.add("before_today");
      if (instalment.dueDate >= bounds.termEnd.slice(0, 10)) errors.add("after_term");
      previous = instalment.dueDate;
    }
    if (!Number.isInteger(instalment.shareBps) || instalment.shareBps <= 0) {
      errors.add("non_positive");
    }
    sum += instalment.shareBps;
  }
  if (proposal.length > 0 && sum !== SHARE_SCALE) errors.add("share_mismatch");
  return [...errors];
}

/**
 * A proposal priced: each share of `totalMinor` rounded down, the remainder on the first instalment,
 * so the amounts always add up to the total. The custom schedule the super admin's quote starts from.
 */
export function amountsFromShares(
  totalMinor: number,
  proposal: readonly ProposedInstalment[],
): CustomInstalmentInput[] {
  if (!Number.isInteger(totalMinor) || totalMinor < 0) throw new RangeError("total must be >= 0");
  const amounts = proposal.map((instalment) =>
    Number((BigInt(totalMinor) * BigInt(instalment.shareBps)) / BigInt(SHARE_SCALE)),
  );
  if (amounts.length > 0) {
    amounts[0]! += totalMinor - amounts.reduce((sum, amount) => sum + amount, 0);
  }
  return proposal.map((instalment, index) => ({
    amountMinor: amounts[index]!,
    dueDate: instalment.dueDate,
  }));
}

/**
 * `count` payments spread evenly over a term, in equal shares: the first on `startDate`, the rest every
 * `months / count` months after it (to the nearest month). Where the school's custom plan starts.
 */
export function evenProposal(
  startDate: string,
  months: number,
  count: number,
): ProposedInstalment[] {
  const parts = Math.max(1, Math.min(Math.floor(count), MAX_CUSTOM_INSTALMENTS));
  const shares = splitEvenly(SHARE_SCALE, parts);
  const span = Math.max(1, Math.floor(months));
  return shares.map((shareBps, index) => ({
    dueDate: addMonthsUtc(startDate, Math.floor((index * span) / parts)),
    shareBps,
  }));
}

// ---------------------------------------------------------------------------------------------------
// The school's choice against the super admin's offer
// ---------------------------------------------------------------------------------------------------

/** What the school asked for: each part null when it left it to Studafy. */
export interface RequestedTerms {
  months: number | null;
  /** YYYY-MM-DD. */
  startDate: string | null;
  paymentPlan: PaymentPlan | null;
  proposal: readonly ProposedInstalment[] | null;
}

/** What the quote offers. `months`/`startDate` are null where the quote kind fixes them. */
export interface OfferedTerms {
  months: number | null;
  startDate: string | null;
  paymentPlan: PaymentPlan;
  custom: readonly CustomInstalmentInput[] | null;
  totalMinor: number;
}

export type TermsChange = "months" | "start" | "plan" | "schedule";

/**
 * Where the super admin's offer departs from what the school asked for (each needs a reason). A
 * custom schedule matches when it is the school's dates with its shares of the total.
 */
export function termsChanges(requested: RequestedTerms, offered: OfferedTerms): TermsChange[] {
  const changes: TermsChange[] = [];
  if (requested.months !== null && offered.months !== null && requested.months !== offered.months) {
    changes.push("months");
  }
  if (
    requested.startDate !== null &&
    offered.startDate !== null &&
    requested.startDate.slice(0, 10) !== offered.startDate.slice(0, 10)
  ) {
    changes.push("start");
  }
  if (requested.paymentPlan !== null && requested.paymentPlan !== offered.paymentPlan) {
    changes.push("plan");
  } else if (requested.paymentPlan === "custom" && requested.proposal) {
    const expected = amountsFromShares(offered.totalMinor, requested.proposal);
    const custom = offered.custom ?? [];
    const same =
      custom.length === expected.length &&
      custom.every(
        (instalment, index) =>
          instalment.amountMinor === expected[index]!.amountMinor &&
          instalment.dueDate === expected[index]!.dueDate,
      );
    if (!same) changes.push("schedule");
  }
  return changes;
}
