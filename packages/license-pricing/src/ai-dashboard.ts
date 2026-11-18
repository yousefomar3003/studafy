import { tierFor } from "./ai-programme";
import { BPS_SCALE, divideHalfUp, toSafeNumber } from "./money";

import type { AiProgrammeTier, ResolvedAiProgramme } from "./ai-programme";

/**
 * The figures the Student AI dashboards show (phase 6 of AI-REVSHARE-PLAN): where a school's
 * conversion stands and what reaching the next tier takes, the upload consistency teachers should
 * aim for, the school's margin on the Student AI line, and what Studafy keeps per seat. Pure, so the
 * API, the console and the tests reach the same numbers. Money in minor units, percentages in basis
 * points, rounding as the revenue share engine's (`./revenue-share.ts`).
 */

/**
 * The fewest extra opt-ins that take `optedIn / enrolled` (rounded down to a basis point, as
 * `ratioBps`) to at least `targetBps`: `ceil(targetBps x enrolled / 10_000) - optedIn`, never below
 * 0. Null when nobody is enrolled (no number of opt-ins changes a ratio over 0 students) or the
 * target is above 100%.
 */
export function optInsToReach(targetBps: number, enrolled: number, optedIn: number): number | null {
  if (enrolled <= 0 || targetBps > BPS_SCALE) return null;
  const needed = Math.ceil((targetBps * enrolled) / BPS_SCALE);
  return Math.max(0, needed - optedIn);
}

export type ConversionTierSettings = Pick<
  ResolvedAiProgramme,
  "conversionTiers" | "largeSchoolMinSeats" | "largeSchoolShareBps"
>;

export interface ConversionStandingInput {
  enrolled: number;
  optedIn: number;
  /** Student seats on the licence (the large-school floor's test). */
  seats: number;
}

export interface ConversionStanding {
  conversionBps: number;
  /** The conversion tier the ratio falls in (null below every tier). */
  tier: AiProgrammeTier | null;
  /** The conversion share: the tier's, raised to the large-school floor when the seats reach it. */
  shareBps: number;
  floorApplied: boolean;
  /**
   * The next tier that pays MORE than the share now (a tier the floor already beats is skipped), and
   * the extra opt-ins it takes ("Add 40 more seats -> unlock 10%"). Null at the top, or with nobody
   * enrolled.
   */
  next: (AiProgrammeTier & { optInsNeeded: number }) | null;
  /**
   * The large-school floor, when the licence is below its seat count and the floor pays more than
   * the share now: the seats still to add. Whichever of `next` and `floor` needs fewer is closer.
   */
  floor: { minSeats: number; shareBps: number; seatsNeeded: number } | null;
}

/** `optedIn / enrolled` in basis points, rounded down (the engine's `ratioBps`). */
function conversionOf(optedIn: number, enrolled: number): number {
  if (enrolled <= 0 || optedIn <= 0) return 0;
  if (optedIn >= enrolled) return BPS_SCALE;
  return Math.floor((optedIn * BPS_SCALE) / enrolled);
}

/** Where a school's conversion stands on its licence's tiers, and what the next step takes. */
export function conversionStanding(
  settings: ConversionTierSettings,
  input: ConversionStandingInput,
): ConversionStanding {
  const conversionBps = conversionOf(input.optedIn, input.enrolled);
  const tier = tierFor(settings.conversionTiers, conversionBps);
  const tierShare = tier?.shareBps ?? 0;
  const floorShare = input.seats >= settings.largeSchoolMinSeats ? settings.largeSchoolShareBps : 0;
  const shareBps = Math.max(tierShare, floorShare);
  const nextTier = [...settings.conversionTiers]
    .sort((a, b) => a.fromBps - b.fromBps)
    .find((t) => t.fromBps > conversionBps && t.shareBps > shareBps);
  const optInsNeeded = nextTier
    ? optInsToReach(nextTier.fromBps, input.enrolled, input.optedIn)
    : null;
  const floor =
    settings.largeSchoolShareBps > shareBps && input.seats < settings.largeSchoolMinSeats
      ? {
          minSeats: settings.largeSchoolMinSeats,
          shareBps: settings.largeSchoolShareBps,
          seatsNeeded: settings.largeSchoolMinSeats - input.seats,
        }
      : null;
  return {
    conversionBps,
    tier: tier ? { ...tier } : null,
    shareBps,
    floorApplied: floorShare > tierShare,
    next:
      nextTier && optInsNeeded !== null
        ? { fromBps: nextTier.fromBps, shareBps: nextTier.shareBps, optInsNeeded }
        : null,
    floor,
  };
}

/**
 * The upload consistency teachers should aim for: the next content-bonus tier that pays something
 * above where the school is, or, once the school is in the top tier, that tier's threshold (to stay
 * there). Null when no tier pays a bonus. A teacher below it is "below target" on the principal's
 * dashboard (60% / 80% with the defaults).
 */
export function contentBonusAimBps(
  tiers: readonly AiProgrammeTier[],
  consistencyBps: number | null,
): number | null {
  const paying = [...tiers].filter((t) => t.shareBps > 0).sort((a, b) => a.fromBps - b.fromBps);
  if (paying.length === 0) return null;
  const value = consistencyBps ?? -1;
  return (paying.find((t) => t.fromBps > value) ?? paying.at(-1)!).fromBps;
}

/**
 * The school's margin on Student AI months: (the parent's monthly price - the licence's monthly
 * price per seat) x months. Negative when parents pay less than the school does (allowed, with a
 * warning, in the settings).
 */
export function studentAiMarginOf(
  parentMonthlyMinor: number,
  licenseMonthlyMinor: number,
  months: number,
): number {
  return (parentMonthlyMinor - licenseMonthlyMinor) * months;
}

/**
 * The part of `amountMinor` a parent has paid, when the invoice it is on is `paidMinor` of
 * `totalMinor` paid: pro rata, half up; all of it once the invoice is paid, none on an unpaid or
 * empty one. A line's share of a part-paid invoice is not known from ERPNext's totals, so a part
 * payment is spread evenly over the invoice's lines.
 */
export function paidPartOf(amountMinor: number, paidMinor: number, totalMinor: number): number {
  if (totalMinor <= 0 || paidMinor <= 0) return 0;
  if (paidMinor >= totalMinor) return amountMinor;
  const sign = amountMinor < 0 ? -1n : 1n;
  const magnitude = BigInt(Math.abs(amountMinor));
  return toSafeNumber(sign * divideHalfUp(magnitude * BigInt(paidMinor), BigInt(totalMinor)));
}

export interface StudafyNet {
  /** What Studafy collected for Student AI seats less the revenue share it gave back. */
  netMinor: number;
  /** Per student seat, half up; null with no seats. */
  perSeatMinor: number | null;
}

/** What Studafy keeps: collected (the Student AI part) - the revenue share, in total and per seat. */
export function studafyNetOf(input: {
  collectedMinor: number;
  shareMinor: number;
  seats: number;
}): StudafyNet {
  const netMinor = input.collectedMinor - input.shareMinor;
  if (input.seats <= 0) return { netMinor, perSeatMinor: null };
  const sign = netMinor < 0 ? -1n : 1n;
  return {
    netMinor,
    perSeatMinor: toSafeNumber(
      sign * divideHalfUp(BigInt(Math.abs(netMinor)), BigInt(input.seats)),
    ),
  };
}
