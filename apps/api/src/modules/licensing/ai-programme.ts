import { readProgrammeValues } from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";
import {
  AI_PROGRAMME_LIMITS,
  EMPTY_AI_PROGRAMME_OVERRIDE,
  aiProgrammeChanges,
  isEmptyAiProgrammeOverride,
  resolveAiProgramme,
  validateAiProgrammeOverride,
  validateAiProgrammeSettings,
} from "@studafy/license-pricing";
import postgres from "postgres";

import { setTenantScope } from "../../db/tenant-tx";

import { auditLicenseChange, licenseError } from "./context";
import { auditPlatformChange } from "./pricing";

import type { LicenseActor } from "./context";
import type { LicenseRecord } from "./service";
import type { ErrorCode } from "@studafy/constants";
import type {
  AiProgrammeField,
  AiProgrammeIssue,
  AiProgrammeOverride,
  AiProgrammePayoutMode,
  AiProgrammePrice,
  AiProgrammeSettings,
  AiProgrammeTier,
  AiProgrammeTierKind,
  ResolvedAiProgramme,
} from "@studafy/license-pricing";
import type { TransactionSql } from "postgres";

/**
 * The Student AI programme's settings (migration 000234, docs/billing/ai-programme.md): the super
 * admin's global versions and per-school override versions, what a school's values resolve to, and
 * the versions a licence was signed with.
 *
 * Nothing is edited in place: a save writes a new immutable version (who, when, why) and an audit
 * row. A quote records the versions in force when it was priced; accepting it signs the licence with
 * them (a new licence or an extension -- a renewal; a seat increase keeps the licence's). The super
 * admin can re-apply the current values to a licence, with a reason. Resolution itself is
 * @studafy/license-pricing's resolveAiProgramme, so the workers and the console agree with the API.
 */

/** The approved defaults, seeded by 000234 with this fixed id. */
export const INITIAL_AI_PROGRAMME_VERSION_ID = "a1000000-0000-4000-8000-000000000001";

// ---------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------

export interface AiProgrammeAuthor {
  /** Null for the defaults the migration seeded. */
  userId: string | null;
  name: string | null;
}

/** Settings as the API sends them: plain (mutable) arrays, as the response schema types them. */
export type AiProgrammeSettingsView = Omit<
  AiProgrammeSettings,
  "prices" | "conversionTiers" | "contentBonusTiers"
> & {
  prices: AiProgrammePrice[];
  conversionTiers: AiProgrammeTier[];
  contentBonusTiers: AiProgrammeTier[];
};

export type AiProgrammeOverrideSettingsView = Omit<
  AiProgrammeOverride,
  "conversionTiers" | "contentBonusTiers"
> & {
  conversionTiers: AiProgrammeTier[] | null;
  contentBonusTiers: AiProgrammeTier[] | null;
};

export interface AiProgrammeVersionView {
  id: string;
  versionNumber: number;
  settings: AiProgrammeSettingsView;
  reason: string;
  createdBy: AiProgrammeAuthor;
  createdAt: string;
}

export interface AiProgrammeOverrideView {
  id: string;
  schoolId: string;
  versionNumber: number;
  override: AiProgrammeOverrideSettingsView;
  /** True when it sets nothing: the school's overrides were cleared. */
  empty: boolean;
  reason: string;
  createdBy: AiProgrammeAuthor;
  createdAt: string;
}

/** The pair of versions a quote or licence carries. */
export interface AiProgrammeStamp {
  versionId: string;
  overrideId: string | null;
}

interface VersionRow {
  id: string;
  version_number: number;
  min_seats: number;
  max_share_bps: number;
  large_school_min_seats: number;
  large_school_share_bps: number;
  bonus_requires_conversion_share: boolean;
  measurement_offset_days: number;
  nonpayment_grace_days: number;
  month_to_month_share_bps: number;
  payout_mode: AiProgrammePayoutMode;
  reason: string;
  created_by: string | null;
  created_by_school_id: string | null;
  created_at: Date;
}

interface OverrideRow {
  id: string;
  school_id: string;
  version_number: number;
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
  reason: string;
  created_by: string;
  created_by_school_id: string;
  created_at: Date;
}

interface TierRow {
  owner_id: string;
  kind: AiProgrammeTierKind;
  from_bps: number;
  share_bps: number;
}

const tiersOf = (rows: readonly TierRow[], ownerId: string, kind: AiProgrammeTierKind) =>
  rows
    .filter((row) => row.owner_id === ownerId && row.kind === kind)
    .sort((a, b) => a.from_bps - b.from_bps)
    .map((row) => ({ fromBps: row.from_bps, shareBps: row.share_bps }));

/**
 * The names of the super admins who saved versions. Each is a user of their own home school, behind
 * that school's RLS, so the lookup arms each school in turn and then restores the scope it found.
 */
async function authorNames(
  tx: TransactionSql,
  authors: readonly { userId: string | null; schoolId: string | null }[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const bySchool = new Map<string, Set<string>>();
  for (const author of authors) {
    if (!author.userId || !author.schoolId) continue;
    const set = bySchool.get(author.schoolId) ?? new Set<string>();
    set.add(author.userId);
    bySchool.set(author.schoolId, set);
  }
  if (bySchool.size === 0) return names;
  const [scope] = await tx<{ school: string | null }[]>`
    SELECT current_setting('app.school_id', true) AS school
  `;
  for (const [schoolId, userIds] of bySchool) {
    await setTenantScope(tx, schoolId);
    const rows = await tx<{ id: string; name: string }[]>`
      SELECT id::text AS id, COALESCE(display_name, email) AS name
      FROM app.users
      WHERE school_id = current_setting('app.school_id')::uuid AND id = ANY(${[...userIds]}::uuid[])
    `;
    for (const row of rows) names.set(row.id, row.name);
  }
  await tx`SELECT set_config('app.school_id', ${scope?.school ?? ""}, true)`;
  return names;
}

const VERSION_COLUMNS = (tx: TransactionSql) => tx`
  v.id::text AS id, v.version_number, v.min_seats, v.max_share_bps, v.large_school_min_seats,
  v.large_school_share_bps, v.bonus_requires_conversion_share, v.measurement_offset_days,
  v.nonpayment_grace_days, v.month_to_month_share_bps, v.payout_mode, v.reason,
  v.created_by::text AS created_by, v.created_by_school_id::text AS created_by_school_id, v.created_at
`;

async function versionViews(
  tx: TransactionSql,
  rows: readonly VersionRow[],
): Promise<AiProgrammeVersionView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  // Sequential: authorNames re-arms the tenant scope while it runs.
  const prices = await tx<
    { version_id: string; currency_code: string; iap: string; license: string; parent: string }[]
  >`
    SELECT p.version_id::text AS version_id, c.code AS currency_code,
           p.iap_price_minor::text AS iap, p.license_price_minor::text AS license,
           p.parent_price_minor::text AS parent
    FROM app.ai_programme_version_prices AS p
    JOIN app.currencies AS c ON c.id = p.currency_id
    WHERE p.version_id = ANY(${ids}::uuid[])
    ORDER BY c.code
  `;
  const tiers = await tx<TierRow[]>`
    SELECT version_id::text AS owner_id, kind, from_bps, share_bps
    FROM app.ai_programme_version_tiers
    WHERE version_id = ANY(${ids}::uuid[])
  `;
  const names = await authorNames(
    tx,
    rows.map((row) => ({ userId: row.created_by, schoolId: row.created_by_school_id })),
  );
  return rows.map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    settings: {
      prices: prices
        .filter((p) => p.version_id === row.id)
        .map((p) => ({
          currencyCode: p.currency_code,
          iapPriceMinor: Number(p.iap),
          licensePriceMinor: Number(p.license),
          parentPriceMinor: Number(p.parent),
        })),
      minSeats: row.min_seats,
      maxShareBps: row.max_share_bps,
      conversionTiers: tiersOf(tiers, row.id, "conversion"),
      largeSchoolMinSeats: row.large_school_min_seats,
      largeSchoolShareBps: row.large_school_share_bps,
      contentBonusTiers: tiersOf(tiers, row.id, "content_bonus"),
      bonusRequiresConversionShare: row.bonus_requires_conversion_share,
      measurementOffsetDays: row.measurement_offset_days,
      nonpaymentGraceDays: row.nonpayment_grace_days,
      monthToMonthShareBps: row.month_to_month_share_bps,
      payoutMode: row.payout_mode,
    },
    reason: row.reason,
    createdBy: {
      userId: row.created_by,
      name: row.created_by ? (names.get(row.created_by) ?? null) : null,
    },
    createdAt: row.created_at.toISOString(),
  }));
}

/** One global version, or null. */
export async function readAiProgrammeVersion(
  tx: TransactionSql,
  versionId: string,
): Promise<AiProgrammeVersionView | null> {
  const rows = await tx<VersionRow[]>`
    SELECT ${VERSION_COLUMNS(tx)} FROM app.ai_programme_versions AS v
    WHERE v.id = ${versionId}::uuid
  `;
  return (await versionViews(tx, rows))[0] ?? null;
}

/** The global version in force: the highest number. 000234 seeds the first, so there always is one. */
export async function currentAiProgrammeVersion(
  tx: TransactionSql,
): Promise<AiProgrammeVersionView> {
  const rows = await tx<VersionRow[]>`
    SELECT ${VERSION_COLUMNS(tx)} FROM app.ai_programme_versions AS v
    ORDER BY v.version_number DESC LIMIT 1
  `;
  const [view] = await versionViews(tx, rows);
  if (!view) throw new Error("No Student AI programme version: migration 000234 seeds the first.");
  return view;
}

/** Every global version, newest first. */
export async function listAiProgrammeVersions(
  tx: TransactionSql,
): Promise<AiProgrammeVersionView[]> {
  const rows = await tx<VersionRow[]>`
    SELECT ${VERSION_COLUMNS(tx)} FROM app.ai_programme_versions AS v
    ORDER BY v.version_number DESC
  `;
  return versionViews(tx, rows);
}

const OVERRIDE_COLUMNS = (tx: TransactionSql) => tx`
  o.id::text AS id, o.school_id::text AS school_id, o.version_number,
  c.code AS price_currency_code, o.license_price_minor::text AS license_price_minor,
  o.parent_price_minor::text AS parent_price_minor, o.min_seats, o.max_share_bps,
  o.large_school_min_seats, o.large_school_share_bps, o.bonus_requires_conversion_share,
  o.measurement_offset_days, o.nonpayment_grace_days, o.month_to_month_share_bps, o.payout_mode,
  o.reason, o.created_by::text AS created_by, o.created_by_school_id::text AS created_by_school_id,
  o.created_at
`;

async function overrideViews(
  tx: TransactionSql,
  rows: readonly OverrideRow[],
): Promise<AiProgrammeOverrideView[]> {
  if (rows.length === 0) return [];
  const tiers = await tx<TierRow[]>`
    SELECT override_id::text AS owner_id, kind, from_bps, share_bps
    FROM app.ai_programme_school_override_tiers
    WHERE school_id = current_setting('app.school_id')::uuid
      AND override_id = ANY(${rows.map((row) => row.id)}::uuid[])
  `;
  const names = await authorNames(
    tx,
    rows.map((row) => ({ userId: row.created_by, schoolId: row.created_by_school_id })),
  );
  return rows.map((row) => {
    const conversion = tiersOf(tiers, row.id, "conversion");
    const bonus = tiersOf(tiers, row.id, "content_bonus");
    const override: AiProgrammeOverrideSettingsView = {
      priceCurrencyCode: row.price_currency_code,
      licensePriceMinor: row.license_price_minor === null ? null : Number(row.license_price_minor),
      parentPriceMinor: row.parent_price_minor === null ? null : Number(row.parent_price_minor),
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
    return {
      id: row.id,
      schoolId: row.school_id,
      versionNumber: row.version_number,
      override,
      empty: isEmptyAiProgrammeOverride(override),
      reason: row.reason,
      createdBy: { userId: row.created_by, name: names.get(row.created_by) ?? null },
      createdAt: row.created_at.toISOString(),
    };
  });
}

/** One of the armed school's override versions, or null. */
export async function readAiProgrammeOverride(
  tx: TransactionSql,
  overrideId: string,
): Promise<AiProgrammeOverrideView | null> {
  const rows = await tx<OverrideRow[]>`
    SELECT ${OVERRIDE_COLUMNS(tx)}
    FROM app.ai_programme_school_overrides AS o
    LEFT JOIN app.currencies AS c ON c.id = o.price_currency_id
    WHERE o.school_id = current_setting('app.school_id')::uuid AND o.id = ${overrideId}::uuid
  `;
  return (await overrideViews(tx, rows))[0] ?? null;
}

/** The armed school's override version in force, or null when it never had one. */
export async function currentAiProgrammeOverride(
  tx: TransactionSql,
): Promise<AiProgrammeOverrideView | null> {
  const rows = await tx<OverrideRow[]>`
    SELECT ${OVERRIDE_COLUMNS(tx)}
    FROM app.ai_programme_school_overrides AS o
    LEFT JOIN app.currencies AS c ON c.id = o.price_currency_id
    WHERE o.school_id = current_setting('app.school_id')::uuid
    ORDER BY o.version_number DESC
    LIMIT 1
  `;
  return (await overrideViews(tx, rows))[0] ?? null;
}

/** The armed school's override versions, newest first. */
export async function listAiProgrammeOverrides(
  tx: TransactionSql,
): Promise<AiProgrammeOverrideView[]> {
  const rows = await tx<OverrideRow[]>`
    SELECT ${OVERRIDE_COLUMNS(tx)}
    FROM app.ai_programme_school_overrides AS o
    LEFT JOIN app.currencies AS c ON c.id = o.price_currency_id
    WHERE o.school_id = current_setting('app.school_id')::uuid
    ORDER BY o.version_number DESC
  `;
  return overrideViews(tx, rows);
}

/** The armed school's currency: its prices are resolved in it (decision 8 of the plan). */
export async function schoolCurrencyCode(tx: TransactionSql): Promise<string> {
  const [row] = await tx<{ code: string }[]>`
    SELECT c.code FROM app.schools AS s JOIN app.currencies AS c ON c.id = s.default_currency_id
    WHERE s.id = current_setting('app.school_id')::uuid
  `;
  if (!row) throw new Error("The armed school does not exist.");
  return row.code;
}

// ---------------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------------

/** The versions in force for the armed school now: the latest global and the school's latest. */
export async function currentAiProgrammeStamp(tx: TransactionSql): Promise<AiProgrammeStamp> {
  const [row] = await tx<{ version_id: string; override_id: string | null }[]>`
    SELECT
      (SELECT id::text FROM app.ai_programme_versions ORDER BY version_number DESC LIMIT 1)
        AS version_id,
      (SELECT id::text FROM app.ai_programme_school_overrides
       WHERE school_id = current_setting('app.school_id')::uuid
       ORDER BY version_number DESC LIMIT 1) AS override_id
  `;
  return { versionId: row!.version_id, overrideId: row!.override_id };
}

/**
 * THE core resolver: the values a stamp resolves to in `currencyCode`, and nothing else. It reads
 * only the version tables and the armed school's own override (@studafy/billing
 * `readProgrammeValues`, which the workers use too), never the names of the super admins who saved
 * the versions -- so it is the one for school-facing requests (a parent's opt-in, the school's
 * upload consistency, the tuition line) and worker reads.
 */
export function resolveAiProgrammeValues(
  tx: TransactionSql,
  stamp: AiProgrammeStamp,
  currencyCode: string,
): Promise<ResolvedAiProgramme> {
  return readProgrammeValues(tx, stamp, currencyCode);
}

/**
 * PLATFORM VIEWS ONLY: what a stamp resolves to in `currencyCode`, with the versions themselves and
 * their authors' names. Looking the names up arms each super admin's home school in turn (they are
 * users of another school), so this must never run in a school's own request; use
 * `resolveAiProgrammeValues` there.
 */
export async function resolveAiProgrammeStamp(
  tx: TransactionSql,
  stamp: AiProgrammeStamp,
  currencyCode: string,
): Promise<{
  version: AiProgrammeVersionView;
  override: AiProgrammeOverrideView | null;
  values: ResolvedAiProgramme;
}> {
  const version = await readAiProgrammeVersion(tx, stamp.versionId);
  if (!version) throw new Error(`Unknown Student AI programme version ${stamp.versionId}.`);
  const override = stamp.overrideId ? await readAiProgrammeOverride(tx, stamp.overrideId) : null;
  return {
    version,
    override,
    values: resolveAiProgramme(version.settings, override?.override ?? null, currencyCode),
  };
}

export interface SchoolAiProgrammeView {
  schoolId: string;
  currencyCode: string;
  global: AiProgrammeVersionView;
  override: AiProgrammeOverrideView | null;
  effective: ResolvedAiProgramme;
}

/** The armed school's settings: the global version, its override, and what they resolve to. */
export async function schoolAiProgramme(tx: TransactionSql): Promise<SchoolAiProgrammeView> {
  const [scope] = await tx<{ school: string }[]>`SELECT current_setting('app.school_id') AS school`;
  const global = await currentAiProgrammeVersion(tx);
  const override = await currentAiProgrammeOverride(tx);
  const currencyCode = await schoolCurrencyCode(tx);
  return {
    schoolId: scope!.school,
    currencyCode,
    global,
    override,
    effective: resolveAiProgramme(global.settings, override?.override ?? null, currencyCode),
  };
}

// ---------------------------------------------------------------------------------------------------
// Validation -> coded errors
// ---------------------------------------------------------------------------------------------------

const ISSUE_ERRORS: Record<AiProgrammeIssue["code"], ErrorCode> = {
  out_of_range: ERROR_CODES.AI_PROGRAMME_VALUE_OUT_OF_RANGE,
  tiers_invalid: ERROR_CODES.AI_PROGRAMME_TIERS_INVALID,
  share_above_max: ERROR_CODES.AI_PROGRAMME_SHARE_ABOVE_MAX,
  currency_invalid: ERROR_CODES.AI_PROGRAMME_CURRENCY_INVALID,
};

function refuseIssues(issues: readonly AiProgrammeIssue[], actor: LicenseActor): void {
  const [first] = issues;
  if (first) throw licenseError(422, ISSUE_ERRORS[first.code], actor.locale);
}

function requireReason(reason: string | undefined | null, actor: LicenseActor): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed === "" || trimmed.length > AI_PROGRAMME_LIMITS.reasonMaxLength) {
    throw licenseError(422, ERROR_CODES.AI_PROGRAMME_REASON_REQUIRED, actor.locale);
  }
  return trimmed;
}

function rethrowConflict(err: unknown, actor: LicenseActor): never {
  if (err instanceof postgres.PostgresError && err.code === "23505") {
    throw licenseError(409, ERROR_CODES.AI_PROGRAMME_VERSION_CONFLICT, actor.locale);
  }
  throw err;
}

// ---------------------------------------------------------------------------------------------------
// Saving versions
// ---------------------------------------------------------------------------------------------------

export interface SaveAiProgrammeVersionInput extends AiProgrammeSettings {
  reason: string;
  /** The version the super admin edited; refused when a newer one was saved since. */
  basedOnVersionId?: string | null;
}

/** The settings as an audit row stores them. */
function settingsSnapshot(settings: AiProgrammeSettings): Record<string, unknown> {
  return { ...settings };
}

/**
 * Save a new global version. Applies to quotes priced from now on and to licences signed or renewed
 * from them; existing licences keep theirs. The transaction may be unscoped (a global write).
 */
export async function saveAiProgrammeVersion(
  tx: TransactionSql,
  input: SaveAiProgrammeVersionInput,
  actor: LicenseActor,
): Promise<AiProgrammeVersionView> {
  const reason = requireReason(input.reason, actor);
  const settings: AiProgrammeSettings = {
    prices: input.prices,
    minSeats: input.minSeats,
    maxShareBps: input.maxShareBps,
    conversionTiers: input.conversionTiers,
    largeSchoolMinSeats: input.largeSchoolMinSeats,
    largeSchoolShareBps: input.largeSchoolShareBps,
    contentBonusTiers: input.contentBonusTiers,
    bonusRequiresConversionShare: input.bonusRequiresConversionShare,
    measurementOffsetDays: input.measurementOffsetDays,
    nonpaymentGraceDays: input.nonpaymentGraceDays,
    monthToMonthShareBps: input.monthToMonthShareBps,
    payoutMode: input.payoutMode,
  };
  refuseIssues(validateAiProgrammeSettings(settings), actor);

  const codes = settings.prices.map((p) => p.currencyCode);
  const currencies = await tx<{ id: string; code: string }[]>`
    SELECT id::text AS id, code FROM app.currencies WHERE code = ANY(${codes}::text[]) AND is_active
  `;
  if (currencies.length !== codes.length) {
    throw licenseError(422, ERROR_CODES.AI_PROGRAMME_CURRENCY_INVALID, actor.locale);
  }

  // One save at a time: the next number is read and written under this lock.
  await tx`SELECT pg_advisory_xact_lock(hashtext('app.ai_programme_versions'))`;
  const before = await currentAiProgrammeVersion(tx);
  if (input.basedOnVersionId && input.basedOnVersionId !== before.id) {
    throw licenseError(409, ERROR_CODES.AI_PROGRAMME_VERSION_CONFLICT, actor.locale);
  }

  let id: string;
  try {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_programme_versions (
        version_number, min_seats, max_share_bps, large_school_min_seats, large_school_share_bps,
        bonus_requires_conversion_share, measurement_offset_days, nonpayment_grace_days,
        month_to_month_share_bps, payout_mode, reason, created_by, created_by_school_id
      ) VALUES (
        ${before.versionNumber + 1}, ${settings.minSeats}, ${settings.maxShareBps},
        ${settings.largeSchoolMinSeats}, ${settings.largeSchoolShareBps},
        ${settings.bonusRequiresConversionShare}, ${settings.measurementOffsetDays},
        ${settings.nonpaymentGraceDays}, ${settings.monthToMonthShareBps}, ${settings.payoutMode},
        ${reason}, ${actor.userId}::uuid, ${actor.homeSchoolId}::uuid
      )
      RETURNING id::text AS id
    `;
    id = row!.id;
  } catch (err) {
    rethrowConflict(err, actor);
  }
  const currencyId = new Map(currencies.map((c) => [c.code, c.id]));
  await tx`
    INSERT INTO app.ai_programme_version_prices ${tx(
      settings.prices.map((p) => ({
        version_id: id,
        currency_id: currencyId.get(p.currencyCode)!,
        iap_price_minor: p.iapPriceMinor,
        license_price_minor: p.licensePriceMinor,
        parent_price_minor: p.parentPriceMinor,
      })),
    )}
  `;
  await insertTiers(tx, "version", id, null, settings.conversionTiers, settings.contentBonusTiers);

  const after = (await readAiProgrammeVersion(tx, id))!;
  await auditPlatformChange(tx, actor, {
    action: "insert",
    targetTable: "ai_programme_versions",
    targetId: id,
    oldValues: { version_number: before.versionNumber, ...settingsSnapshot(before.settings) },
    newValues: {
      version_number: after.versionNumber,
      reason,
      ...settingsSnapshot(after.settings),
    },
  });
  return after;
}

async function insertTiers(
  tx: TransactionSql,
  owner: "version" | "override",
  ownerId: string,
  schoolId: string | null,
  conversion: readonly AiProgrammeTier[] | null,
  bonus: readonly AiProgrammeTier[] | null,
): Promise<void> {
  const rows = [
    ...(conversion ?? []).map((t) => ({ kind: "conversion", ...t })),
    ...(bonus ?? []).map((t) => ({ kind: "content_bonus", ...t })),
  ];
  if (rows.length === 0) return;
  if (owner === "version") {
    await tx`
      INSERT INTO app.ai_programme_version_tiers ${tx(
        rows.map((r) => ({
          version_id: ownerId,
          kind: r.kind,
          from_bps: r.fromBps,
          share_bps: r.shareBps,
        })),
      )}
    `;
    return;
  }
  await tx`
    INSERT INTO app.ai_programme_school_override_tiers ${tx(
      rows.map((r) => ({
        school_id: schoolId!,
        override_id: ownerId,
        kind: r.kind,
        from_bps: r.fromBps,
        share_bps: r.shareBps,
      })),
    )}
  `;
}

/** What the console sends for a school: the override fields; its prices are in the school's currency. */
export type SchoolOverrideInput = Omit<AiProgrammeOverride, "priceCurrencyCode"> & {
  reason: string;
  /** The override version the super admin edited (null: the school had none); refused if stale. */
  basedOnOverrideId?: string | null;
};

/**
 * Validate a school's draft override against the global version in force, in the school's currency,
 * without saving it: the console's live preview. Reports problems rather than refusing.
 */
export async function previewSchoolOverride(
  tx: TransactionSql,
  draft: Omit<AiProgrammeOverride, "priceCurrencyCode">,
): Promise<{ effective: ResolvedAiProgramme; issues: AiProgrammeIssue[] }> {
  const global = await currentAiProgrammeVersion(tx);
  const currencyCode = await schoolCurrencyCode(tx);
  const override = withSchoolCurrency(draft, currencyCode);
  return {
    effective: resolveAiProgramme(global.settings, override, currencyCode),
    issues: validateAiProgrammeOverride(override, global.settings),
  };
}

function withSchoolCurrency(
  draft: Omit<AiProgrammeOverride, "priceCurrencyCode">,
  currencyCode: string,
): AiProgrammeOverride {
  const hasPrice = draft.licensePriceMinor !== null || draft.parentPriceMinor !== null;
  return { ...draft, priceCurrencyCode: hasPrice ? currencyCode : null };
}

/**
 * Save a new override version for the school the transaction is scoped to. An empty one clears the
 * school's overrides (the school inherits everything again). Existing licences keep theirs.
 */
export async function saveSchoolOverride(
  tx: TransactionSql,
  schoolId: string,
  input: SchoolOverrideInput,
  actor: LicenseActor,
): Promise<AiProgrammeOverrideView | null> {
  const reason = requireReason(input.reason, actor);
  const { reason: _r, basedOnOverrideId, ...fields } = input;
  const global = await currentAiProgrammeVersion(tx);
  const currencyCode = await schoolCurrencyCode(tx);
  const override = withSchoolCurrency(fields, currencyCode);
  refuseIssues(validateAiProgrammeOverride(override, global.settings), actor);

  await tx`SELECT pg_advisory_xact_lock(hashtext('app.ai_programme_school_overrides'), hashtext(${schoolId}))`;
  const before = await currentAiProgrammeOverride(tx);
  if (basedOnOverrideId !== undefined && (basedOnOverrideId ?? null) !== (before?.id ?? null)) {
    throw licenseError(409, ERROR_CODES.AI_PROGRAMME_VERSION_CONFLICT, actor.locale);
  }
  // Clearing a school that has nothing to clear writes nothing.
  if (isEmptyAiProgrammeOverride(override) && (before === null || before.empty)) return before;

  const [currency] = override.priceCurrencyCode
    ? await tx<{ id: string }[]>`
        SELECT id::text AS id FROM app.currencies WHERE code = ${override.priceCurrencyCode}
      `
    : [null];
  let id: string;
  try {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_programme_school_overrides (
        school_id, version_number, price_currency_id, license_price_minor, parent_price_minor,
        min_seats, max_share_bps, large_school_min_seats, large_school_share_bps,
        bonus_requires_conversion_share, measurement_offset_days, nonpayment_grace_days,
        month_to_month_share_bps, payout_mode, reason, created_by, created_by_school_id
      ) VALUES (
        ${schoolId}::uuid, ${(before?.versionNumber ?? 0) + 1}, ${currency?.id ?? null}::uuid,
        ${override.licensePriceMinor}, ${override.parentPriceMinor}, ${override.minSeats},
        ${override.maxShareBps}, ${override.largeSchoolMinSeats}, ${override.largeSchoolShareBps},
        ${override.bonusRequiresConversionShare}, ${override.measurementOffsetDays},
        ${override.nonpaymentGraceDays}, ${override.monthToMonthShareBps}, ${override.payoutMode},
        ${reason}, ${actor.userId}::uuid, ${actor.homeSchoolId}::uuid
      )
      RETURNING id::text AS id
    `;
    id = row!.id;
  } catch (err) {
    rethrowConflict(err, actor);
  }
  await insertTiers(
    tx,
    "override",
    id,
    schoolId,
    override.conversionTiers,
    override.contentBonusTiers,
  );
  const after = (await readAiProgrammeOverride(tx, id))!;
  await auditLicenseChange(tx, schoolId, actor, {
    action: "insert",
    targetTable: "ai_programme_school_overrides",
    targetId: id,
    oldValues: before ? { version_number: before.versionNumber, ...before.override } : null,
    newValues: {
      version_number: after.versionNumber,
      reason,
      cleared: after.empty,
      ...after.override,
    },
  });
  return after;
}

/** Clear the school's overrides: a new, empty override version. */
export function clearSchoolOverride(
  tx: TransactionSql,
  schoolId: string,
  input: { reason: string; basedOnOverrideId?: string | null },
  actor: LicenseActor,
): Promise<AiProgrammeOverrideView | null> {
  const { priceCurrencyCode: _c, ...empty } = EMPTY_AI_PROGRAMME_OVERRIDE;
  return saveSchoolOverride(tx, schoolId, { ...empty, ...input }, actor);
}

// ---------------------------------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------------------------------

/** The columns a licence carries for its programme values, from a stamp in its currency. */
export async function programmeColumnsFor(
  tx: TransactionSql,
  stamp: AiProgrammeStamp,
  currencyCode: string,
): Promise<AiProgrammeStamp & { nonpaymentGraceDays: number }> {
  const values = await resolveAiProgrammeValues(tx, stamp, currencyCode);
  return { ...stamp, nonpaymentGraceDays: values.nonpaymentGraceDays };
}

/**
 * Sign a licence with a stamp: its two version ids, now as the time they were attached, and the
 * grace period they resolve to. Does not touch updated_at -- the licence's terms are unchanged, so a
 * quote priced on it does not go stale.
 */
export async function attachAiProgramme(
  tx: TransactionSql,
  license: Pick<LicenseRecord, "id" | "currencyCode">,
  stamp: AiProgrammeStamp,
): Promise<void> {
  const columns = await programmeColumnsFor(tx, stamp, license.currencyCode);
  await tx`
    UPDATE app.school_licenses
    SET ai_programme_version_id = ${columns.versionId}::uuid,
        ai_programme_override_id = ${columns.overrideId}::uuid,
        ai_programme_applied_at = CURRENT_TIMESTAMP,
        nonpayment_grace_days = ${columns.nonpaymentGraceDays}
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${license.id}::uuid
  `;
}

/** What a licence shows of its programme values in lists: the versions and whether they are current. */
export interface LicenseAiProgrammeStampView {
  versionId: string;
  versionNumber: number;
  overrideId: string | null;
  overrideVersionNumber: number | null;
  appliedAt: string;
  nonpaymentGraceDays: number;
  /** True when it carries the versions in force now. */
  current: boolean;
}

export async function licenseAiProgrammeStamp(
  tx: TransactionSql,
  license: LicenseRecord,
): Promise<LicenseAiProgrammeStampView> {
  const [row] = await tx<{ version_number: number; override_number: number | null }[]>`
    SELECT
      (SELECT version_number FROM app.ai_programme_versions
       WHERE id = ${license.aiProgrammeVersionId}::uuid) AS version_number,
      (SELECT version_number FROM app.ai_programme_school_overrides
       WHERE school_id = current_setting('app.school_id')::uuid
         AND id = ${license.aiProgrammeOverrideId}::uuid) AS override_number
  `;
  const now = await currentAiProgrammeStamp(tx);
  return {
    versionId: license.aiProgrammeVersionId,
    versionNumber: row!.version_number,
    overrideId: license.aiProgrammeOverrideId,
    overrideVersionNumber: row!.override_number,
    appliedAt: license.aiProgrammeAppliedAt.toISOString(),
    nonpaymentGraceDays: license.nonpaymentGraceDays,
    current:
      now.versionId === license.aiProgrammeVersionId &&
      now.overrideId === license.aiProgrammeOverrideId,
  };
}

export interface LicenseAiProgrammeView {
  licenseId: string;
  stamp: LicenseAiProgrammeStampView;
  /** What the licence was signed with. */
  signed: ResolvedAiProgramme;
  /** What it would get if the current values were applied now. */
  current: ResolvedAiProgramme;
  currentVersionNumber: number;
  currentOverrideVersionNumber: number | null;
  /** The fields that would change. */
  changes: AiProgrammeField[];
}

export async function licenseAiProgramme(
  tx: TransactionSql,
  license: LicenseRecord,
): Promise<LicenseAiProgrammeView> {
  const stamp = await licenseAiProgrammeStamp(tx, license);
  const signed = await resolveAiProgrammeStamp(
    tx,
    { versionId: license.aiProgrammeVersionId, overrideId: license.aiProgrammeOverrideId },
    license.currencyCode,
  );
  const current = await resolveAiProgrammeStamp(
    tx,
    await currentAiProgrammeStamp(tx),
    license.currencyCode,
  );
  return {
    licenseId: license.id,
    stamp,
    signed: signed.values,
    current: current.values,
    currentVersionNumber: current.version.versionNumber,
    currentOverrideVersionNumber: current.override?.versionNumber ?? null,
    changes: aiProgrammeChanges(signed.values, current.values),
  };
}

/** Licences that can still take new values: not ended. */
const REAPPLICABLE = new Set(["draft", "awaiting_payment", "active", "suspended"]);

/**
 * Re-apply the values in force now to a licence (the super admin's explicit choice, with a reason).
 * Audited with the versions before and after and the fields that changed.
 */
export async function reapplyAiProgramme(
  tx: TransactionSql,
  schoolId: string,
  license: LicenseRecord,
  reasonInput: string,
  actor: LicenseActor,
): Promise<LicenseAiProgrammeView> {
  const reason = requireReason(reasonInput, actor);
  if (!REAPPLICABLE.has(license.status)) {
    throw licenseError(409, ERROR_CODES.LICENSE_NOT_EDITABLE, actor.locale);
  }
  const before = await licenseAiProgramme(tx, license);
  const stamp = await currentAiProgrammeStamp(tx);
  await attachAiProgramme(tx, license, stamp);
  await auditLicenseChange(tx, schoolId, actor, {
    action: "update",
    targetTable: "school_licenses",
    targetId: license.id,
    oldValues: {
      ai_programme_version: before.stamp.versionNumber,
      ai_programme_override_version: before.stamp.overrideVersionNumber,
      nonpayment_grace_days: before.signed.nonpaymentGraceDays,
    },
    newValues: {
      ai_programme_version: before.currentVersionNumber,
      ai_programme_override_version: before.currentOverrideVersionNumber,
      nonpayment_grace_days: before.current.nonpaymentGraceDays,
      ai_programme_reapplied: true,
      changed_fields: before.changes,
      reason,
    },
  });
  const [row] = await tx<{ applied_at: Date }[]>`
    SELECT ai_programme_applied_at AS applied_at FROM app.school_licenses
    WHERE school_id = current_setting('app.school_id')::uuid AND id = ${license.id}::uuid
  `;
  return licenseAiProgramme(tx, {
    ...license,
    aiProgrammeVersionId: stamp.versionId,
    aiProgrammeOverrideId: stamp.overrideId,
    aiProgrammeAppliedAt: row!.applied_at,
    nonpaymentGraceDays: before.current.nonpaymentGraceDays,
  });
}
