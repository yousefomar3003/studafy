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

export interface ParsedWebhookEvent {
  type: string;
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
