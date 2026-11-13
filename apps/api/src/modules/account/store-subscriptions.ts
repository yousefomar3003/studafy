import { LIVE_STATUSES } from "@studafy/billing";

import type { TransactionSql } from "postgres";

/**
 * Live AI add-on subscriptions billed by an app store that deleting this account leaves running.
 *
 * Studafy cannot cancel an App Store subscription at all, and a Google Play one only on a
 * best-effort basis when the account-deletion sweep detaches the account (apps/workers'
 * account-deletion-sweep.ts). A parent deleting their own account cancels nothing for their
 * children, whose accounts stay. So the delete screens warn the person, and tell them how to
 * cancel in the store, whenever this list is not empty.
 *
 * Two sources:
 *   - the caller's own student record (a student account), `for_child: false`;
 *   - every student linked to the caller as a parent, `for_child: true`.
 *
 * A store purchase has no provider column on `ai_subscriptions` (Stripe and Tap do); its billing
 * event names the store, read through `app.ai_store_purchases` (000163), as licensing/overlap.ts
 * does. Deduplicated by (platform, for_child): the screens show steps per store, not per child,
 * so no child's name or subscription detail is disclosed.
 */

export type StorePlatform = "app_store" | "google_play";

export interface ActiveStoreSubscription {
  platform: StorePlatform;
  /** True when the subscription is a linked child's, not the caller's own. */
  for_child: boolean;
}

export async function findActiveStoreSubscriptions(
  tx: TransactionSql,
  userId: string,
  now: Date = new Date(),
): Promise<ActiveStoreSubscription[]> {
  const subscribers = await tx<{ student_id: string; for_child: boolean }[]>`
    SELECT s.id::text AS student_id, false AS for_child
      FROM app.students AS s
     WHERE s.user_id = ${userId}::uuid
       AND s.school_id = current_setting('app.school_id')::uuid
    UNION
    SELECT l.student_id::text, true
      FROM app.parent_child_links AS l
     WHERE l.parent_user_id = ${userId}::uuid
       AND l.school_id = current_setting('app.school_id')::uuid
  `;
  if (subscribers.length === 0) return [];

  const studentIds = [...new Set(subscribers.map((row) => row.student_id))];
  const live = await tx<{ student_id: string }[]>`
    SELECT a.student_id::text AS student_id
      FROM app.ai_subscriptions AS a
     WHERE a.school_id = current_setting('app.school_id')::uuid
       AND a.student_id = ANY(${studentIds}::uuid[])
       AND a.status::text = ANY(${[...LIVE_STATUSES]})
       AND a.current_period_end > ${now}
       AND a.stripe_subscription_id IS NULL
       AND a.tap_payment_agreement_id IS NULL
  `;
  if (live.length === 0) return [];

  const purchases = await tx<{ student_id: string; platform: string }[]>`
    SELECT student_id::text AS student_id, platform
      FROM app.ai_store_purchases(${live.map((row) => row.student_id)}::uuid[])
  `;
  const platformOf = new Map(
    purchases.map((row) => [
      row.student_id,
      (row.platform === "apple" ? "app_store" : "google_play") as StorePlatform,
    ]),
  );

  const found = new Map<string, ActiveStoreSubscription>();
  for (const subscriber of subscribers) {
    const platform = platformOf.get(subscriber.student_id);
    if (!platform) continue;
    found.set(`${platform}:${subscriber.for_child}`, {
      platform,
      for_child: subscriber.for_child,
    });
  }
  // Own subscriptions first, then App Store before Google Play: a stable order for the screens.
  return [...found.values()].sort(
    (a, b) => Number(a.for_child) - Number(b.for_child) || a.platform.localeCompare(b.platform),
  );
}
