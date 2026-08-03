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
export {
  pauseAiSubscriptionsForSchoolSuspension,
  resumeAiSubscriptionsForSchoolReactivation,
} from "./services/school-suspension-service";
export type { SchoolAiSubscriptionTransitionResult } from "./services/school-suspension-service";
// Entitlement resolution and cache (ST-133). The version bump and the outbox emit are deliberately
// NOT exported: they are the billing state machine's injected port, wired at the two processors, and
// nothing else should be able to move a version counter.
export { createEntitlementService } from "./entitlements/service";
export type { EntitlementService, EntitlementServiceDeps } from "./entitlements/service";
export type { AiEntitlement, SchoolEntitlement, EntitlementQuotas } from "./entitlements/resolve";
export {
  ENTITLEMENT_CACHE_TTL_SECONDS,
  aiEntitlementCacheKey,
  entitlementCacheKey,
} from "./entitlements/cache";
export { startEntitlementInvalidationSubscriber } from "./subscribers/entitlement-invalidation.subscriber";
export type { EntitlementInvalidationSubscriber } from "./subscribers/entitlement-invalidation.subscriber";
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
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
} from "./ports/payment-provider";
