import { DOMAIN_EVENTS } from "@studafy/constants";

import { emit } from "../../../lib/events/emitter";

import { bumpEntitlementVersion } from "./version";

import type { EntitlementChangePublisher } from "@studafy/billing";

/**
 * The API's entitlement change publisher, passed to the shared billing core (ST-133).
 *
 * Two writes inside the caller's transaction: bump the subject's durable version counter, then emit
 * the domain event carrying the version the bump returned. Both ride the transaction that applied
 * the status change and wrote the audit row, so the four either all commit or all roll back -- the
 * version can never describe a status that was never persisted.
 *
 * ## Which counter is bumped
 *
 * A school change bumps only the school's counter, and an AI change bumps only that student's.
 * Bumping the school on an AI change would invalidate every outstanding token in the school over one
 * student's add-on -- a thundering herd on /api/auth/refresh for no correctness gain. The converse
 * (bumping every student on a school change) is unnecessary because the cascade in
 * cascadeToAiSubscriptions already publishes one change per affected AI row, and the case it does
 * not cover -- a school leaving a live state with no AI rows to cascade, which still changes the
 * *effective* AI answer -- is handled structurally by the schoolVersion guard on the cached AI entry.
 * See ./cache.ts.
 *
 * ## Why the version travels in the payload
 *
 * It is what makes invalidation version-guarded rather than a blind DEL: a consumer that arrives out
 * of order can refuse to move the cached version backwards, and the JWT middleware sees the new
 * version the moment the cache is written rather than waiting for a full re-resolve from Postgres.
 *
 * `emit` reads `app.school_id` from the GUC (no `missing_ok`), which processBillingEvent has already
 * armed via setTenantScope before any transition is applied.
 */
export const publishEntitlementChange: EntitlementChangePublisher = async (tx, change) => {
  if (change.kind === "school") {
    const entitlementsVersion = await bumpEntitlementVersion(tx, "school", change.schoolId);

    await emit(tx, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId: change.schoolId,
      subscriptionId: change.subscriptionId,
      previousStatus: change.previousStatus,
      status: change.status,
      entitlementsVersion,
    });
    return;
  }

  const { studentId } = change;
  if (studentId === null) {
    // AttributionTarget.studentId is non-null for every `ai` target, and app.ai_subscriptions.
    // student_id is NOT NULL. Throwing rather than skipping is deliberate: silently publishing
    // nothing would leave that student's cache and tokens stale forever, and the caller's rollback
    // is the correct response to a target we cannot key.
    throw new Error(
      `ai entitlement change for subscription ${change.subscriptionId} carries no student id`,
    );
  }

  const entitlementsVersion = await bumpEntitlementVersion(tx, "ai", studentId);

  await emit(tx, DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED, {
    schoolId: change.schoolId,
    studentId,
    aiSubscriptionId: change.subscriptionId,
    previousStatus: change.previousStatus,
    status: change.status,
    entitlementsVersion,
  });
};
