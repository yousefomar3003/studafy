import { randomUUID } from "node:crypto";

import type {
  CreateBillingPortalSessionInput,
  CreateBillingPortalSessionResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  CreateCustomerInput,
  CreateCustomerResult,
  ListInvoicesInput,
  ListInvoicesResult,
  LookupPriceResult,
  LookupProductResult,
  ParsedWebhookEvent,
  PaymentProviderPort,
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
  ReverseCancellationInput,
  ScheduleCancellationInput,
  SyncPriceInput,
  SyncPriceResult,
  SyncProductInput,
  SyncProductResult,
} from "../../src/modules/subscriptions/ports/payment-provider";

/**
 * An in-memory `PaymentProviderPort`, for E2E only.
 *
 * `createApp({ stripeProvider })` (app.ts) takes any implementation of this port — that seam exists
 * for exactly this — so the checkout, portal, sync, and webhook routes run for real against this
 * fake with no Stripe account, no test-mode API key, and no network call. It never talks to Stripe;
 * it records what checkout-service.ts (`apps/api/src/modules/subscriptions/services`) called it
 * with and hands the record back, which is what lets the E2E test build a realistic webhook payload
 * from the same inputs the real Stripe integration would have echoed back on its own.
 *
 * Signature verification is deliberately not simulated. The real boundary (`StripeAdapter`,
 * `stripe/adapter.ts`) is a thin wrapper around the Stripe SDK's `webhooks.constructEvent`, called
 * only from inside that class — this fake stands in for the whole port, so `parseWebhook` here does
 * not need to re-derive an HMAC scheme just to check its own signature; it trusts the caller, which
 * in an E2E run is this suite's own support code and nothing else (webhook-routes.ts still requires
 * a non-empty `Stripe-Signature` header to reach it — see `signature` below).
 */
export class FakeStripeProvider implements PaymentProviderPort {
  readonly customers = new Map<string, CreateCustomerInput & { id: string }>();
  readonly checkoutSessions = new Map<
    string,
    CreateCheckoutSessionInput & { id: string; url: string }
  >();
  readonly products = new Map<string, SyncProductInput & { id: string }>();
  readonly prices = new Map<string, SyncPriceInput & { id: string }>();

  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    const id = `cus_fake_${randomUUID()}`;
    this.customers.set(id, { ...input, id });
    return { providerCustomerId: id };
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CreateCheckoutSessionResult> {
    const id = `cs_fake_${randomUUID()}`;
    // No real hosted page exists to redirect the browser to. The success URL is the honest stand-in
    // for what would happen after a real customer paid: `successUrl` is exactly where Stripe's own
    // hosted Checkout redirects on completion, so landing there directly (with the session id
    // attached, matching Stripe's own `?session_id={CHECKOUT_SESSION_ID}` convention when the
    // caller opts into it) reproduces the same post-checkout page state the E2E test asserts on.
    // What actually flips the subscription's status is the webhook this suite sends separately (see
    // the journey catalog) — this URL is never treated as proof of payment on its own.
    const url = `${input.successUrl}${input.successUrl.includes("?") ? "&" : "?"}session_id=${id}`;
    this.checkoutSessions.set(id, { ...input, id, url });
    return { url, sessionId: id };
  }

  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<CreateBillingPortalSessionResult> {
    return { url: input.returnUrl };
  }

  async syncProduct(input: SyncProductInput): Promise<SyncProductResult> {
    const id = `prod_fake_${randomUUID()}`;
    this.products.set(id, { ...input, id });
    return { providerProductId: id };
  }

  async syncPrice(input: SyncPriceInput): Promise<SyncPriceResult> {
    const id = `price_fake_${randomUUID()}`;
    this.prices.set(id, { ...input, id });
    return { providerPriceId: id };
  }

  /**
   * Parses the fake webhook body support code sent — see `buildFakeCheckoutCompletedEvent` below,
   * which E2E specs use to build it. `signature` is unused (see the class doc comment); the route
   * itself already rejects a request with no `Stripe-Signature` header at all before this runs.
   */
  async parseWebhook(payload: Buffer, _signature: string): Promise<ParsedWebhookEvent> {
    const event = JSON.parse(payload.toString("utf8")) as {
      id: string;
      type: string;
      created: number;
      livemode: boolean;
      data: { object: Record<string, unknown> };
    };
    return {
      id: event.id,
      type: event.type,
      effectiveAt: new Date(event.created * 1000),
      livemode: event.livemode,
      data: event.data.object,
    };
  }

  async lookupProductById(providerProductId: string): Promise<LookupProductResult | null> {
    const product = this.products.get(providerProductId);
    return product ? { id: product.id, name: product.name } : null;
  }

  async lookupPriceById(providerPriceId: string): Promise<LookupPriceResult | null> {
    const price = this.prices.get(providerPriceId);
    if (!price) return null;
    return {
      id: price.id,
      productId: price.productId,
      amountMinor: price.amountMinor,
      currency: price.currency.toUpperCase(),
      interval: price.interval,
    };
  }

  // None of the seven journeys exercises pause/resume/cancellation — no-ops rather than unimplemented
  // throws, matching the port's contract (idempotent operations with no observable local state here).
  async pauseSubscription(_input: PauseSubscriptionInput): Promise<void> {
    /* no-op */
  }
  async resumeSubscription(_input: ResumeSubscriptionInput): Promise<void> {
    /* no-op */
  }
  async scheduleCancellation(_input: ScheduleCancellationInput): Promise<void> {
    /* no-op */
  }
  async reverseCancellation(_input: ReverseCancellationInput): Promise<void> {
    /* no-op */
  }

  async listInvoices(_input: ListInvoicesInput): Promise<ListInvoicesResult> {
    return { invoices: [], hasMore: false };
  }
}

/**
 * Build a `checkout.session.completed` webhook body for one checkout session this fake provider
 * created, ready to sign (`signFakeStripeWebhook`) and POST to `/api/subscriptions/webhook/stripe`.
 *
 * Reuses the *real* customer id, price id, and metadata the checkout route actually passed to
 * `createCheckoutSession` — the same fields `packages/billing/src/attribution.ts`'s
 * `resolveSchoolId`/`resolveTarget` and `state-machine.ts`'s `deriveIntent` read — rather than
 * hand-guessing Stripe's checkout.session shape, so a field-name drift in either place fails the
 * build instead of silently no-oping in a fake nobody notices.
 */
export function buildFakeCheckoutCompletedEvent(
  provider: FakeStripeProvider,
  sessionId: string,
): {
  id: string;
  type: "checkout.session.completed";
  created: number;
  livemode: false;
  data: { object: Record<string, unknown> };
} {
  const session = provider.checkoutSessions.get(sessionId);
  if (!session) throw new Error(`FakeStripeProvider has no checkout session ${sessionId}`);

  return {
    id: `evt_fake_${randomUUID()}`,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        customer: session.customerId,
        subscription: `sub_fake_${randomUUID()}`,
        status: "complete",
        payment_status: "paid",
        metadata: session.metadata,
      },
    },
  };
}

/**
 * A signature string that only needs to be non-empty — see the class doc comment on why this fake
 * does not implement Stripe's real HMAC scheme. `webhook-routes.ts` requires the header to be
 * present before it ever reaches `parseWebhook`, so a real-looking (if unverified) value keeps the
 * request shape honest.
 */
export function signFakeStripeWebhook(): string {
  return `t=${Math.floor(Date.now() / 1000)},v1=fake-e2e-signature`;
}
