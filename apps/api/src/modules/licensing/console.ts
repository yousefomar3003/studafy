import { ERROR_CODES, FEATURE_KEYS, FEATURES } from "@studafy/constants";
import postgres from "postgres";

import { usagePeriodStart } from "../features/resolve";

import { licenseError } from "./context";
import { forEachSchool, listPayments } from "./invoices";
import { auditPlatformChange } from "./pricing";
import {
  currentLicense,
  licenseUsage,
  listChangeRequests,
  listLicenses,
  platformLicenseView,
} from "./service";

import type { LicenseActor } from "./context";
import type { PaymentView } from "./invoices";
import type { Audience, ChangeRequestView, FeatureUsageView, PlatformLicenseView } from "./service";
import type { Database, DatabasePools } from "../../db/client";
import type { FeatureKey, FeatureUsageUnit } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * The super admin console's reads and writes beyond quotes and invoices (session 4 of
 * docs/billing/feature-licensing.md): the feature catalog, tiers with their features and prices,
 * every school's licenses and change requests in one list, a school's license overview (usage,
 * payments, history) and usage next to license revenue.
 *
 * Features, tiers and prices are global tables: written in a system transaction and audited once,
 * in the operator's home school. The feature service caches the catalog for 30 seconds per process,
 * so an edit reaches every pod within that window (session 1, decision 11).
 */

// ---------------------------------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------------------------------

export const FEATURE_STATUSES = ["active", "paused", "hidden"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export interface ConsoleFeature {
  key: FeatureKey;
  displayName: string;
  status: FeatureStatus;
  audience: Audience;
  unit: FeatureUsageUnit | null;
  defaultMonthlyLimit: number | null;
  nameKey: string;
  /** Tiers that include it, by row or by `includes_all_features`. */
  tierCount: number;
}

/** Every registered feature: the super admin's settings and the code's facts. */
export async function listConsoleFeatures(tx: TransactionSql): Promise<ConsoleFeature[]> {
  const rows = await tx<
    { key: string; display_name: string; status: FeatureStatus; tiers: number }[]
  >`
    SELECT f.key, f.display_name, f.status,
           (SELECT count(DISTINCT p.id)::int FROM app.plans AS p
            WHERE p.audience IS NOT NULL AND p.is_active
              AND (EXISTS (SELECT 1 FROM app.plan_features AS pf
                           WHERE pf.plan_id = p.id AND pf.feature_key = f.key)
                   OR p.includes_all_features)) AS tiers
    FROM app.features AS f
    ORDER BY f.key
  `;
  const known = new Map(rows.map((row) => [row.key, row]));
  return FEATURE_KEYS.flatMap((key) => {
    const row = known.get(key);
    if (!row) return [];
    const feature = FEATURES[key];
    // includes_all_features only reaches the features of the tier's own audience.
    return [
      {
        key,
        displayName: row.display_name,
        status: row.status,
        audience: feature.audience,
        unit: feature.unit,
        defaultMonthlyLimit: feature.defaultMonthlyLimit,
        nameKey: feature.nameKey,
        tierCount: row.tiers,
      },
    ];
  });
}

export async function updateConsoleFeature(
  tx: TransactionSql,
  key: FeatureKey,
  patch: { displayName?: string; status?: FeatureStatus },
  actor: LicenseActor,
): Promise<ConsoleFeature> {
  const [before] = await tx<{ display_name: string; status: FeatureStatus }[]>`
    SELECT display_name, status FROM app.features WHERE key = ${key} FOR UPDATE
  `;
  if (!before) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
  const after = {
    display_name: patch.displayName?.trim() ?? before.display_name,
    status: patch.status ?? before.status,
  };
  await tx`
    UPDATE app.features
    SET display_name = ${after.display_name}, status = ${after.status},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE key = ${key}
  `;
  // features has a text key, not a uuid; the audit row targets a stable id derived from it.
  await auditPlatformChange(tx, actor, {
    action: "update",
    targetTable: "features",
    targetId: await featureAuditId(tx, key),
    oldValues: { key, ...before },
    newValues: { key, ...after },
  });
  return (await listConsoleFeatures(tx)).find((feature) => feature.key === key)!;
}

/** audit_logs.target_id is a uuid; a feature's key is not. A name-based uuid keeps it stable. */
async function featureAuditId(tx: TransactionSql, key: string): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    SELECT (md5('app.features:' || ${key}))::uuid::text AS id
  `;
  return row!.id;
}

// ---------------------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------------------

export interface TierFeature {
  key: FeatureKey;
  /** Null is unlimited. */
  monthlyLimit: number | null;
}

export interface TierPrice {
  currencyCode: string;
  minorUnit: number;
  amountMinor: number;
  isActive: boolean;
}

export interface ConsoleTier {
  id: string;
  code: string;
  displayName: string;
  description: string | null;
  audience: Audience;
  rank: number;
  includesAllFeatures: boolean;
  isActive: boolean;
  features: TierFeature[];
  /** Monthly seat prices. */
  prices: TierPrice[];
  /** Licenses (any status but cancelled) and personal subscriptions using it: editing reaches them. */
  inUse: number;
}

export async function listTiers(tx: TransactionSql): Promise<ConsoleTier[]> {
  const plans = await tx<
    {
      id: string;
      code: string;
      display_name: string;
      description: string | null;
      audience: Audience;
      rank: number;
      includes_all_features: boolean;
      is_active: boolean;
    }[]
  >`
    SELECT id::text AS id, code, display_name, description, audience, rank, includes_all_features,
           is_active
    FROM app.plans
    WHERE audience IS NOT NULL
    ORDER BY audience, is_active DESC, rank, code
  `;
  if (plans.length === 0) return [];
  const ids = plans.map((plan) => plan.id);
  const features = await tx<
    { plan_id: string; feature_key: FeatureKey; monthly_limit: number | null }[]
  >`
    SELECT plan_id::text AS plan_id, feature_key, monthly_limit
    FROM app.plan_features WHERE plan_id = ANY(${ids}::uuid[])
    ORDER BY feature_key
  `;
  const prices = await tx<
    {
      plan_id: string;
      code: string;
      minor_unit: number;
      amount_minor: string;
      is_active: boolean;
    }[]
  >`
    SELECT pp.plan_id::text AS plan_id, c.code, c.minor_unit::int AS minor_unit,
           pp.amount_minor::text AS amount_minor, pp.is_active
    FROM app.plan_prices AS pp
    JOIN app.currencies AS c ON c.id = pp.currency_id
    WHERE pp.plan_id = ANY(${ids}::uuid[]) AND pp.billing_interval = 'monthly'
    ORDER BY c.code
  `;
  // Usage is per school: licenses and personal subscriptions are tenant rows. A count of zero is
  // what matters ("safe to change"), and the console is small, so walk the schools once.
  const usage = new Map<string, number>();
  const schools = await tx<{ id: string }[]>`SELECT id::text AS id FROM app.schools`;
  for (const school of schools) {
    await tx`SELECT set_config('app.school_id', ${school.id}, true)`;
    const rows = await tx<{ plan_id: string; n: number }[]>`
      SELECT plan_id::text AS plan_id, count(*)::int AS n FROM (
        SELECT unnest(ARRAY[student_plan_id, teacher_plan_id, parent_plan_id]) AS plan_id
        FROM app.school_licenses
        WHERE school_id = current_setting('app.school_id')::uuid AND status <> 'cancelled'
        UNION ALL
        SELECT plan_id FROM app.user_subscriptions
        WHERE school_id = current_setting('app.school_id')::uuid
      ) AS used
      WHERE plan_id = ANY(${ids}::uuid[])
      GROUP BY plan_id
    `;
    for (const row of rows) usage.set(row.plan_id, (usage.get(row.plan_id) ?? 0) + row.n);
  }
  await tx`SELECT set_config('app.school_id', '', true)`;

  return plans.map((plan) => ({
    id: plan.id,
    code: plan.code,
    displayName: plan.display_name,
    description: plan.description,
    audience: plan.audience,
    rank: plan.rank,
    includesAllFeatures: plan.includes_all_features,
    isActive: plan.is_active,
    features: features
      .filter((row) => row.plan_id === plan.id)
      .map((row) => ({ key: row.feature_key, monthlyLimit: row.monthly_limit })),
    prices: prices
      .filter((row) => row.plan_id === plan.id)
      .map((row) => ({
        currencyCode: row.code,
        minorUnit: row.minor_unit,
        amountMinor: Number(row.amount_minor),
        isActive: row.is_active,
      })),
    inUse: usage.get(plan.id) ?? 0,
  }));
}

export interface TierInput {
  displayName: string;
  description?: string | null;
  rank: number;
  includesAllFeatures: boolean;
  isActive?: boolean;
  features: TierFeature[];
  /** Monthly seat prices; a currency left out is switched off (kept, as subscriptions may use it). */
  prices: { currencyCode: string; amountMinor: number }[];
}

function tierSnapshot(tier: ConsoleTier): Record<string, unknown> {
  return {
    code: tier.code,
    display_name: tier.displayName,
    description: tier.description,
    audience: tier.audience,
    rank: tier.rank,
    includes_all_features: tier.includesAllFeatures,
    is_active: tier.isActive,
    features: tier.features,
    prices: tier.prices.map((p) => ({
      currency: p.currencyCode,
      amount_minor: p.amountMinor,
      active: p.isActive,
    })),
  };
}

async function readTier(tx: TransactionSql, planId: string): Promise<ConsoleTier | null> {
  return (await listTiers(tx)).find((tier) => tier.id === planId) ?? null;
}

/** Map a tier write's database refusals to coded errors (duplicate code, rank taken). */
function rethrowTierError(err: unknown, actor: LicenseActor): never {
  if (err instanceof postgres.PostgresError) {
    if (
      err.constraint_name === "uq_plans_code" ||
      err.constraint_name === "uq_plans_active_audience_rank"
    ) {
      throw licenseError(409, ERROR_CODES.CONFLICT_DUPLICATE_ENTRY, actor.locale);
    }
    if (err.code === "23514") throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  }
  throw err;
}

async function writeTierContents(
  tx: TransactionSql,
  planId: string,
  audience: Audience,
  input: TierInput,
  actor: LicenseActor,
): Promise<void> {
  for (const feature of input.features) {
    if (!FEATURE_KEYS.includes(feature.key) || FEATURES[feature.key].audience !== audience) {
      throw licenseError(422, ERROR_CODES.LICENSE_TIER_INVALID, actor.locale);
    }
  }
  await tx`DELETE FROM app.plan_features WHERE plan_id = ${planId}::uuid`;
  if (input.features.length > 0) {
    await tx`
      INSERT INTO app.plan_features ${tx(
        input.features.map((f) => ({
          plan_id: planId,
          feature_key: f.key,
          monthly_limit: f.monthlyLimit,
        })),
      )}
    `;
  }

  const currencies = await tx<{ id: string; code: string }[]>`
    SELECT id::text AS id, code FROM app.currencies
    WHERE code = ANY(${input.prices.map((p) => p.currencyCode)}::text[]) AND is_active
  `;
  if (currencies.length !== new Set(input.prices.map((p) => p.currencyCode)).size) {
    throw licenseError(422, ERROR_CODES.VALIDATION_FAILED, actor.locale);
  }
  for (const price of input.prices) {
    const currencyId = currencies.find((c) => c.code === price.currencyCode)!.id;
    await tx`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor, is_active)
      VALUES (${planId}::uuid, ${currencyId}::uuid, 'monthly', ${price.amountMinor}, true)
      ON CONFLICT ON CONSTRAINT uq_plan_prices_plan_currency_interval DO UPDATE SET
        amount_minor = EXCLUDED.amount_minor, is_active = true,
        updated_at = GREATEST(CURRENT_TIMESTAMP, app.plan_prices.updated_at)
    `;
  }
  await tx`
    UPDATE app.plan_prices SET is_active = false,
      updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
    WHERE plan_id = ${planId}::uuid AND billing_interval = 'monthly' AND is_active
      AND currency_id <> ALL(${currencies.map((c) => c.id)}::uuid[])
  `;
}

export async function createTier(
  tx: TransactionSql,
  input: TierInput & { code: string; audience: Audience },
  actor: LicenseActor,
): Promise<ConsoleTier> {
  try {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, description, is_active, audience, rank, includes_all_features)
      VALUES (${input.code}, ${input.displayName.trim()}, ${input.description?.trim() || null},
              ${input.isActive ?? true}, ${input.audience}, ${input.rank}, ${input.includesAllFeatures})
      RETURNING id::text AS id
    `;
    await writeTierContents(tx, row!.id, input.audience, input, actor);
    const tier = (await readTier(tx, row!.id))!;
    await auditPlatformChange(tx, actor, {
      action: "insert",
      targetTable: "plans",
      targetId: tier.id,
      newValues: tierSnapshot(tier),
    });
    return tier;
  } catch (err) {
    rethrowTierError(err, actor);
  }
}

/** Replace a tier's settings, features and prices. Its code and audience are fixed. */
export async function updateTier(
  tx: TransactionSql,
  planId: string,
  input: TierInput,
  actor: LicenseActor,
): Promise<ConsoleTier> {
  const before = await readTier(tx, planId);
  if (!before) throw licenseError(404, ERROR_CODES.RESOURCE_NOT_FOUND, actor.locale);
  try {
    await tx`
      UPDATE app.plans SET
        display_name = ${input.displayName.trim()},
        description = ${input.description === undefined ? before.description : input.description?.trim() || null},
        rank = ${input.rank},
        includes_all_features = ${input.includesAllFeatures},
        is_active = ${input.isActive ?? before.isActive},
        updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE id = ${planId}::uuid
    `;
    await writeTierContents(tx, planId, before.audience, input, actor);
  } catch (err) {
    rethrowTierError(err, actor);
  }
  const after = (await readTier(tx, planId))!;
  await auditPlatformChange(tx, actor, {
    action: "update",
    targetTable: "plans",
    targetId: planId,
    oldValues: tierSnapshot(before),
    newValues: tierSnapshot(after),
  });
  return after;
}

// ---------------------------------------------------------------------------------------------------
// Licenses and change requests across schools
// ---------------------------------------------------------------------------------------------------

export interface ConsoleLicense extends PlatformLicenseView {
  schoolName: string;
  /** Unpaid balance over the license's open invoices, in its currency. */
  balanceMinor: number;
  minorUnit: number;
  /** Days until it ends (negative once past). */
  daysLeft: number;
  /** The fullest audience: assigned / purchased, 0-1 (0 with no seats). */
  seatUse: number;
}

export interface LicenseListFilters {
  status?: PlatformLicenseView["status"];
  /** Active licenses ending within this many days. */
  expiringWithinDays?: number;
  /** An audience at or above this share of its seats (0-1). */
  seatsNearlyFull?: number;
  /** Only licenses with an unpaid balance. */
  unpaid?: boolean;
}

const DAY_MS = 86_400_000;

export async function listLicensesAcrossSchools(
  database: Database | DatabasePools,
  filters: LicenseListFilters,
  now: Date = new Date(),
): Promise<ConsoleLicense[]> {
  const all = await forEachSchool(database, null, async (tx, school) => {
    const licenses = await listLicenses(tx);
    if (licenses.length === 0) return [];
    const balances = await tx<{ license_id: string; balance: string }[]>`
      SELECT license_id::text AS license_id, sum(balance_minor)::text AS balance
      FROM app.license_invoices
      WHERE school_id = current_setting('app.school_id')::uuid
        AND status IN ('issued', 'partially_paid')
      GROUP BY license_id
    `;
    const minor = await tx<{ code: string; minor_unit: number }[]>`
      SELECT code, minor_unit::int AS minor_unit FROM app.currencies
    `;
    return licenses.map((license) => {
      const use = license.audiences
        .filter((a) => a.purchased > 0)
        .map((a) => a.assigned / a.purchased);
      return {
        ...license,
        schoolName: school.name,
        balanceMinor: Number(balances.find((b) => b.license_id === license.id)?.balance ?? 0),
        minorUnit: minor.find((m) => m.code === license.currencyCode)?.minor_unit ?? 2,
        daysLeft: Math.ceil((Date.parse(license.endsAt) - now.getTime()) / DAY_MS),
        seatUse: use.length > 0 ? Math.max(...use) : 0,
      };
    });
  });
  return all
    .filter((license) => !filters.status || license.status === filters.status)
    .filter(
      (license) =>
        filters.expiringWithinDays === undefined ||
        (license.status === "active" &&
          license.daysLeft >= 0 &&
          license.daysLeft <= filters.expiringWithinDays),
    )
    .filter(
      (license) =>
        filters.seatsNearlyFull === undefined || license.seatUse >= filters.seatsNearlyFull,
    )
    .filter((license) => !filters.unpaid || license.balanceMinor > 0)
    .sort(
      (a, b) => a.schoolName.localeCompare(b.schoolName) || b.startsAt.localeCompare(a.startsAt),
    );
}

export interface ConsoleChangeRequest extends ChangeRequestView {
  schoolId: string;
  schoolName: string;
}

/** Every school's seat change requests (open by default), oldest first: the inbox. */
export async function listChangeRequestsAcrossSchools(
  database: Database | DatabasePools,
  status: ChangeRequestView["status"] | undefined,
): Promise<ConsoleChangeRequest[]> {
  const all = await forEachSchool(database, null, async (tx, school) =>
    (await listChangeRequests(tx, status)).map((request) => ({
      ...request,
      schoolId: school.id,
      schoolName: school.name,
    })),
  );
  return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------------------------------
// One school's license overview
// ---------------------------------------------------------------------------------------------------

export interface LicenseHistoryEntry {
  id: string;
  action: string;
  targetTable: string;
  targetId: string;
  actorId: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  createdAt: string;
}

export interface SchoolLicenseConsole {
  license: PlatformLicenseView | null;
  usage: FeatureUsageView[];
  payments: PaymentView[];
  history: LicenseHistoryEntry[];
}

const LICENSE_TABLES = [
  "school_licenses",
  "license_seats",
  "license_seat_overlaps",
  "license_change_requests",
  "license_quotes",
  "license_invoices",
  "license_payments",
  "license_payment_receipts",
];

/**
 * A school's current license with this month's usage, its payment history, and the licensing
 * entries of its audit log (newest first, the latest 100). Rows written by the console carry no
 * actor in the school -- the operator's own row is in their home school (./context.ts).
 */
export async function schoolLicenseConsole(tx: TransactionSql): Promise<SchoolLicenseConsole> {
  const license = await currentLicense(tx);
  const history = await tx<
    {
      id: string;
      action: string;
      target_table: string;
      target_id: string;
      actor_id: string | null;
      old_values: Record<string, unknown> | null;
      new_values: Record<string, unknown> | null;
      created_at: Date;
    }[]
  >`
    SELECT id::text AS id, action::text AS action, target_table, target_id::text AS target_id,
           actor_id::text AS actor_id, old_values, new_values, created_at
    FROM app.audit_logs
    WHERE school_id = current_setting('app.school_id')::uuid
      AND target_table = ANY(${LICENSE_TABLES}::text[])
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `;
  return {
    license: license ? await platformLicenseView(tx, license) : null,
    usage: license ? await licenseUsage(tx, license.id) : [],
    payments: await listPayments(tx),
    history: history.map((row) => ({
      id: row.id,
      action: row.action,
      targetTable: row.target_table,
      targetId: row.target_id,
      actorId: row.actor_id,
      oldValues: row.old_values,
      newValues: row.new_values,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// Usage next to license revenue
// ---------------------------------------------------------------------------------------------------

export interface SchoolUsageRevenue {
  schoolId: string;
  schoolName: string;
  /** This calendar month's (UTC) units per metered feature, over everyone in the school. */
  usage: { feature: FeatureKey; unit: FeatureUsageUnit | null; used: number }[];
  /** License payments, per currency: received this month and in total. */
  revenue: {
    currencyCode: string;
    minorUnit: number;
    thisMonthMinor: number;
    totalMinor: number;
  }[];
}

export async function usageAndRevenue(
  database: Database | DatabasePools,
  now: Date = new Date(),
): Promise<{ periodStart: string; schools: SchoolUsageRevenue[] }> {
  const periodStart = usagePeriodStart(now);
  const schools = await forEachSchool(database, null, async (tx, school) => {
    const usage = await tx<{ feature_key: FeatureKey; used: string }[]>`
      SELECT feature_key, sum(used)::text AS used FROM app.feature_usage_meters
      WHERE school_id = current_setting('app.school_id')::uuid AND period_start = ${periodStart}::date
      GROUP BY feature_key
    `;
    const revenue = await tx<
      { code: string; minor_unit: number; this_month: string; total: string }[]
    >`
      SELECT c.code, c.minor_unit::int AS minor_unit,
             COALESCE(sum(p.amount_minor) FILTER (WHERE p.received_at >= ${periodStart}::date), 0)::text AS this_month,
             sum(p.amount_minor)::text AS total
      FROM app.license_payments AS p
      JOIN app.currencies AS c ON c.id = p.currency_id
      WHERE p.school_id = current_setting('app.school_id')::uuid AND p.voided_at IS NULL
      GROUP BY c.code, c.minor_unit
      ORDER BY c.code
    `;
    if (usage.length === 0 && revenue.length === 0) return [];
    return [
      {
        schoolId: school.id,
        schoolName: school.name,
        usage: FEATURE_KEYS.filter((key) => FEATURES[key].unit !== null).map((key) => ({
          feature: key,
          unit: FEATURES[key].unit,
          used: Number(usage.find((row) => row.feature_key === key)?.used ?? 0),
        })),
        revenue: revenue.map((row) => ({
          currencyCode: row.code,
          minorUnit: row.minor_unit,
          thisMonthMinor: Number(row.this_month),
          totalMinor: Number(row.total),
        })),
      },
    ];
  });
  return { periodStart, schools };
}
