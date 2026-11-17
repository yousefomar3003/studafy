import { applyBps, BPS_SCALE } from "./money";

/**
 * The Student AI programme's settings (docs/billing/ai-programme.md, phase 1 of
 * AI-REVSHARE-PLAN): what parents, schools and the stores are charged for Student AI, and how the
 * school's revenue share is worked out. Every number is the super admin's to change.
 *
 * The settings live in versions: a global version (every field, with prices per currency) and,
 * per school, an override version (any subset of the fields). `resolveAiProgramme` merges the two
 * for one currency: the school's value wins wherever it has one. Licences and quotes keep the pair of
 * versions they were signed with, so resolving that pair again always gives the same values.
 *
 * Pure, like the rest of this package: no database and no clock, so the API, the workers and the
 * console all validate and resolve the same way. Money is whole minor units of the currency and
 * percentages are basis points (10_000 = 100%), as everywhere else in the package.
 */

export const AI_PROGRAMME_PAYOUT_MODES = ["invoice_credit", "payout"] as const;
/** How the revenue share is given: a credit on the school's next invoice, or paid out. */
export type AiProgrammePayoutMode = (typeof AI_PROGRAMME_PAYOUT_MODES)[number];

export const AI_PROGRAMME_TIER_KINDS = ["conversion", "content_bonus"] as const;
export type AiProgrammeTierKind = (typeof AI_PROGRAMME_TIER_KINDS)[number];

/** Bounds a value must stay within. Wide on purpose: they catch typos, not business choices. */
export const AI_PROGRAMME_LIMITS = {
  /** Any price, in minor units (1,000,000.00 in a two-decimal currency). */
  maxPriceMinor: 100_000_000,
  minSeats: { min: 1, max: 100_000 },
  largeSchoolMinSeats: { min: 1, max: 1_000_000 },
  measurementOffsetDays: { min: 0, max: 365 },
  nonpaymentGraceDays: { min: 1, max: 365 },
  /** Rows in one tier table. */
  maxTiers: 20,
  /** Currencies priced in one global version. */
  maxCurrencies: 50,
  reasonMaxLength: 1000,
} as const;

/** A tier: from `fromBps` (conversion or upload consistency, inclusive) up, `shareBps`. */
export interface AiProgrammeTier {
  fromBps: number;
  shareBps: number;
}

/** The three prices in one currency, per student (or seat) per month. */
export interface AiProgrammePrice {
  currencyCode: string;
  /** The Student AI in-app purchase. Display and calculations only: the stores set the real one. */
  iapPriceMinor: number;
  /** What the school pays Studafy per seat per month. */
  licensePriceMinor: number;
  /** What parents see per month on the tuition line. */
  parentPriceMinor: number;
}

/** A complete set of settings: a global version. */
export interface AiProgrammeSettings {
  prices: readonly AiProgrammePrice[];
  /** The school pays for at least this many seats. */
  minSeats: number;
  /** The revenue share never goes above this. */
  maxShareBps: number;
  /** Conversion (opted in / enrolled) -> share. Starts at 0, rising. */
  conversionTiers: readonly AiProgrammeTier[];
  /** A licence with at least this many seats ... */
  largeSchoolMinSeats: number;
  /** ... gets at least this conversion share (0 turns the floor off). */
  largeSchoolShareBps: number;
  /** Upload consistency -> bonus on top of the conversion share. Starts at 0, rising. */
  contentBonusTiers: readonly AiProgrammeTier[];
  /** The bonus applies only when the conversion share is above 0. */
  bonusRequiresConversionShare: boolean;
  /** Conversion is measured (and the tier locked) this many days after the licence starts. */
  measurementOffsetDays: number;
  /** Student AI stops this many days after an instalment goes unpaid (000233). */
  nonpaymentGraceDays: number;
  /**
   * A month-to-month (cancellable) licence earns this share of the full-year share: 0 none (the
   * default), 5000 half, 10000 the same.
   */
  monthToMonthShareBps: number;
  payoutMode: AiProgrammePayoutMode;
}

/**
 * A school's override: `null` keeps the global value. The prices are in `priceCurrencyCode` (the
 * school's currency when they were set) and apply only to that currency. The in-app purchase price
 * has no override: a store price is the same for everyone.
 */
export interface AiProgrammeOverride {
  priceCurrencyCode: string | null;
  licensePriceMinor: number | null;
  parentPriceMinor: number | null;
  minSeats: number | null;
  maxShareBps: number | null;
  conversionTiers: readonly AiProgrammeTier[] | null;
  largeSchoolMinSeats: number | null;
  largeSchoolShareBps: number | null;
  contentBonusTiers: readonly AiProgrammeTier[] | null;
  bonusRequiresConversionShare: boolean | null;
  measurementOffsetDays: number | null;
  nonpaymentGraceDays: number | null;
  monthToMonthShareBps: number | null;
  payoutMode: AiProgrammePayoutMode | null;
}

/** The fields a school can override, in display order. */
export const AI_PROGRAMME_OVERRIDE_FIELDS = [
  "licensePriceMinor",
  "parentPriceMinor",
  "minSeats",
  "maxShareBps",
  "conversionTiers",
  "largeSchoolMinSeats",
  "largeSchoolShareBps",
  "contentBonusTiers",
  "bonusRequiresConversionShare",
  "measurementOffsetDays",
  "nonpaymentGraceDays",
  "monthToMonthShareBps",
  "payoutMode",
] as const;
export type AiProgrammeOverrideField = (typeof AI_PROGRAMME_OVERRIDE_FIELDS)[number];

/** Every resolved field, in display order: what a diff between two resolutions talks about. */
export const AI_PROGRAMME_FIELDS = ["iapPriceMinor", ...AI_PROGRAMME_OVERRIDE_FIELDS] as const;
export type AiProgrammeField = (typeof AI_PROGRAMME_FIELDS)[number];

/** An override that changes nothing: every field inherited. */
export const EMPTY_AI_PROGRAMME_OVERRIDE: AiProgrammeOverride = {
  priceCurrencyCode: null,
  licensePriceMinor: null,
  parentPriceMinor: null,
  minSeats: null,
  maxShareBps: null,
  conversionTiers: null,
  largeSchoolMinSeats: null,
  largeSchoolShareBps: null,
  contentBonusTiers: null,
  bonusRequiresConversionShare: null,
  measurementOffsetDays: null,
  nonpaymentGraceDays: null,
  monthToMonthShareBps: null,
  payoutMode: null,
};

/** The values in force for one school and currency. */
export interface ResolvedAiProgramme {
  currencyCode: string;
  /** Null when the currency has no price: neither the global version nor the school sets one. */
  iapPriceMinor: number | null;
  licensePriceMinor: number | null;
  parentPriceMinor: number | null;
  minSeats: number;
  maxShareBps: number;
  conversionTiers: AiProgrammeTier[];
  largeSchoolMinSeats: number;
  largeSchoolShareBps: number;
  contentBonusTiers: AiProgrammeTier[];
  bonusRequiresConversionShare: boolean;
  measurementOffsetDays: number;
  nonpaymentGraceDays: number;
  monthToMonthShareBps: number;
  payoutMode: AiProgrammePayoutMode;
  /** The fields whose value is the school's own, not the global one. */
  overridden: AiProgrammeOverrideField[];
}

/** The defaults approved on 2026-11-17, in USD: the first global version (migration 000234). */
export const DEFAULT_AI_PROGRAMME_SETTINGS: AiProgrammeSettings = {
  prices: [
    { currencyCode: "USD", iapPriceMinor: 600, licensePriceMinor: 400, parentPriceMinor: 600 },
  ],
  minSeats: 30,
  maxShareBps: 1500,
  conversionTiers: [
    { fromBps: 0, shareBps: 0 },
    { fromBps: 2500, shareBps: 400 },
    { fromBps: 4000, shareBps: 600 },
    { fromBps: 5500, shareBps: 800 },
    { fromBps: 7000, shareBps: 1000 },
    { fromBps: 8500, shareBps: 1200 },
  ],
  largeSchoolMinSeats: 500,
  largeSchoolShareBps: 800,
  contentBonusTiers: [
    { fromBps: 0, shareBps: 0 },
    { fromBps: 6000, shareBps: 150 },
    { fromBps: 8000, shareBps: 300 },
  ],
  bonusRequiresConversionShare: true,
  measurementOffsetDays: 30,
  nonpaymentGraceDays: 30,
  monthToMonthShareBps: 0,
  payoutMode: "invoice_credit",
};

// ---------------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------------

/**
 * The values for `currencyCode`: the school's override wherever it sets one, else the global
 * version's. The override's prices count only in their own currency.
 */
export function resolveAiProgramme(
  global: AiProgrammeSettings,
  override: AiProgrammeOverride | null,
  currencyCode: string,
): ResolvedAiProgramme {
  const o = override ?? EMPTY_AI_PROGRAMME_OVERRIDE;
  const price = global.prices.find((p) => p.currencyCode === currencyCode) ?? null;
  const ownPrices = o.priceCurrencyCode === currencyCode;
  const overridden: AiProgrammeOverrideField[] = [];
  const pick = <T>(field: AiProgrammeOverrideField, own: T | null, fallback: T): T => {
    if (own === null) return fallback;
    overridden.push(field);
    return own;
  };

  const resolved: Omit<ResolvedAiProgramme, "overridden"> = {
    currencyCode,
    iapPriceMinor: price?.iapPriceMinor ?? null,
    licensePriceMinor: pick(
      "licensePriceMinor",
      ownPrices ? o.licensePriceMinor : null,
      price?.licensePriceMinor ?? null,
    ),
    parentPriceMinor: pick(
      "parentPriceMinor",
      ownPrices ? o.parentPriceMinor : null,
      price?.parentPriceMinor ?? null,
    ),
    minSeats: pick("minSeats", o.minSeats, global.minSeats),
    maxShareBps: pick("maxShareBps", o.maxShareBps, global.maxShareBps),
    conversionTiers: sortTiers(pick("conversionTiers", o.conversionTiers, global.conversionTiers)),
    largeSchoolMinSeats: pick(
      "largeSchoolMinSeats",
      o.largeSchoolMinSeats,
      global.largeSchoolMinSeats,
    ),
    largeSchoolShareBps: pick(
      "largeSchoolShareBps",
      o.largeSchoolShareBps,
      global.largeSchoolShareBps,
    ),
    contentBonusTiers: sortTiers(
      pick("contentBonusTiers", o.contentBonusTiers, global.contentBonusTiers),
    ),
    bonusRequiresConversionShare: pick(
      "bonusRequiresConversionShare",
      o.bonusRequiresConversionShare,
      global.bonusRequiresConversionShare,
    ),
    measurementOffsetDays: pick(
      "measurementOffsetDays",
      o.measurementOffsetDays,
      global.measurementOffsetDays,
    ),
    nonpaymentGraceDays: pick(
      "nonpaymentGraceDays",
      o.nonpaymentGraceDays,
      global.nonpaymentGraceDays,
    ),
    monthToMonthShareBps: pick(
      "monthToMonthShareBps",
      o.monthToMonthShareBps,
      global.monthToMonthShareBps,
    ),
    payoutMode: pick("payoutMode", o.payoutMode, global.payoutMode),
  };
  return {
    ...resolved,
    overridden: AI_PROGRAMME_OVERRIDE_FIELDS.filter((f) => overridden.includes(f)),
  };
}

function sortTiers(tiers: readonly AiProgrammeTier[]): AiProgrammeTier[] {
  return [...tiers].sort((a, b) => a.fromBps - b.fromBps).map((t) => ({ ...t }));
}

/** The fields whose values differ between two resolutions (prices, tiers and every scalar). */
export function aiProgrammeChanges(
  before: ResolvedAiProgramme,
  after: ResolvedAiProgramme,
): AiProgrammeField[] {
  return AI_PROGRAMME_FIELDS.filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

/** True when the override sets nothing: every field inherits. */
export function isEmptyAiProgrammeOverride(override: AiProgrammeOverride): boolean {
  return AI_PROGRAMME_OVERRIDE_FIELDS.every((field) => override[field] === null);
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

/**
 * What is wrong with a value. `out_of_range`: a price, percentage, seat count or day count outside
 * its bounds. `tiers_invalid`: a tier table that does not start at 0%, repeats or lowers a threshold,
 * lowers a share, or has too many rows. `share_above_max`: a share, floor or bonus above the maximum
 * revenue share. `currency_invalid`: no prices, a repeated currency, or override prices without
 * their currency.
 */
export type AiProgrammeIssueCode =
  "out_of_range" | "tiers_invalid" | "share_above_max" | "currency_invalid";

export interface AiProgrammeIssue {
  /** The field, as named in AiProgrammeSettings (`prices` for anything about prices). */
  field: keyof AiProgrammeSettings | "priceCurrencyCode";
  code: AiProgrammeIssueCode;
  /** The row of a tier table or price list, when the issue is about one. */
  index?: number;
}

const isInt = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const isBps = (value: unknown): boolean => isInt(value, 0, BPS_SCALE);
const isPrice = (value: unknown): boolean => isInt(value, 0, AI_PROGRAMME_LIMITS.maxPriceMinor);

function tierIssues(
  field: "conversionTiers" | "contentBonusTiers",
  tiers: readonly AiProgrammeTier[],
  maxShareBps: number,
): AiProgrammeIssue[] {
  const issues: AiProgrammeIssue[] = [];
  if (tiers.length === 0 || tiers.length > AI_PROGRAMME_LIMITS.maxTiers) {
    return [{ field, code: "tiers_invalid" }];
  }
  tiers.forEach((tier, index) => {
    if (!isBps(tier.fromBps) || !isBps(tier.shareBps)) {
      issues.push({ field, code: "out_of_range", index });
      return;
    }
    if (tier.shareBps > maxShareBps) issues.push({ field, code: "share_above_max", index });
    const previous = tiers[index - 1];
    if (index === 0 && tier.fromBps !== 0) issues.push({ field, code: "tiers_invalid", index });
    if (previous && (tier.fromBps <= previous.fromBps || tier.shareBps < previous.shareBps)) {
      issues.push({ field, code: "tiers_invalid", index });
    }
  });
  return issues;
}

/** The rules every complete set of settings follows: the global version, and any resolution. */
function scalarIssues(settings: Omit<AiProgrammeSettings, "prices">): AiProgrammeIssue[] {
  const issues: AiProgrammeIssue[] = [];
  const L = AI_PROGRAMME_LIMITS;
  if (!isInt(settings.minSeats, L.minSeats.min, L.minSeats.max)) {
    issues.push({ field: "minSeats", code: "out_of_range" });
  }
  const maxValid = isBps(settings.maxShareBps);
  if (!maxValid) issues.push({ field: "maxShareBps", code: "out_of_range" });
  const max = maxValid ? settings.maxShareBps : BPS_SCALE;
  issues.push(...tierIssues("conversionTiers", settings.conversionTiers, max));
  issues.push(...tierIssues("contentBonusTiers", settings.contentBonusTiers, max));
  if (!isInt(settings.largeSchoolMinSeats, L.largeSchoolMinSeats.min, L.largeSchoolMinSeats.max)) {
    issues.push({ field: "largeSchoolMinSeats", code: "out_of_range" });
  }
  if (!isBps(settings.largeSchoolShareBps)) {
    issues.push({ field: "largeSchoolShareBps", code: "out_of_range" });
  } else if (settings.largeSchoolShareBps > max) {
    issues.push({ field: "largeSchoolShareBps", code: "share_above_max" });
  }
  if (typeof settings.bonusRequiresConversionShare !== "boolean") {
    issues.push({ field: "bonusRequiresConversionShare", code: "out_of_range" });
  }
  const offset = L.measurementOffsetDays;
  if (!isInt(settings.measurementOffsetDays, offset.min, offset.max)) {
    issues.push({ field: "measurementOffsetDays", code: "out_of_range" });
  }
  const grace = L.nonpaymentGraceDays;
  if (!isInt(settings.nonpaymentGraceDays, grace.min, grace.max)) {
    issues.push({ field: "nonpaymentGraceDays", code: "out_of_range" });
  }
  if (!isBps(settings.monthToMonthShareBps)) {
    issues.push({ field: "monthToMonthShareBps", code: "out_of_range" });
  }
  if (!AI_PROGRAMME_PAYOUT_MODES.includes(settings.payoutMode)) {
    issues.push({ field: "payoutMode", code: "out_of_range" });
  }
  return issues;
}

/** Everything wrong with a global version; empty when it can be saved. */
export function validateAiProgrammeSettings(settings: AiProgrammeSettings): AiProgrammeIssue[] {
  const issues: AiProgrammeIssue[] = [];
  const seen = new Set<string>();
  if (settings.prices.length === 0 || settings.prices.length > AI_PROGRAMME_LIMITS.maxCurrencies) {
    issues.push({ field: "prices", code: "currency_invalid" });
  }
  settings.prices.forEach((price, index) => {
    if (!/^[A-Z]{3}$/.test(price.currencyCode) || seen.has(price.currencyCode)) {
      issues.push({ field: "prices", code: "currency_invalid", index });
    }
    seen.add(price.currencyCode);
    if (
      !isPrice(price.iapPriceMinor) ||
      !isPrice(price.licensePriceMinor) ||
      !isPrice(price.parentPriceMinor)
    ) {
      issues.push({ field: "prices", code: "out_of_range", index });
    }
  });
  return [...issues, ...scalarIssues(settings)];
}

/**
 * Everything wrong with a school's override against the global version it will be resolved with:
 * each value it sets is in range, and what the school ends up with follows every rule (a tier the
 * school keeps from the global version must still fit under the school's own maximum).
 */
export function validateAiProgrammeOverride(
  override: AiProgrammeOverride,
  global: AiProgrammeSettings,
): AiProgrammeIssue[] {
  const issues: AiProgrammeIssue[] = [];
  const hasPrice = override.licensePriceMinor !== null || override.parentPriceMinor !== null;
  if (hasPrice !== (override.priceCurrencyCode !== null)) {
    issues.push({ field: "priceCurrencyCode", code: "currency_invalid" });
  } else if (
    override.priceCurrencyCode !== null &&
    !/^[A-Z]{3}$/.test(override.priceCurrencyCode)
  ) {
    issues.push({ field: "priceCurrencyCode", code: "currency_invalid" });
  }
  for (const value of [override.licensePriceMinor, override.parentPriceMinor]) {
    if (value !== null && !isPrice(value)) {
      issues.push({ field: "prices", code: "out_of_range" });
      break;
    }
  }
  const resolved = resolveAiProgramme(global, override, override.priceCurrencyCode ?? "");
  return [...issues, ...scalarIssues(resolved)];
}

// ---------------------------------------------------------------------------------------------------
// Tiers and the share they give (a preview; the share on a payment is phase 5's)
// ---------------------------------------------------------------------------------------------------

/** The tier a value falls in: the highest threshold at or below it. Null below every tier. */
export function tierFor(
  tiers: readonly AiProgrammeTier[],
  valueBps: number,
): AiProgrammeTier | null {
  let found: AiProgrammeTier | null = null;
  for (const tier of sortTiers(tiers)) {
    if (tier.fromBps <= valueBps) found = tier;
  }
  return found;
}

/** The next tier up from a value, or null at the top. */
export function nextTierFor(
  tiers: readonly AiProgrammeTier[],
  valueBps: number,
): AiProgrammeTier | null {
  return sortTiers(tiers).find((tier) => tier.fromBps > valueBps) ?? null;
}

export interface RevenueSharePreviewInput {
  /** Students opted in / students enrolled, in basis points. */
  conversionBps: number;
  /** School days with an upload / school days, in basis points. */
  uploadConsistencyBps: number;
  /** Seats on the licence (the large-school floor's test). */
  seats: number;
  /** A full-year committed licence; false for month-to-month. */
  fullYear: boolean;
}

export interface RevenueSharePreview {
  conversionShareBps: number;
  /** True when the large-school floor raised the conversion share. */
  floorApplied: boolean;
  bonusBps: number;
  /** Conversion share + bonus, capped at the maximum, then scaled for a month-to-month licence. */
  totalBps: number;
  /** True when the maximum cut the total. */
  capped: boolean;
}

/**
 * The share the settings give a school, as the console's worked example shows it: the conversion
 * tier (raised to the large-school floor), plus the content bonus (only above a 0% conversion share
 * when the settings say so), capped at the maximum; a month-to-month licence earns
 * `monthToMonthShareBps` of that.
 */
export function previewRevenueShare(
  settings: Pick<
    ResolvedAiProgramme,
    | "maxShareBps"
    | "conversionTiers"
    | "largeSchoolMinSeats"
    | "largeSchoolShareBps"
    | "contentBonusTiers"
    | "bonusRequiresConversionShare"
    | "monthToMonthShareBps"
  >,
  input: RevenueSharePreviewInput,
): RevenueSharePreview {
  const tierShare = tierFor(settings.conversionTiers, input.conversionBps)?.shareBps ?? 0;
  const floor = input.seats >= settings.largeSchoolMinSeats ? settings.largeSchoolShareBps : 0;
  const conversionShareBps = Math.max(tierShare, floor);
  const bonusTier = tierFor(settings.contentBonusTiers, input.uploadConsistencyBps)?.shareBps ?? 0;
  const bonusBps =
    settings.bonusRequiresConversionShare && conversionShareBps === 0 ? 0 : bonusTier;
  const uncapped = conversionShareBps + bonusBps;
  const capped = uncapped > settings.maxShareBps;
  const full = Math.min(uncapped, settings.maxShareBps);
  const totalBps = input.fullYear
    ? full
    : Number(applyBps(BigInt(full), settings.monthToMonthShareBps));
  return {
    conversionShareBps,
    floorApplied: floor > tierShare,
    bonusBps,
    totalBps,
    capped,
  };
}

/**
 * What the school keeps per student per month: the price parents see less the licence price.
 * `none` (equal) and `below_cost` (parents pay less than the school does) are allowed -- the owner
 * may price Student AI so the school earns only its revenue share -- and the console warns about
 * them without refusing them. Null when either price is unknown for the currency.
 */
export type AiProgrammeMargin = "positive" | "none" | "below_cost";

export function schoolMarginOf(prices: {
  licensePriceMinor: number | null;
  parentPriceMinor: number | null;
}): AiProgrammeMargin | null {
  if (prices.licensePriceMinor === null || prices.parentPriceMinor === null) return null;
  if (prices.parentPriceMinor > prices.licensePriceMinor) return "positive";
  return prices.parentPriceMinor === prices.licensePriceMinor ? "none" : "below_cost";
}
