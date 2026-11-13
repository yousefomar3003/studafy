/**
 * Store subscription -> the shared billing event vocabulary.
 *
 * `@studafy/billing` reads one dialect, Stripe's event names and object fields (see the Tap
 * normalizer, tap/event-normalizer.ts, for the same move). Each store lifecycle moment becomes the
 * Stripe event that means the same thing to Studafy:
 *
 *   purchased       -> checkout.session.completed  (creates or restarts the student's AI row)
 *   renewed         -> invoice.paid                (advances the period; recovers past_due)
 *   payment_failed  -> invoice.payment_failed      (past_due: access continues while the store retries)
 *   ended           -> customer.subscription.deleted (lapsed, refunded or revoked: access ends)
 *
 * The payload carries what the billing readers look for under the names they use: `metadata` with
 * school_id / student_id for attribution, `period_start` / `period_end` in Unix seconds, and no
 * `customer` (a store purchase has no provider customer). `store_ref` is what
 * idx_billing_events_store_ref finds later notifications by.
 */

import type { StoreEventKind, StoreSubscription } from "./types";
import type { BillingEventSource } from "@studafy/billing";

const EVENT_TYPES: Readonly<Record<StoreEventKind, string>> = {
  purchased: "checkout.session.completed",
  renewed: "invoice.paid",
  payment_failed: "invoice.payment_failed",
  ended: "customer.subscription.deleted",
};

export interface StoreBillingEvent {
  provider: BillingEventSource;
  id: string;
  type: string;
  effectiveAt: Date;
  data: Record<string, unknown>;
}

export function storeBillingEvent(params: {
  eventId: string;
  kind: StoreEventKind;
  subscription: StoreSubscription;
  schoolId: string;
  studentId: string;
  effectiveAt: Date;
}): StoreBillingEvent {
  const { subscription } = params;
  const seconds = (date: Date): number => Math.floor(date.getTime() / 1000);
  const period =
    (params.kind === "purchased" || params.kind === "renewed") &&
    subscription.periodEnd &&
    subscription.periodEnd > subscription.periodStart
      ? {
          period_start: seconds(subscription.periodStart),
          period_end: seconds(subscription.periodEnd),
        }
      : {};

  return {
    provider: subscription.platform,
    id: params.eventId,
    type: EVENT_TYPES[params.kind],
    effectiveAt: params.effectiveAt,
    data: {
      // Prefixed so no store reference can ever pass for a Stripe `sub_...` id (extractSubscriptionId).
      id: `store:${subscription.storeRef}`,
      object: "store_subscription",
      customer: null,
      store_ref: subscription.storeRef,
      transaction_id: subscription.transactionId,
      product_id: subscription.productId,
      environment: subscription.environment,
      metadata: { school_id: params.schoolId, student_id: params.studentId },
      ...period,
    },
  };
}
