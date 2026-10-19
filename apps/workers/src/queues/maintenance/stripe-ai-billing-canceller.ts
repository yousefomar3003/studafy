/**
 * Stripe side of the account-deletion sweep (000143): ends an AI add-on subscription at the end of
 * its current period, exactly as apps/api's StripeAdapter.scheduleCancellation does. Same SDK and
 * API version as that adapter and ../billing/stripe-seat-provider.ts.
 */

import Stripe from "stripe";

import type { AiBillingCanceller } from "./account-deletion-sweep";

export class StripeAiBillingCanceller implements AiBillingCanceller {
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, { apiVersion: "2026-07-29.dahlia" });
  }

  async cancelStripeSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }
}
