import type { components } from "@studafy/api-client";

/**
 * What a paid feature's page shows, decided from the person's `GET /api/me/features` verdict
 * (docs/billing/feature-licensing.md, session 6). The web twin of the mobile app's
 * `core/features/feature_gate.dart`: the same states, the same rules, so a person sees the same
 * answer on both.
 *
 *   - covered personally, by a school seat, or by both (then the personal renewal is off); a
 *     covered feature may have used up this month's limit;
 *   - not covered, and the school sells a seat that includes it (or the person already holds a
 *     seat): ask the school -- never a purchase;
 *   - not covered, nothing from the school: the purchase;
 *   - the school is inactive, or Studafy paused the feature.
 *
 * A person holding a school seat is never `purchasable`.
 */

export type MyFeature = components["schemas"]["MyFeature"];
export type MyFeatures = components["schemas"]["MyFeaturesResponse"];
export type FeatureKey = MyFeature["key"];

export type FeatureGateState =
  | {
      kind: "covered";
      coverage: "personal" | "school" | "both";
      schoolName: string;
      used: number;
      /** Units a month; null is unlimited or nothing counted. */
      limit: number | null;
      limitReached: boolean;
      /** When usage resets: the 1st of next month, UTC (ISO date). */
      resetsOn: string;
      /** `both`: when the personal subscription ends (it does not renew). */
      personalEndsAt: string | null;
      /** `both` through the App Store: the person must turn renewal off themselves. */
      mustTurnOffAppStoreRenewal: boolean;
    }
  | { kind: "askSchool"; schoolName: string; hasSeat: boolean }
  | { kind: "purchasable"; expiredOn: string | null }
  | { kind: "schoolInactive" }
  | { kind: "unavailable" };

/** The 1st of the month after `now`, UTC, as YYYY-MM-DD: when monthly usage resets. */
export function usageResetsOn(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}

export function featureGateState(
  features: MyFeatures,
  key: FeatureKey,
  now: Date = new Date(),
): FeatureGateState {
  const feature = features.features.find((f) => f.key === key);
  if (!feature) return { kind: "unavailable" };
  if (feature.reason === "school_inactive") return { kind: "schoolInactive" };
  if (feature.reason === "paused") return { kind: "unavailable" };

  if (feature.active) {
    const school = feature.sources.some((s) => s.source === "school_license");
    const personal = feature.sources.filter((s) => s.source !== "school_license");
    const coverage = school && personal.length > 0 ? "both" : school ? "school" : "personal";
    const personalEndsAt =
      coverage === "both"
        ? personal.map((s) => s.periodEnd).sort((a, b) => Date.parse(b) - Date.parse(a))[0]!
        : null;
    const stop = feature.renewalStop;
    return {
      kind: "covered",
      coverage,
      schoolName: features.schoolName,
      used: feature.used,
      limit: feature.unit === null ? null : feature.limit,
      limitReached: feature.reason === "limit_reached",
      resetsOn: usageResetsOn(now),
      personalEndsAt,
      mustTurnOffAppStoreRenewal:
        coverage === "both" &&
        stop !== null &&
        (stop.action === "notify_user" || stop.provider === "app_store"),
    };
  }

  if (feature.schoolSeat || feature.schoolOffers) {
    return { kind: "askSchool", schoolName: features.schoolName, hasSeat: feature.schoolSeat };
  }
  return {
    kind: "purchasable",
    expiredOn: feature.reason === "expired" ? feature.periodEnd : null,
  };
}

/**
 * The `site.features.errors.*` key of a friendly message for an API refusal of a paid feature, or
 * null for any other code. The AI routes still answer their legacy `AI_*` codes until every client
 * reads `FEATURE_*` (session 1, decision 7); both map.
 */
export function featureErrorMessageKey(code: string | undefined | null): string | null {
  switch (code) {
    case "FEATURE_NOT_INCLUDED":
    case "AI_SUBSCRIPTION_INACTIVE":
      return "site.features.errors.notIncluded";
    case "FEATURE_EXPIRED":
      return "site.features.errors.expired";
    case "FEATURE_LIMIT_REACHED":
      return "site.features.errors.limitReached";
    case "AI_SCHOOL_INACTIVE":
    case "AI_SUBSCRIPTION_SCHOOL_NOT_ACTIVE":
    case "SCHOOL_SUSPENDED":
      return "site.features.errors.schoolInactive";
    case "AI_SUBSCRIPTION_COVERED_BY_SCHOOL":
      return "site.features.errors.coveredBySchool";
    default:
      return null;
  }
}
