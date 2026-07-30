import Stripe from "stripe";

import type {
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  CreateCustomerInput,
  CreateCustomerResult,
  PaymentProviderPort,
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

  async parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent> {
    const event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
    return {
      type: event.type,
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
}
