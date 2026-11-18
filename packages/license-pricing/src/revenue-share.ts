import { academicYearMonths, monthCount, monthEnd, monthStart } from "./academic-months";
import { previewRevenueShare } from "./ai-programme";
import { BPS_SCALE, divideHalfUp, toSafeNumber } from "./money";
import { addMonthsUtc, licenceYears } from "./schedule";

import type { LicenseCommitment } from "./ai-optin";
import type { ResolvedAiProgramme } from "./ai-programme";
import type { PaymentPlan } from "./schedule";

/**
 * The Student AI revenue share on money Studafy collected (phase 5 of AI-REVSHARE-PLAN,
 * docs/billing/ai-programme.md "Revenue share engine"). Pure: the API and the workers store what
 * these functions return, so a share is worked out the same way wherever it is computed.
 *
 * ## The rule
 *
 *   conversion share = the conversion tier of the measured conversion (locked on the measurement
 *                      date), raised to the large-school floor when the licence has enough seats;
 *   content bonus    = the upload-consistency tier, counted only when the conversion share is above
 *                      0% (when the settings say so);
 *   full-year share  = conversion share + bonus, capped at the maximum share;
 *   total share      = the full-year share, or for a month-to-month licence that share scaled by
 *                      monthToMonthShareBps (0 by default, so 0%);
 *   amount           = the Student AI part of what was collected x the total share.
 *
 * Every value comes from the settings the licence was signed with (`ResolvedAiProgramme`); nothing
 * here knows a default price, tier or month count.
 *
 * ## Rounding (one rule per step, all integer, half up)
 *
 *   * Conversion and upload consistency: `numerator x 10_000 / denominator` rounded DOWN to a whole
 *     basis point (`ratioBps`). A school at 69.99% is in the 55-69% tier, never pushed up into 70%.
 *   * A month-to-month total: `full-year bps x monthToMonthShareBps / 10_000`, rounded half up to a
 *     whole basis point (as the console's preview, `previewRevenueShare`).
 *   * The Student AI part of a payment that also pays for other seats (`studentPartOf`):
 *     `collected x student seat lines / all seat lines`, rounded half up to a whole minor unit.
 *   * The amount: `base x total bps / 10_000`, rounded half up to a whole minor unit, in BigInt. One
 *     amount per entry (a payment's part of one instalment), so a licence's total share can differ
 *     from the share of its total by at most half a minor unit per entry.
 */

/** `numerator / denominator` as basis points, rounded down, within 0..10_000. 0 when nothing to divide by. */
export function ratioBps(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new RangeError("ratio parts must be whole numbers");
  }
  if (denominator <= 0 || numerator <= 0) return 0;
  if (numerator >= denominator) return BPS_SCALE;
  return Number((BigInt(numerator) * BigInt(BPS_SCALE)) / BigInt(denominator));
}

/** YYYY-MM-DD `days` after `date` (UTC calendar dates). */
export function addDaysUtc(date: string, days: number): string {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The day conversion is measured, and its tier locked: the period's first day + the offset. */
export function measurementDateOf(periodStart: string, measurementOffsetDays: number): string {
  return addDaysUtc(periodStart, measurementOffsetDays);
}

/**
 * The Student AI part of `collectedMinor` when the invoice also charges for other seats: in
 * proportion to the student seat lines among all seat lines (half up). All of it when the invoice
 * has only student seats, none when it has none.
 */
export function studentPartOf(
  collectedMinor: number,
  studentLinesMinor: number,
  seatLinesMinor: number,
): number {
  if (collectedMinor <= 0 || studentLinesMinor <= 0 || seatLinesMinor <= 0) return 0;
  if (studentLinesMinor >= seatLinesMinor) return collectedMinor;
  return toSafeNumber(
    divideHalfUp(BigInt(collectedMinor) * BigInt(studentLinesMinor), BigInt(seatLinesMinor)),
  );
}

export type RevenueShareSettings = Pick<
  ResolvedAiProgramme,
  | "maxShareBps"
  | "conversionTiers"
  | "largeSchoolMinSeats"
  | "largeSchoolShareBps"
  | "contentBonusTiers"
  | "bonusRequiresConversionShare"
  | "monthToMonthShareBps"
>;

export interface RevenueShareInput {
  /** Opted in / enrolled on the measurement date, locked. Null while it is not locked yet. */
  conversionBps: number | null;
  /** School days with an upload / school days over the period paid for. Null while unknown. */
  uploadConsistencyBps: number | null;
  /** Student seats on the licence when conversion was measured (the large-school floor's test). */
  seats: number;
  commitment: LicenseCommitment;
  /** The Student AI part of the money Studafy collected, in minor units. */
  baseMinor: number;
}

export interface RevenueShareResult {
  conversionShareBps: number;
  /** The large-school floor raised the conversion share. */
  floorApplied: boolean;
  bonusBps: number;
  /** Conversion share + bonus, capped. */
  fullYearBps: number;
  /** The cap cut it. */
  capped: boolean;
  /** 10_000 for a full-year licence; monthToMonthShareBps for a month-to-month one. */
  multiplierBps: number;
  totalBps: number;
  amountMinor: number;
  /** Conversion is not locked yet: what is shown counts it as 0%. */
  conversionPending: boolean;
  /** Upload consistency is not known yet and could change the share: the bonus is shown as 0%. */
  bonusPending: boolean;
  /** Nothing is pending: this is the share. */
  final: boolean;
}

/** `base x bps / 10_000`, half up, in BigInt. */
export function shareAmountOf(baseMinor: number, totalBps: number): number {
  if (!Number.isSafeInteger(baseMinor) || baseMinor < 0) throw new RangeError("base must be >= 0");
  if (!Number.isInteger(totalBps) || totalBps < 0 || totalBps > BPS_SCALE) {
    throw new RangeError("share must be 0..10000 bps");
  }
  return toSafeNumber(divideHalfUp(BigInt(baseMinor) * BigInt(totalBps), BigInt(BPS_SCALE)));
}

/**
 * The share on one collected amount. With a part still unknown (conversion not locked, upload
 * consistency not measured) it is worked out with that part at 0% and flagged pending -- unless the
 * unknown part cannot change the result (a month-to-month licence earning 0%; a bonus ruled out by a
 * 0% conversion share, with no tier above 0%, or with the conversion share already at the cap), in
 * which case it is final.
 */
export function computeRevenueShare(
  settings: RevenueShareSettings,
  input: RevenueShareInput,
): RevenueShareResult {
  const fullYear = input.commitment === "full_year";
  const shares = previewRevenueShare(settings, {
    conversionBps: input.conversionBps ?? 0,
    uploadConsistencyBps: input.uploadConsistencyBps ?? 0,
    seats: input.seats,
    fullYear: true,
  });
  const multiplierBps = fullYear ? BPS_SCALE : settings.monthToMonthShareBps;
  const totalBps = fullYear
    ? shares.totalBps
    : toSafeNumber(
        divideHalfUp(BigInt(shares.totalBps) * BigInt(multiplierBps), BigInt(BPS_SCALE)),
      );

  const nothingToEarn = multiplierBps === 0;
  const conversionPending = !nothingToEarn && input.conversionBps === null;
  // The bonus can only change the share when it is counted and has room: not with a known 0%
  // conversion share under the bonus rule, not when every bonus tier is 0%, and not when the
  // conversion share alone already reaches the cap.
  const maxBonusBps = Math.max(0, ...settings.contentBonusTiers.map((tier) => tier.shareBps));
  const bonusCannotMatter =
    maxBonusBps === 0 ||
    (!conversionPending &&
      ((settings.bonusRequiresConversionShare && shares.conversionShareBps === 0) ||
        shares.conversionShareBps >= settings.maxShareBps));
  const bonusPending = !nothingToEarn && !bonusCannotMatter && input.uploadConsistencyBps === null;

  return {
    conversionShareBps: shares.conversionShareBps,
    floorApplied: shares.floorApplied,
    bonusBps: shares.bonusBps,
    fullYearBps: shares.totalBps,
    capped: shares.capped,
    multiplierBps,
    totalBps,
    amountMinor: shareAmountOf(input.baseMinor, totalBps),
    conversionPending,
    bonusPending,
    final: !conversionPending && !bonusPending,
  };
}

// ---------------------------------------------------------------------------------------------------
// What an instalment pays for
// ---------------------------------------------------------------------------------------------------

export interface InstalmentPeriodInput {
  plan: PaymentPlan;
  /** YYYY-MM-DD: the first day the invoice pays for. */
  startDate: string;
  /** YYYY-MM-DD: the day after the last day it pays for. */
  endDate: string;
  /** The months the schedule was spread over (scheduleMonths). */
  months: number;
  /** The invoice's instalments, in position order, with their due dates. */
  instalments: readonly { position: number; dueDate: string }[];
}

export interface InstalmentPeriod {
  position: number;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive. */
  to: string;
}

/**
 * The days each instalment pays for -- the school days whose uploads give a payment its content
 * bonus. A monthly plan: instalment k is the term's k-th month by THE month rule
 * (`academicYearMonths`, a calendar month counts when the term covers at least half of it -- the
 * months the licence, the parent's opt-in and the tuition line count), the first stretched back to
 * the term's first day and the last on to its last day; when the term's counted months do not match
 * the instalments (a term the rule counts differently from the schedule), licence month k from the
 * start date. Yearly: licence year k. At once: the whole term. Custom: from its due date (the term's
 * start for the first) to the day before the next one's (the term's end for the last). Always within
 * the term; when the instalments do not match the plan (edited by hand), each pays for the whole
 * term.
 */
export function instalmentPeriods(input: InstalmentPeriodInput): InstalmentPeriod[] {
  const start = input.startDate.slice(0, 10);
  const last = addDaysUtc(input.endDate, -1) < start ? start : addDaysUtc(input.endDate, -1);
  const clamp = (from: string, to: string) => {
    const f = from < start ? start : from > last ? last : from;
    const t = to > last ? last : to < f ? f : to;
    return { from: f, to: t };
  };
  const ordered = [...input.instalments].sort((a, b) => a.position - b.position);
  const whole = () => ordered.map((i) => ({ position: i.position, from: start, to: last }));

  if (input.plan === "in_full" || ordered.length <= 1) return whole();
  if (input.plan === "monthly") {
    const counted = academicYearMonths(start, last);
    if (counted && monthCount(counted) === ordered.length) {
      return ordered.map((instalment, index) => {
        const month = counted.first + index;
        return {
          position: instalment.position,
          ...clamp(
            index === 0 ? start : monthStart(month),
            index === ordered.length - 1 ? last : monthEnd(month),
          ),
        };
      });
    }
    if (ordered.length !== Math.max(1, input.months)) return whole();
    return ordered.map((instalment, index) => ({
      position: instalment.position,
      ...clamp(addMonthsUtc(start, index), addDaysUtc(addMonthsUtc(start, index + 1), -1)),
    }));
  }
  if (input.plan === "yearly") {
    const years = licenceYears(start, input.months);
    if (years.length !== ordered.length) return whole();
    return ordered.map((instalment, index) => ({
      position: instalment.position,
      ...clamp(years[index]!.startDate, addDaysUtc(years[index]!.endDate, -1)),
    }));
  }
  return ordered.map((instalment, index) => {
    const next = ordered[index + 1];
    return {
      position: instalment.position,
      ...clamp(
        index === 0 ? start : instalment.dueDate.slice(0, 10),
        next ? addDaysUtc(next.dueDate, -1) : last,
      ),
    };
  });
}
