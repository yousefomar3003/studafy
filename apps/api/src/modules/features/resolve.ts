import { FEATURE_KEYS, FEATURES } from "@studafy/constants";

import type { FeatureCatalog, Tier } from "./catalog";
import type { FeatureKey } from "@studafy/constants";

/**
 * Feature resolution: from a person's grants to one verdict per feature. Pure -- every input is
 * handed in, so the rule is tested without a database (resolve.test.ts).
 *
 * The rule (docs/billing/feature-licensing.md): a feature is active when the school is active AND
 * some live grant covers the person with a tier that includes the feature. When several grants
 * cover the same person -- a personal subscription and a school seat, say -- the person gets the
 * best of them, feature by feature: active if any grant includes it, the highest limit (unlimited
 * beats any number), and the latest period end. Every contributing grant is recorded.
 */

/** Where a grant came from, as reported to clients. */
export type GrantSource = "purchase" | "school_license" | "trial";

/** One thing that entitles a person to a tier. Built by the adapters in ./grants.ts. */
export interface FeatureGrant {
  source: GrantSource;
  /** The tier's `app.plans.code`. */
  tierCode: string;
  /** In force (a live status), before the school is taken into account. */
  live: boolean;
  /** ISO-8601 billing window of the grant. */
  periodStart: string;
  periodEnd: string;
  /** The row behind it, for logs and support: `ai_subscriptions:<id>`, `user_subscriptions:<id>`. */
  ref: string;
}

/** Why a feature is not active. `limit_reached` is informational: the feature is still active. */
export type FeatureReason =
  "school_inactive" | "paused" | "not_included" | "expired" | "limit_reached";

export interface FeatureContribution {
  source: GrantSource;
  tierCode: string;
  limit: number | null;
  periodEnd: string;
}

export interface FeatureAccess {
  key: FeatureKey;
  active: boolean;
  /** The source of the grant whose period is reported (the latest-ending one); null when inactive. */
  source: GrantSource | null;
  /** Every live grant that includes the feature, latest period end first. */
  sources: FeatureContribution[];
  /** Units per calendar month (UTC); null is unlimited or unmetered. */
  limit: number | null;
  /** Units used this calendar month. */
  used: number;
  /** The reported grant's billing window; for an expired feature, the window that ended. */
  periodStart: string | null;
  periodEnd: string | null;
  reason: FeatureReason | null;
}

export type FeatureAccessMap = Record<FeatureKey, FeatureAccess>;

export interface ResolveFeatureAccessInput {
  catalog: FeatureCatalog;
  grants: readonly FeatureGrant[];
  schoolActive: boolean;
  /** Units used this month per feature; absent is zero. */
  usage?: Partial<Record<FeatureKey, number>>;
}

/**
 * Whether a tier includes a feature, and at what monthly limit.
 *
 * An explicit `plan_features` row wins. Otherwise a tier with `includes_all_features` includes every
 * feature of its own audience at the feature's code default -- which is how a top tier picks up a
 * feature registered after it was defined.
 */
export function tierIncludes(
  tier: Tier,
  key: FeatureKey,
): { included: false } | { included: true; limit: number | null } {
  if (Object.hasOwn(tier.limits, key)) {
    return { included: true, limit: tier.limits[key] ?? null };
  }
  if (tier.includesAllFeatures && FEATURES[key].audience === tier.audience) {
    return { included: true, limit: FEATURES[key].defaultMonthlyLimit };
  }
  return { included: false };
}

function byPeriodEndDesc(a: { periodEnd: string }, b: { periodEnd: string }): number {
  return Date.parse(b.periodEnd) - Date.parse(a.periodEnd);
}

function resolveOne(key: FeatureKey, input: ResolveFeatureAccessInput): FeatureAccess {
  const used = input.usage?.[key] ?? 0;
  const inactive = (reason: FeatureReason, ended?: FeatureGrant): FeatureAccess => ({
    key,
    active: false,
    source: null,
    sources: [],
    limit: null,
    used,
    periodStart: ended?.periodStart ?? null,
    periodEnd: ended?.periodEnd ?? null,
    reason,
  });

  if (!input.schoolActive) return inactive("school_inactive");
  if (input.catalog.settings[key]?.status === "paused") return inactive("paused");

  const covering = input.grants
    .map((grant) => {
      const tier = input.catalog.tiers[grant.tierCode];
      const inclusion = tier ? tierIncludes(tier, key) : { included: false as const };
      return inclusion.included ? { grant, limit: inclusion.limit } : null;
    })
    .filter((entry) => entry !== null);

  const live = covering.filter((entry) => entry.grant.live);
  if (live.length === 0) {
    const ended = covering.map((entry) => entry.grant).sort(byPeriodEndDesc)[0];
    return ended ? inactive("expired", ended) : inactive("not_included");
  }

  live.sort((a, b) => byPeriodEndDesc(a.grant, b.grant));
  const primary = live[0]!.grant;

  // An unmetered feature has nothing to limit, whatever a tier row says.
  const metered = FEATURES[key].unit !== null;
  const limit =
    !metered || live.some((entry) => entry.limit === null)
      ? null
      : Math.max(...live.map((entry) => entry.limit as number));

  return {
    key,
    active: true,
    source: primary.source,
    sources: live.map((entry) => ({
      source: entry.grant.source,
      tierCode: entry.grant.tierCode,
      limit: metered ? entry.limit : null,
      periodEnd: entry.grant.periodEnd,
    })),
    limit,
    used,
    periodStart: primary.periodStart,
    periodEnd: primary.periodEnd,
    reason: limit !== null && used >= limit ? "limit_reached" : null,
  };
}

/** One verdict for every registered feature. */
export function resolveFeatureAccess(input: ResolveFeatureAccessInput): FeatureAccessMap {
  const result = {} as FeatureAccessMap;
  for (const key of FEATURE_KEYS) result[key] = resolveOne(key, input);
  return result;
}

/** The first day of the calendar month (UTC) `now` falls in: the usage period key. */
export function usagePeriodStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Seconds until the next usage period starts: the Retry-After of FEATURE_LIMIT_REACHED. */
export function secondsUntilNextUsagePeriod(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
