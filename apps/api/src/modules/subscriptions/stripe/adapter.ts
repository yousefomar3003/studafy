import Stripe from "stripe";

import type {
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  CreateCustomerInput,
  CreateCustomerResult,
  PaymentProviderPort,
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
  SyncPriceInput,
  SyncPriceResult,
  SyncProductInput,
  SyncProductResult,
  ParsedWebhookEvent,
  LookupProductResult,
  LookupPriceResult,
  CreateBillingPortalSessionInput,
  CreateBillingPortalSessionResult,
} from "../ports/payment-provider";

export interface StripeAdapterOptions {
  secretKey: string;
  webhookSecret: string;
}

export class StripeAdapter implements PaymentProviderPort {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(options: StripeAdapterOptions) {
    this.stripe = new Stripe(options.secretKey, {
      apiVersion: "2026-07-29.dahlia",
    });
    this.webhookSecret = options.webhookSecret;
  }

  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    const customer = await this.stripe.customers.create({
      name: input.name,
      email: input.email,
      metadata: input.metadata,
    });
    return { providerCustomerId: customer.id };
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CreateCheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create({
      customer: input.customerId,
      mode: "subscription",
      line_items: [{ price: input.priceId, quantity: input.quantity ?? 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
      subscription_data: {
        metadata: input.metadata,
      },
    });

    if (!session.url) {
      throw new Error("Stripe Checkout session returned no URL");
    }

    return { url: session.url, sessionId: session.id };
  }

  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<CreateBillingPortalSessionResult> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async syncProduct(input: SyncProductInput): Promise<SyncProductResult> {
    const product = await this.stripe.products.create({
      name: input.name,
      description: input.description,
      active: input.active,
      metadata: { local_plan_id: input.localId },
    });
    return { providerProductId: product.id };
  }

  async syncPrice(input: SyncPriceInput): Promise<SyncPriceResult> {
    const price = await this.stripe.prices.create({
      product: input.productId,
      unit_amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      recurring: { interval: input.interval },
      active: input.active,
      metadata: { local_price_id: input.localId },
    });
    return { providerPriceId: price.id };
  }

  /**
   * Verify the Stripe signature over the *raw* bytes and normalize the envelope.
   *
   * constructEvent both verifies and parses, in that order, which is the property that matters: the
   * signature covers the exact bytes Stripe sent, so `payload` must never be a re-serialization of
   * an already-parsed object. It throws on a bad or absent signature; callers turn that into a 400.
   *
   * `created` is Unix seconds. Multiplying is not cosmetic -- passing it to Date unscaled would put
   * every event in January 1970, which sorts every real event ahead of it and quietly inverts the
   * out-of-order handling this timestamp exists to drive.
   */
  async parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent> {
    const event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
    return {
      id: event.id,
      type: event.type,
      effectiveAt: new Date(event.created * 1000),
      livemode: event.livemode,
      data: event.data.object as unknown as Record<string, unknown>,
    };
  }

  async lookupProductById(providerProductId: string): Promise<LookupProductResult | null> {
    try {
      const product = await this.stripe.products.retrieve(providerProductId);
      return { id: product.id, name: product.name };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async lookupPriceById(providerPriceId: string): Promise<LookupPriceResult | null> {
    try {
      const price = await this.stripe.prices.retrieve(providerPriceId);
      if (!price.recurring) return null;
      return {
        id: price.id,
        productId: price.product as string,
        amountMinor: price.unit_amount ?? 0,
        currency: price.currency.toUpperCase(),
        interval: price.recurring.interval,
      };
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * `pause_collection: { behavior: "void" }` stops Stripe from generating or charging invoices
   * without ending the subscription -- the subscription object itself still reports its prior
   * status (Stripe's own `paused` status is a separate, distinct thing this port does not use), so
   * there is nothing here for `deriveIntent`'s `customer.subscription.paused` mapping to see. The
   * local `paused` status this call backs is recorded by the caller in the same transaction, not
   * inferred from a webhook.
   */
  async pauseSubscription(input: PauseSubscriptionInput): Promise<void> {
    await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      pause_collection: { behavior: "void" },
    });
  }

  /** Clearing `pause_collection` resumes normal invoicing from the subscription's existing cycle. */
  async resumeSubscription(input: ResumeSubscriptionInput): Promise<void> {
    await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      pause_collection: null,
    });
  }
}
