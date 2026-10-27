import { LIVE_STATUSES } from "@studafy/billing";

import type { FeatureGrant } from "./resolve";
import type { AiEntitlement, UserEntitlement } from "../subscriptions/entitlements/resolve";

/**
 * Grant sources: where a person's feature grants come from.
 *
 * Each adapter turns one kind of entitlement row into {@link FeatureGrant}s. The resolver does not
 * know or care which kinds exist -- it merges whatever {@link GRANT_SOURCES} hands it -- so a new
 * kind of grant is one adapter appended to the list: read the rows into `UserEntitlement`
 * (resolveUserEntitlement, so they are cached and invalidated under `ent:usr:{userId}`) and turn
 * them into grants here.
 *
 * Adapters get the clock: a grant whose validity is a date range (a license) is decided at read
 * time, so a cached entry stops covering at the end date without needing an invalidation.
 */

/** The `app.plans.code` of the per-student AI add-on, a student tier since migration 000161. */
export const AI_ADDON_TIER_CODE = "ai_addon";

/** Everything known about one person's entitlements, as the adapters consume it. */
export interface PersonEntitlements {
  /** The AI add-on verdict, or null for a person with no student record. */
  ai: AiEntitlement | null;
  user: UserEntitlement;
}

export type GrantSourceAdapter = (person: PersonEntitlements, now: Date) => FeatureGrant[];

/**
 * The per-student AI add-on (`app.ai_subscriptions`). `live` is the add-on's own status only --
 * exactly the half of today's `ai_active` that is not the school, which the resolver AND-s in.
 */
export const aiAddonGrants: GrantSourceAdapter = ({ ai }) => {
  if (!ai?.status || !ai.currentPeriodStart || !ai.currentPeriodEnd) return [];
  return [
    {
      source: ai.status === "trialing" ? "trial" : "purchase",
      tierCode: AI_ADDON_TIER_CODE,
      live: LIVE_STATUSES.has(ai.status),
      periodStart: ai.currentPeriodStart,
      periodEnd: ai.currentPeriodEnd,
      ref: `ai_subscriptions:${ai.studentId}`,
    },
  ];
};

/** Personal purchases of a tier (`app.user_subscriptions`). */
export const userSubscriptionGrants: GrantSourceAdapter = ({ user }) =>
  user.subscriptions.map((subscription) => ({
    source: subscription.status === "trialing" ? "trial" : "purchase",
    tierCode: subscription.planCode,
    live: subscription.live,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    ref: `user_subscriptions:${subscription.id}`,
  }));

/**
 * School-license seats (`app.license_seats`, docs/billing/feature-licensing.md). A seat covers its
 * holder with the license's tier for the seat's audience, for the license period, while the license
 * is active and the clock is inside that period:
 *
 *   - active, inside the period          -> live
 *   - active, past the end               -> ended (FEATURE_EXPIRED), even before the expiry job runs
 *   - active, not started yet            -> no grant (the license does not cover anyone yet)
 *   - suspended / expired / cancelled    -> ended
 *
 * A Family+ parent seat therefore covers the parent in this school only: seats, users and parent
 * links are all per school, so the parent's account at another school holds no seat from this one.
 */
export const licenseSeatGrants: GrantSourceAdapter = ({ user }, now) =>
  user.seats.flatMap((seat) => {
    if (!seat.planCode) return [];
    const started = Date.parse(seat.startsAt) <= now.getTime();
    const ended = now.getTime() >= Date.parse(seat.endsAt);
    if (seat.licenseStatus === "active" && !started) return [];
    return [
      {
        source: "school_license" as const,
        tierCode: seat.planCode,
        live: seat.licenseStatus === "active" && started && !ended,
        periodStart: seat.startsAt,
        periodEnd: seat.endsAt,
        ref: `license_seats:${seat.seatId}`,
      },
    ];
  });

export const GRANT_SOURCES: readonly GrantSourceAdapter[] = [
  aiAddonGrants,
  userSubscriptionGrants,
  licenseSeatGrants,
];

export function collectGrants(
  person: PersonEntitlements,
  now: Date,
  sources: readonly GrantSourceAdapter[] = GRANT_SOURCES,
): FeatureGrant[] {
  return sources.flatMap((source) => source(person, now));
}
