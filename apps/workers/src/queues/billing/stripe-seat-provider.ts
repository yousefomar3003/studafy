/**
 * Seat-quantity access to a Stripe subscription (ST-136).
 *
 * The sweep talks to this port instead of Stripe directly so tests inject an in-memory fake and
 * never touch the network. The real implementation uses the same SDK and API version as apps/api's
 * adapter (`StripeAdapter`), and the "source of truth" discipline is the same: Stripe owns billing,
 * so `previewUpgrade` returns Stripe's own prorated amount (from an upcoming-invoice preview) and
 * the sweep reports exactly that number to the school — it never reimplements proration math.
 */

import Stripe from "stripe";

export interface BilledSeats {
  /** The current quantity on the subscription item — how many seats the school pays for. */
  quantity: number;
  /** Price of one seat per billing period, in minor units (e.g. 100000 = 1000.00). */
  unitAmountMinor: number;
  /** ISO currency code, e.g. "usd". */
  currency: string;
}

export interface UpgradePreview {
  /**
   * The prorated charge for adding seats mid-period, in minor units. The sum of the preview's
   * `proration` line items — the exact amount Stripe will bill immediately on the upgrade — not
   * the invoice total, which would also carry the next full-period renewal.
   */
  prorationAmountMinor: number;
}

/** How Stripe should bill a quantity change. "always_invoice" prorates and bills now; "none" defers to renewal. */
export type ProrationBehavior = "always_invoice" | "none";

export interface SeatSubscriptionProvider {
  fetchBilledSeats(subscriptionId: string, itemId: string): Promise<BilledSeats>;
  previewUpgrade(subscriptionId: string, itemId: string, quantity: number): Promise<UpgradePreview>;
  setQuantity(
    subscriptionId: string,
    itemId: string,
    quantity: number,
    prorationBehavior: ProrationBehavior,
  ): Promise<void>;
}

export class StripeSeatSubscriptionProvider implements SeatSubscriptionProvider {
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey, {
      apiVersion: "2026-07-29.dahlia",
    });
  }

  async fetchBilledSeats(subscriptionId: string, itemId: string): Promise<BilledSeats> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });

    const item = subscription.items.data.find((candidate) => candidate.id === itemId);
    if (!item) {
      throw new Error(
        `subscription ${subscriptionId} has no item ${itemId} to reconcile seats against`,
      );
    }

    const price = item.price;
    if (price.unit_amount === null) {
      throw new Error(`subscription item ${itemId} has no priced plan to reconcile seats against`);
    }

    return {
      quantity: item.quantity ?? 1,
      unitAmountMinor: price.unit_amount,
      currency: price.currency,
    };
  }

  /**
   * Ask Stripe what the prorated charge for raising the quantity would be, without applying it.
   *
   * `createPreview` (the API-version-2026-07-29 successor to `retrieveUpcoming`) with the changed
   * quantity and `proration_behavior: "always_invoice"` models the invoice the change would
   * produce. The immediate charge is the sum of its `proration` lines — the full-priced renewal
   * lines on the same preview are not part of today's charge.
   */
  async previewUpgrade(
    subscriptionId: string,
    itemId: string,
    quantity: number,
  ): Promise<UpgradePreview> {
    const invoice = await this.stripe.invoices.createPreview({
      subscription: subscriptionId,
      subscription_details: {
        items: [{ id: itemId, quantity }],
        proration_behavior: "always_invoice",
      },
    });

    const prorationAmountMinor =
      invoice.lines?.data
        .filter(
          (line) =>
            line.parent?.invoice_item_details?.proration === true ||
            line.parent?.subscription_item_details?.proration === true,
        )
        .reduce((sum, line) => sum + line.amount, 0) ?? 0;

    return { prorationAmountMinor };
  }

  async setQuantity(
    subscriptionId: string,
    itemId: string,
    quantity: number,
    prorationBehavior: ProrationBehavior,
  ): Promise<void> {
    await this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: itemId, quantity }],
      proration_behavior: prorationBehavior,
    });
  }
}
