import { resolveAiProgramme } from "@studafy/license-pricing";

import type {
  AiProgrammeOverride,
  AiProgrammePayoutMode,
  AiProgrammeSettings,
  AiProgrammeTier,
  AiProgrammeTierKind,
  ResolvedAiProgramme,
} from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * The Student AI programme values a licence was signed with (000234), read straight from the version
 * tables and resolved with @studafy/license-pricing resolveAiProgramme -- the same resolution the
 * API's settings console uses (apps/api/src/modules/licensing/ai-programme.ts), without the views and
 * author names, so the workers can compute a share too. A test in the API holds the two readers to
 * the same answer.
 */

/** The pair of versions a licence carries. */
export interface ProgrammeStamp {
  versionId: string;
  overrideId: string | null;
}

interface TierRow {
  kind: AiProgrammeTierKind;
  from_bps: number;
  share_bps: number;
}

const tiersOf = (rows: readonly TierRow[], kind: AiProgrammeTierKind): AiProgrammeTier[] =>
  rows
    .filter((row) => row.kind === kind)
    .sort((a, b) => a.from_bps - b.from_bps)
    .map((row) => ({ fromBps: row.from_bps, shareBps: row.share_bps }));

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/** The values a stamp resolves to in `currencyCode`, in the armed school (its override is a tenant row). */
export async function readProgrammeValues(
  tx: TransactionSql,
  stamp: ProgrammeStamp,
  currencyCode: string,
): Promise<ResolvedAiProgramme> {
  const [version] = await tx<
    {
      min_seats: number;
      max_share_bps: number;
      large_school_min_seats: number;
      large_school_share_bps: number;
      bonus_requires_conversion_share: boolean;
      measurement_offset_days: number;
      nonpayment_grace_days: number;
      month_to_month_share_bps: number;
      payout_mode: AiProgrammePayoutMode;
    }[]
  >`
    SELECT min_seats, max_share_bps, large_school_min_seats, large_school_share_bps,
           bonus_requires_conversion_share, measurement_offset_days, nonpayment_grace_days,
           month_to_month_share_bps, payout_mode
    FROM app.ai_programme_versions WHERE id = ${stamp.versionId}::uuid
  `;
  if (!version) throw new Error(`Unknown Student AI programme version ${stamp.versionId}.`);
  const prices = await tx<{ code: string; iap: string; license: string; parent: string }[]>`
    SELECT c.code, p.iap_price_minor::text AS iap, p.license_price_minor::text AS license,
           p.parent_price_minor::text AS parent
    FROM app.ai_programme_version_prices AS p JOIN app.currencies AS c ON c.id = p.currency_id
    WHERE p.version_id = ${stamp.versionId}::uuid
    ORDER BY c.code
  `;
  const tiers = await tx<TierRow[]>`
    SELECT kind, from_bps, share_bps FROM app.ai_programme_version_tiers
    WHERE version_id = ${stamp.versionId}::uuid
  `;
  const settings: AiProgrammeSettings = {
    prices: prices.map((p) => ({
      currencyCode: p.code,
      iapPriceMinor: Number(p.iap),
      licensePriceMinor: Number(p.license),
      parentPriceMinor: Number(p.parent),
    })),
    minSeats: version.min_seats,
    maxShareBps: version.max_share_bps,
    conversionTiers: tiersOf(tiers, "conversion"),
    largeSchoolMinSeats: version.large_school_min_seats,
    largeSchoolShareBps: version.large_school_share_bps,
    contentBonusTiers: tiersOf(tiers, "content_bonus"),
    bonusRequiresConversionShare: version.bonus_requires_conversion_share,
    measurementOffsetDays: version.measurement_offset_days,
    nonpaymentGraceDays: version.nonpayment_grace_days,
    monthToMonthShareBps: version.month_to_month_share_bps,
    payoutMode: version.payout_mode,
  };
  return resolveAiProgramme(
    settings,
    stamp.overrideId ? await readOverride(tx, stamp.overrideId) : null,
    currencyCode,
  );
}

async function readOverride(tx: TransactionSql, overrideId: string): Promise<AiProgrammeOverride> {
  const [row] = await tx<
    {
      price_currency_code: string | null;
      license_price_minor: string | null;
      parent_price_minor: string | null;
      min_seats: number | null;
      max_share_bps: number | null;
      large_school_min_seats: number | null;
      large_school_share_bps: number | null;
      bonus_requires_conversion_share: boolean | null;
      measurement_offset_days: number | null;
      nonpayment_grace_days: number | null;
      month_to_month_share_bps: number | null;
      payout_mode: AiProgrammePayoutMode | null;
    }[]
  >`
    SELECT c.code AS price_currency_code, o.license_price_minor::text AS license_price_minor,
           o.parent_price_minor::text AS parent_price_minor, o.min_seats, o.max_share_bps,
           o.large_school_min_seats, o.large_school_share_bps, o.bonus_requires_conversion_share,
           o.measurement_offset_days, o.nonpayment_grace_days, o.month_to_month_share_bps,
           o.payout_mode
    FROM app.ai_programme_school_overrides AS o
    LEFT JOIN app.currencies AS c ON c.id = o.price_currency_id
    WHERE o.school_id = current_setting('app.school_id')::uuid AND o.id = ${overrideId}::uuid
  `;
  if (!row) throw new Error(`Unknown Student AI programme override ${overrideId}.`);
  const tiers = await tx<TierRow[]>`
    SELECT kind, from_bps, share_bps FROM app.ai_programme_school_override_tiers
    WHERE school_id = current_setting('app.school_id')::uuid AND override_id = ${overrideId}::uuid
  `;
  const conversion = tiersOf(tiers, "conversion");
  const bonus = tiersOf(tiers, "content_bonus");
  return {
    priceCurrencyCode: row.price_currency_code,
    licensePriceMinor: num(row.license_price_minor),
    parentPriceMinor: num(row.parent_price_minor),
    minSeats: row.min_seats,
    maxShareBps: row.max_share_bps,
    conversionTiers: conversion.length > 0 ? conversion : null,
    largeSchoolMinSeats: row.large_school_min_seats,
    largeSchoolShareBps: row.large_school_share_bps,
    contentBonusTiers: bonus.length > 0 ? bonus : null,
    bonusRequiresConversionShare: row.bonus_requires_conversion_share,
    measurementOffsetDays: row.measurement_offset_days,
    nonpaymentGraceDays: row.nonpayment_grace_days,
    monthToMonthShareBps: row.month_to_month_share_bps,
    payoutMode: row.payout_mode,
  };
}
