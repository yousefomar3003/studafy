export class PaymentProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export interface CreateCustomerInput {
  name: string;
  email: string;
  metadata: Record<string, string>;
}

export interface CreateCustomerResult {
  providerCustomerId: string;
}

export interface CreateCheckoutSessionInput {
  customerId: string;
  priceId: string;
  quantity?: number;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CreateCheckoutSessionResult {
  url: string;
  sessionId: string;
}

export interface CreateBillingPortalSessionInput {
  customerId: string;
  returnUrl: string;
}

export interface CreateBillingPortalSessionResult {
  url: string;
}

export interface SyncProductInput {
  localId: string;
  name: string;
  description?: string;
  active: boolean;
}

export interface SyncProductResult {
  providerProductId: string;
}

export interface SyncPriceInput {
  localId: string;
  productId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year";
  active: boolean;
}

export interface SyncPriceResult {
  providerPriceId: string;
}

/**
 * One verified inbound webhook, normalized off the provider's envelope.
 *
 * `id` and `effectiveAt` are envelope fields, not payload fields, and both are load-bearing:
 *
 * - `id` is the idempotency key the processor claims on (app.billing_events.provider_event_id).
 *   It must be the *event's* identity, never the identity of the object the event describes --
 *   several events can concern one subscription, and keying on the object id would make the second
 *   of them look like a replay of the first and silently drop it.
 * - `effectiveAt` is when the provider says the change happened. Delivery order is not guaranteed,
 *   so every ordering decision is made on this and never on receipt time.
 *
 * `data` stays the provider's own object, unmodelled: what a `customer.subscription.updated`
 * carries is the provider's business, and this port does not pretend to normalize it.
 */
export interface ParsedWebhookEvent {
  id: string;
  type: string;
  effectiveAt: Date;
  /** False for provider test-mode traffic. Recorded so a test event is never mistaken for real billing. */
  livemode: boolean;
  data: Record<string, unknown>;
}

export interface LookupProductResult {
  id: string;
  name: string;
}

export interface LookupPriceResult {
  id: string;
  productId: string;
  amountMinor: number;
  currency: string;
  interval: string;
}

export interface PaymentProviderPort {
  createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult>;
  createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<CreateBillingPortalSessionResult>;
  syncProduct(input: SyncProductInput): Promise<SyncProductResult>;
  syncPrice(input: SyncPriceInput): Promise<SyncPriceResult>;
  parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent>;
  lookupProductById(providerProductId: string): Promise<LookupProductResult | null>;
  lookupPriceById(providerPriceId: string): Promise<LookupPriceResult | null>;
}
