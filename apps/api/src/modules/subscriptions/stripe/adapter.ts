import { createHash } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import Stripe from "stripe";

import { PaymentProviderError } from "../ports/payment-provider";

import type {
  ChangeSubscriptionPriceInput,
  ChangeSubscriptionPriceResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  CreateCustomerInput,
  CreateCustomerResult,
  CreatePaymentSessionInput,
  CreatePaymentSessionResult,
  PaymentProviderPort,
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
  ScheduleCancellationInput,
  ReverseCancellationInput,
  ListInvoicesInput,
  ListInvoicesResult,
  SyncOutcome,
  SyncPriceInput,
  SyncPriceResult,
  SyncProductInput,
  SyncProductResult,
  ParsedWebhookEvent,
  LookupProductResult,
  LookupPriceResult,
  CreateBillingPortalSessionInput,
  CreateBillingPortalSessionResult,
  RefundInput,
  RefundResult,
} from "../ports/payment-provider";

export interface StripeAdapterOptions {
  secretKey: string;
  webhookSecret: string;
  /** A ready-made client in place of one built from `secretKey`. Tests pass an in-memory fake. */
  client?: Stripe;
}

/**
 * The lookup key every price published for one `app.plan_prices` row carries.
 *
 * Stripe keeps a lookup key unique across the account, and `prices.list` filtered by it reads
 * straight from the source of truth -- unlike the Search API, which can lag a fresh write by up to
 * a minute -- so it is how sync finds a price it published before when the stored id is gone.
 */
export function priceLookupKey(localPriceId: string): string {
  return `studafy_plan_price_${localPriceId}`;
}

/**
 * An idempotency key for one catalog create, derived from the local row and everything the create
 * sends.
 *
 * A retried request (a timeout whose create did land, a sync re-run before the stored id was
 * written) then gets Stripe's first answer back instead of a second object, for the 24 hours Stripe
 * keeps keys. Hashing the payload rather than keying on the local id alone matters: Stripe rejects
 * a reused key with different parameters, so a plan renamed between two runs must get a new key.
 */
function catalogIdempotencyKey(
  kind: "product" | "price",
  localId: string,
  fields: Record<string, unknown>,
): string {
  const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 32);
  return `studafy-sync-${kind}-${localId}-${digest}`;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError &&
    (error.code === "resource_missing" || error.statusCode === 404)
  );
}

/** Of several objects Stripe holds for one local row, the one to keep: active first, then newest. */
function preferred<T extends { active: boolean; created: number }>(objects: T[]): T | null {
  const sorted = [...objects].sort(
    (a, b) => Number(b.active) - Number(a.active) || b.created - a.created,
  );
  return sorted[0] ?? null;
}

/** Search API query values are single-quoted; a quote inside one is backslash-escaped. */
function searchValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export class StripeAdapter implements PaymentProviderPort {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(options: StripeAdapterOptions) {
    this.stripe =
      options.client ??
      new Stripe(options.secretKey, {
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

  /**
   * A one-time Checkout payment (fees). `price_data` rather than a catalog price: a fee amount is
   * whatever the invoice owes, not a product. Metadata goes on the session, which is the object the
   * `checkout.session.*` webhooks carry back.
   */
  async createPaymentSession(
    input: CreatePaymentSessionInput,
  ): Promise<CreatePaymentSessionResult> {
    const session = await this.stripe.checkout.sessions.create({
      customer: input.customerId,
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountMinor,
            product_data: { name: input.description },
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
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

  /**
   * Find or create the product for one plan, and bring it up to date.
   *
   * The stored id comes first. Without one -- or when Stripe no longer has it, as after switching to
   * another account or mode -- a product carrying this plan's `local_plan_id` is searched for before
   * a new one is made, so a sync whose id write never landed is not paid for with a duplicate.
   * Search can miss a product made in the last minute; the create's idempotency key covers exactly
   * that window.
   */
  async syncProduct(input: SyncProductInput): Promise<SyncProductResult> {
    return this.catalogCall(async () => {
      const stored = input.providerProductId
        ? await this.retrieveProduct(input.providerProductId)
        : null;
      const existing = stored ?? (await this.findProductByLocalId(input.localId));
      const description = input.description || null;

      if (existing) {
        const changes: Stripe.ProductUpdateParams = {};
        if (existing.name !== input.name) changes.name = input.name;
        // An empty string is how Stripe unsets a description.
        if ((existing.description ?? null) !== description) changes.description = description ?? "";
        if (existing.active !== input.active) changes.active = input.active;
        if (existing.metadata?.local_plan_id !== input.localId) {
          changes.metadata = { local_plan_id: input.localId };
        }
        if (Object.keys(changes).length === 0) {
          return { providerProductId: existing.id, outcome: "unchanged" };
        }
        await this.stripe.products.update(existing.id, changes);
        return { providerProductId: existing.id, outcome: "updated" };
      }

      const params: Stripe.ProductCreateParams = {
        name: input.name,
        description: description ?? undefined,
        active: input.active,
        metadata: { local_plan_id: input.localId },
      };
      const product = await this.stripe.products.create(params, {
        // The id being replaced is part of the key: a product recreated after the old one went
        // missing must not be answered with the cached response that named the missing one.
        idempotencyKey: catalogIdempotencyKey("product", input.localId, {
          ...params,
          replacing: input.providerProductId ?? null,
        }),
      });
      return { providerProductId: product.id, outcome: "created" };
    });
  }

  /**
   * Find or create the price for one plan price, and keep exactly one live price for it.
   *
   * A Stripe price's amount, currency, interval and product can never change, so a stored price
   * that still matches the local row is kept (only `active` and its lookup key are ever touched),
   * and one that no longer matches -- the owner changed the amount -- is replaced: a new price is
   * created and the old one archived. Archiving is safe for people already paying: Stripe documents
   * that archiving a price only stops it being used for new purchases, and existing subscriptions
   * on it stay active until they are canceled (docs.stripe.com/products-prices/manage-prices,
   * "Archive a price"). Moving them to the new amount is a separate, deliberate decision.
   *
   * Without a usable stored id the price is looked for by its lookup key, then -- for prices
   * published before lookup keys were set -- by `local_price_id` metadata, before one is created.
   */
  async syncPrice(input: SyncPriceInput): Promise<SyncPriceResult> {
    return this.catalogCall(async () => {
      const lookupKey = priceLookupKey(input.localId);
      const currency = input.currency.toLowerCase();
      const matches = (price: Stripe.Price): boolean =>
        price.unit_amount === input.amountMinor &&
        price.currency === currency &&
        price.recurring?.interval === input.interval &&
        (price.recurring?.interval_count ?? 1) === 1 &&
        (typeof price.product === "string" ? price.product : price.product.id) === input.productId;

      const stored = input.providerPriceId ? await this.retrievePrice(input.providerPriceId) : null;
      let current = stored && matches(stored) ? stored : null;
      let byKey: Stripe.Price | null = null;
      if (!current) {
        byKey = await this.findPriceByLookupKey(lookupKey);
        if (byKey?.id === stored?.id) byKey = null;
        if (byKey && matches(byKey)) current = byKey;
      }
      if (!current && !stored && !byKey) {
        current = await this.findPriceByLocalId(input.localId, matches);
      }

      let outcome: SyncOutcome;
      let priceId: string;
      if (current) {
        priceId = current.id;
        const changes: Stripe.PriceUpdateParams = {};
        if (current.active !== input.active) changes.active = input.active;
        if (current.lookup_key !== lookupKey) {
          changes.lookup_key = lookupKey;
          changes.transfer_lookup_key = true;
        }
        if (current.metadata?.local_price_id !== input.localId) {
          changes.metadata = { local_price_id: input.localId };
        }
        if (Object.keys(changes).length > 0) {
          await this.stripe.prices.update(current.id, changes);
          outcome = "updated";
        } else {
          outcome = "unchanged";
        }
      } else {
        const params: Stripe.PriceCreateParams = {
          product: input.productId,
          unit_amount: input.amountMinor,
          currency,
          recurring: { interval: input.interval },
          active: input.active,
          lookup_key: lookupKey,
          // Moves the key off the price being replaced, so the key always names the live one.
          transfer_lookup_key: true,
          metadata: { local_price_id: input.localId },
        };
        const created = await this.stripe.prices.create(params, {
          // Keyed on the price being replaced too: changing an amount and changing it back within
          // Stripe's 24 hours must create a fresh price, not replay the first create's answer
          // naming the price archived in between.
          idempotencyKey: catalogIdempotencyKey("price", input.localId, {
            ...params,
            replacing: stored?.id ?? byKey?.id ?? null,
          }),
        });
        priceId = created.id;
        outcome = "created";
      }

      const archivedPriceIds: string[] = [];
      for (const superseded of [stored, byKey]) {
        if (superseded && superseded.id !== priceId && superseded.active) {
          await this.stripe.prices.update(superseded.id, { active: false });
          archivedPriceIds.push(superseded.id);
        }
      }
      if (outcome === "unchanged" && archivedPriceIds.length > 0) outcome = "updated";

      return { providerPriceId: priceId, outcome, archivedPriceIds };
    });
  }

  /** Stripe failures during a catalog sync are upstream of our caller (see PaymentProviderError). */
  private async catalogCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new PaymentProviderError(502, ERROR_CODES.STRIPE_API_ERROR, error.message);
      }
      throw error;
    }
  }

  private async retrieveProduct(id: string): Promise<Stripe.Product | null> {
    try {
      const product = await this.stripe.products.retrieve(id);
      return (product as { deleted?: boolean }).deleted ? null : product;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async findProductByLocalId(localId: string): Promise<Stripe.Product | null> {
    const found = await this.stripe.products.search({
      query: `metadata['local_plan_id']:'${searchValue(localId)}'`,
      limit: 10,
    });
    return preferred(found.data);
  }

  private async retrievePrice(id: string): Promise<Stripe.Price | null> {
    try {
      return await this.stripe.prices.retrieve(id);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Lookup keys are unique per account, so this is at most one price, archived or not. */
  private async findPriceByLookupKey(lookupKey: string): Promise<Stripe.Price | null> {
    const found = await this.stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    return found.data[0] ?? null;
  }

  private async findPriceByLocalId(
    localId: string,
    matches: (price: Stripe.Price) => boolean,
  ): Promise<Stripe.Price | null> {
    const found = await this.stripe.prices.search({
      query: `metadata['local_price_id']:'${searchValue(localId)}'`,
      limit: 10,
    });
    return preferred(found.data.filter(matches));
  }

  /**
   * Verify the Stripe signature over the *raw* bytes and normalize the envelope.
   *
   * constructEventAsync both verifies and parses, in that order, which is the property that matters: the
   * signature covers the exact bytes Stripe sent, so `payload` must never be a re-serialization of
   * an already-parsed object. It throws on a bad or absent signature; callers turn that into a 400.
   *
   * `created` is Unix seconds. Multiplying is not cosmetic -- passing it to Date unscaled would put
   * every event in January 1970, which sorts every real event ahead of it and quietly inverts the
   * out-of-order handling this timestamp exists to drive.
   */
  async parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent> {
    // The async form: under Bun the Stripe SDK verifies with Web Crypto (SubtleCryptoProvider),
    // which cannot run synchronously -- constructEvent() there throws on every webhook, valid or not.
    const event = await this.stripe.webhooks.constructEventAsync(
      payload,
      signature,
      this.webhookSecret,
    );
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

  /**
   * `cancel_at_period_end: true` keeps the subscription active (and billing) through its current
   * period; Stripe reports the change back as `customer.subscription.updated` with `status` still
   * `active`, which the state machine correctly treats as a self-edge. The eventual
   * `customer.subscription.deleted` at period end is what moves local status to `canceled`.
   */
  async scheduleCancellation(input: ScheduleCancellationInput): Promise<void> {
    await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      cancel_at_period_end: true,
    });
  }

  async reverseCancellation(input: ReverseCancellationInput): Promise<void> {
    await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      cancel_at_period_end: false,
    });
  }

  /**
   * Swap the subscription's one item to another price, prorated.
   *
   * `chargeNow` invoices the difference immediately with `payment_behavior: "pending_if_incomplete"`:
   * Stripe then applies the change only once that invoice is paid and otherwise reports it as a
   * `pending_update`, so a declined card leaves the subscription exactly as it was. Without it the
   * proration waits for the next regular invoice.
   */
  async changeSubscriptionPrice(
    input: ChangeSubscriptionPriceInput,
  ): Promise<ChangeSubscriptionPriceResult> {
    const subscription = await this.stripe.subscriptions.retrieve(input.providerSubscriptionId);
    const item = subscription.items.data[0];
    if (!item) {
      throw new PaymentProviderError(
        502,
        ERROR_CODES.STRIPE_API_ERROR,
        "Stripe subscription has no item to change",
      );
    }

    const updated = await this.stripe.subscriptions.update(input.providerSubscriptionId, {
      items: [{ id: item.id, price: input.priceId }],
      metadata: input.metadata,
      ...(input.chargeNow
        ? { proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" }
        : { proration_behavior: "create_prorations" }),
    });

    return { applied: updated.pending_update == null };
  }

  async listInvoices(input: ListInvoicesInput): Promise<ListInvoicesResult> {
    const page = await this.stripe.invoices.list({
      customer: input.customerId,
      limit: input.limit ?? 20,
      starting_after: input.startingAfter,
    });

    return {
      invoices: page.data.map((invoice) => ({
        id: invoice.id ?? "",
        status: invoice.status,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency.toUpperCase(),
        created: new Date(invoice.created * 1000),
        periodStart: new Date(invoice.period_start * 1000),
        periodEnd: new Date(invoice.period_end * 1000),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdf: invoice.invoice_pdf ?? null,
      })),
      hasMore: page.has_more,
    };
  }

  /**
   * Refunds the payment behind an invoice. Since API version 2025-03 an invoice no longer names its
   * PaymentIntent itself: its payments are listed through `invoicePayments`, and the paid one names
   * the PaymentIntent (or, for an out-of-band legacy charge, the Charge) the money moved on.
   *
   * Stripe refunds in the charge's own currency, so `currency` is not sent. The idempotency key
   * makes a retried call with the same key and amount return the first refund instead of a second.
   */
  async refund(input: RefundInput): Promise<RefundResult> {
    if (!input.invoiceId) {
      throw new PaymentProviderError(400, ERROR_CODES.VALIDATION_FAILED, "invoiceId is required");
    }

    try {
      const payments = await this.stripe.invoicePayments.list({
        invoice: input.invoiceId,
        status: "paid",
        limit: 1,
      });
      const payment = payments.data[0]?.payment;
      const paymentIntent =
        typeof payment?.payment_intent === "string"
          ? payment.payment_intent
          : payment?.payment_intent?.id;
      const charge = typeof payment?.charge === "string" ? payment.charge : payment?.charge?.id;
      if (!paymentIntent && !charge) {
        throw new PaymentProviderError(
          400,
          ERROR_CODES.SUBSCRIPTION_REFUND_PAYMENT_NOT_REFUNDABLE,
          "Invoice has no paid payment to refund",
        );
      }

      const refund = await this.stripe.refunds.create(
        {
          ...(paymentIntent ? { payment_intent: paymentIntent } : { charge }),
          amount: input.amountMinor,
          reason: "requested_by_customer",
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );

      if (refund.status === "failed" || refund.status === "canceled") {
        throw new PaymentProviderError(
          502,
          ERROR_CODES.STRIPE_API_ERROR,
          `Stripe refund ${refund.id} ${refund.status}`,
        );
      }
      return {
        providerRefundId: refund.id,
        status: refund.status === "succeeded" ? "succeeded" : "pending",
      };
    } catch (error) {
      // Whatever Stripe answered, the failure is upstream of our caller (see PaymentProviderError).
      if (error instanceof Stripe.errors.StripeError) {
        throw new PaymentProviderError(502, ERROR_CODES.STRIPE_API_ERROR, error.message);
      }
      throw error;
    }
  }
}
