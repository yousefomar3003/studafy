import { AI_PROGRAMME_OVERRIDE_FIELDS } from "@studafy/license-pricing";

import { currencyMinorUnit, fromMinor, percentToBps, toMinor } from "./format";

import type {
  AiProgrammeOverride,
  AiProgrammeOverrideField,
  AiProgrammePayoutMode,
  AiProgrammeSettings,
  AiProgrammeTier,
} from "@studafy/license-pricing";

/**
 * The Student AI programme editor's form state (000234): every number as the super admin types it
 * (major units for money, percentages for basis points), and the conversions to and from the API's
 * minor units and basis points. A value that does not parse becomes NaN, which the shared validator
 * (@studafy/license-pricing) reports as out of range -- so the page shows the same rules the API
 * enforces.
 */

export interface TierRow {
  from: string;
  share: string;
}

export interface PriceRow {
  currencyCode: string;
  iap: string;
  license: string;
  parent: string;
}

export interface ScalarForm {
  minSeats: string;
  maxShare: string;
  floorSeats: string;
  floorShare: string;
  bonusRequiresConversionShare: boolean;
  measurementDays: string;
  graceDays: string;
  monthToMonth: string;
  payoutMode: AiProgrammePayoutMode;
  conversion: TierRow[];
  bonus: TierRow[];
}

export interface GlobalForm extends ScalarForm {
  prices: PriceRow[];
}

/** Basis points as a plain percentage for an input: 1250 -> "12.5". */
export const bpsInput = (bps: number) => String(Number((bps / 100).toFixed(2)));

const bpsOf = (value: string) => percentToBps(value) ?? Number.NaN;
const intOf = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN);
export const minorOf = (value: string, currencyCode: string) =>
  toMinor(value, currencyMinorUnit(currencyCode)) ?? Number.NaN;

export const tierRows = (tiers: readonly AiProgrammeTier[]): TierRow[] =>
  tiers.map((t) => ({ from: bpsInput(t.fromBps), share: bpsInput(t.shareBps) }));

export const tiersOf = (rows: readonly TierRow[]): AiProgrammeTier[] =>
  rows.map((r) => ({ fromBps: bpsOf(r.from), shareBps: bpsOf(r.share) }));

export function globalFormOf(settings: AiProgrammeSettings): GlobalForm {
  return {
    prices: settings.prices.map((p) => {
      const unit = currencyMinorUnit(p.currencyCode);
      return {
        currencyCode: p.currencyCode,
        iap: fromMinor(p.iapPriceMinor, unit),
        license: fromMinor(p.licensePriceMinor, unit),
        parent: fromMinor(p.parentPriceMinor, unit),
      };
    }),
    minSeats: String(settings.minSeats),
    maxShare: bpsInput(settings.maxShareBps),
    floorSeats: String(settings.largeSchoolMinSeats),
    floorShare: bpsInput(settings.largeSchoolShareBps),
    bonusRequiresConversionShare: settings.bonusRequiresConversionShare,
    measurementDays: String(settings.measurementOffsetDays),
    graceDays: String(settings.nonpaymentGraceDays),
    monthToMonth: bpsInput(settings.monthToMonthShareBps),
    payoutMode: settings.payoutMode,
    conversion: tierRows(settings.conversionTiers),
    bonus: tierRows(settings.contentBonusTiers),
  };
}

export function settingsOf(form: GlobalForm): AiProgrammeSettings {
  return {
    prices: form.prices.map((p) => ({
      currencyCode: p.currencyCode,
      iapPriceMinor: minorOf(p.iap, p.currencyCode),
      licensePriceMinor: minorOf(p.license, p.currencyCode),
      parentPriceMinor: minorOf(p.parent, p.currencyCode),
    })),
    minSeats: intOf(form.minSeats),
    maxShareBps: bpsOf(form.maxShare),
    conversionTiers: tiersOf(form.conversion),
    largeSchoolMinSeats: intOf(form.floorSeats),
    largeSchoolShareBps: bpsOf(form.floorShare),
    contentBonusTiers: tiersOf(form.bonus),
    bonusRequiresConversionShare: form.bonusRequiresConversionShare,
    measurementOffsetDays: intOf(form.measurementDays),
    nonpaymentGraceDays: intOf(form.graceDays),
    monthToMonthShareBps: bpsOf(form.monthToMonth),
    payoutMode: form.payoutMode,
  };
}

/** A school's override form: the global form's fields, the two prices, and which are overridden. */
export interface OverrideForm extends ScalarForm {
  license: string;
  parent: string;
  on: Record<AiProgrammeOverrideField, boolean>;
}

/**
 * The override form for a school: its own value where it has one, else the effective (inherited)
 * value, shown greyed until the field is switched on.
 */
export function overrideFormOf(
  effective: {
    licensePriceMinor: number | null;
    parentPriceMinor: number | null;
  } & Omit<AiProgrammeSettings, "prices">,
  overridden: readonly AiProgrammeOverrideField[],
  currencyCode: string,
): OverrideForm {
  const unit = currencyMinorUnit(currencyCode);
  const base = globalFormOf({ ...effective, prices: [] });
  return {
    ...base,
    license:
      effective.licensePriceMinor === null ? "" : fromMinor(effective.licensePriceMinor, unit),
    parent: effective.parentPriceMinor === null ? "" : fromMinor(effective.parentPriceMinor, unit),
    on: Object.fromEntries(
      AI_PROGRAMME_OVERRIDE_FIELDS.map((field) => [field, overridden.includes(field)]),
    ) as Record<AiProgrammeOverrideField, boolean>,
  };
}

/** The override the form describes (null where a field is not switched on). */
export function overrideOf(
  form: OverrideForm,
  currencyCode: string,
): Omit<AiProgrammeOverride, "priceCurrencyCode"> {
  const pick = <T>(field: AiProgrammeOverrideField, value: T): T | null =>
    form.on[field] ? value : null;
  return {
    licensePriceMinor: pick("licensePriceMinor", minorOf(form.license, currencyCode)),
    parentPriceMinor: pick("parentPriceMinor", minorOf(form.parent, currencyCode)),
    minSeats: pick("minSeats", intOf(form.minSeats)),
    maxShareBps: pick("maxShareBps", bpsOf(form.maxShare)),
    conversionTiers: pick("conversionTiers", tiersOf(form.conversion)),
    largeSchoolMinSeats: pick("largeSchoolMinSeats", intOf(form.floorSeats)),
    largeSchoolShareBps: pick("largeSchoolShareBps", bpsOf(form.floorShare)),
    contentBonusTiers: pick("contentBonusTiers", tiersOf(form.bonus)),
    bonusRequiresConversionShare: pick(
      "bonusRequiresConversionShare",
      form.bonusRequiresConversionShare,
    ),
    measurementOffsetDays: pick("measurementOffsetDays", intOf(form.measurementDays)),
    nonpaymentGraceDays: pick("nonpaymentGraceDays", intOf(form.graceDays)),
    monthToMonthShareBps: pick("monthToMonthShareBps", bpsOf(form.monthToMonth)),
    payoutMode: pick("payoutMode", form.payoutMode),
  };
}

/** NaN cannot travel as JSON: the page refuses to send a form with issues, so this never applies. */
export function hasNaN(value: unknown): boolean {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === "number" && Number.isNaN(v) ? "__NaN__" : v,
  ).includes("__NaN__");
}
