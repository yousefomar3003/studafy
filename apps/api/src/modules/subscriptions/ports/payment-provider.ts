import type { ErrorCode } from "@studafy/constants";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// ---------------------------------------------------------------------------
// Shared domain types
// ---------------------------------------------------------------------------

export type SubscriptionStatus =
  "trialing" | "active" | "past_due" | "canceled" | "expired" | "grace_period" | "closed";

export type BillingInterval = "monthly" | "yearly";

// ---------------------------------------------------------------------------
// Params and results
// ---------------------------------------------------------------------------

export interface CreateCheckoutParams {
  schoolId: string;
  planId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialPeriodDays?: number;
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  sessionId: string;
  url: string;
}

export interface CreatePortalParams {
  schoolId: string;
  returnUrl: string;
}

export interface PortalResult {
  sessionId: string;
  url: string;
}

export interface CancelSubscriptionParams {
  schoolId: string;
  immediately?: boolean;
  reason?: string;
}

export interface CancelAiSubscriptionParams {
  schoolId: string;
  studentId: string;
  immediately?: boolean;
  reason?: string;
}

export interface NormalizeWebhookParams {
  rawBody: string;
  signature: string;
}

export interface NormalizedWebhookEvent {
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ResolveCustomerParams {
  schoolId: string;
  email: string;
  name: string;
}

export interface CustomerResult {
  providerCustomerId: string;
}

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

export class PaymentProviderError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;

  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(message);
    this.name = "PaymentProviderError";
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface PaymentProviderPort {
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>;
  createPortal(params: CreatePortalParams): Promise<PortalResult>;
  cancelSubscription(params: CancelSubscriptionParams): Promise<void>;
  cancelAiSubscription(params: CancelAiSubscriptionParams): Promise<void>;
  normalizeWebhookEvent(params: NormalizeWebhookParams): Promise<NormalizedWebhookEvent>;
  resolveCustomer(params: ResolveCustomerParams): Promise<CustomerResult>;
}
