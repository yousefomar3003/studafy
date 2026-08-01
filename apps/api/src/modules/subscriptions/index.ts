export { checkoutRoutes } from "./routes/checkout-routes";
export { schoolCheckoutRoutes } from "./routes/school-checkout-routes";
export { aiCheckoutRoutes } from "./routes/ai-checkout-routes";
export { webhookRoutes } from "./routes/webhook-routes";
export { planRoutes } from "./routes/plan-routes";
export { adminSubscriptionRoutes } from "./routes/admin-routes";
export { StripeAdapter } from "./stripe/adapter";
export type { StripeAdapterOptions } from "./stripe/adapter";
export { handleStripeWebhook } from "./stripe/webhook-processor";
export type {
  BillingEventRetryEnqueuer,
  WebhookOutcome,
  WebhookProcessorDeps,
  WebhookRequestContext,
} from "./stripe/webhook-processor";
export { emitWebhookSignatureFailure } from "./billing-anomaly-events";
// The state machine, the fold and the transition tables live in @studafy/billing: apps/workers
// re-applies the same events on a retry and the two processes must not be able to disagree about
// what an event means. Import them from there, not through this barrel.
export { syncPlanPrices } from "./services/price-sync-service";
export {
  createSchoolCheckoutSession,
  createTieredSchoolCheckoutSession,
  createAiCheckoutSession,
  createBillingPortalSession,
} from "./services/checkout-service";
export { getActivePlans, getSchoolSubscription } from "./services/subscription-service";
export type {
  PaymentProviderPort,
  CreateCustomerInput,
  CreateCustomerResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  SyncProductInput,
  SyncProductResult,
  SyncPriceInput,
  SyncPriceResult,
  ParsedWebhookEvent,
} from "./ports/payment-provider";
