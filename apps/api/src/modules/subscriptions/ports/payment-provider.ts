import { CodedHttpException } from "../../../coded-http-exception";

import type { ErrorCode } from "@studafy/constants";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * A failure an adapter reports through the port.
 *
 * A coded HTTP exception, so the error handler answers it with its own status and code: a 400 for
 * input the provider cannot take, a 501 for an operation the provider has no equivalent for, a 502
 * when the provider itself failed. Adapters map provider-side failures to 502 rather than passing
 * the provider's status through -- the provider answering 401 means our key is wrong, not the
 * caller's session.
 */
export class PaymentProviderError extends CodedHttpException {
  constructor(status: ContentfulStatusCode, code: ErrorCode, message: string) {
    super(status, code, message);
    this.name = "PaymentProviderError";
  }
}

export interface CreateCustomerInput {
  name: string;
  email: string;
  metadata: Record<string, string>;
  /**
   * Stable for one school (and mode): a create retried after its transaction rolled back returns the
   * customer the first attempt made instead of a second one. Ignored by a provider without keys.
   */
  idempotencyKey?: string;
}

export interface CreateCustomerResult {
  providerCustomerId: string;
}

export interface CreateCheckoutSessionInput {
  customerId: string;
  /** The provider's price id (Stripe), or `app.plan_prices.id` for a provider with no catalog (Tap). */
  priceId: string;
  /**
   * The unit price in minor units and its ISO 4217 code, as `app.plan_prices` records them.
   *
   * Required because Tap has no price catalog: a Tap charge carries its amount, so without these it
   * cannot be created at all. Stripe charges the catalog price behind `priceId`, which price sync
   * created from these same columns, and does not read them.
   */
  amountMinor: number;
  currency: string;
  quantity?: number;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CreateCheckoutSessionResult {
  url: string;
  sessionId: string;
}

/**
 * A one-time hosted payment, not a subscription: online fee collection (ST-298).
 *
 * The amount is charged exactly as given. `metadata` must identify the local payment record so the
 * provider's webhook can settle it; nothing in it may be a subscription `billing_reason`, or the
 * billing state machine would read a fee as a subscription payment.
 */
export interface CreatePaymentSessionInput {
  customerId: string;
  amountMinor: number;
  currency: string;
  description: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
}

export interface CreatePaymentSessionResult {
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

/**
 * What a catalog sync did to the provider's object: made a new one, changed one that already
 * existed, or found it already as wanted. The sync reports these counts, and an operator re-running
 * it expects the second run to say "unchanged" everywhere.
 */
export type SyncOutcome = "created" | "updated" | "unchanged";

/**
 * Publish one `app.plans` row as a provider product. Must be safe to repeat: a product the provider
 * already holds for this plan is reused and brought up to date, never duplicated.
 */
export interface SyncProductInput {
  localId: string;
  name: string;
  description?: string;
  active: boolean;
  /** The id we stored last time (`app.plans.stripe_product_id`), if any. */
  providerProductId?: string | null;
}

export interface SyncProductResult {
  providerProductId: string;
  outcome: SyncOutcome;
}

/**
 * Publish one `app.plan_prices` row as a provider price. Must be safe to repeat, like
 * `SyncProductInput`.
 */
export interface SyncPriceInput {
  localId: string;
  productId: string;
  amountMinor: number;
  currency: string;
  interval: "month" | "year";
  active: boolean;
  /** The id we stored last time (`app.plan_prices.stripe_price_id`), if any. */
  providerPriceId?: string | null;
}

export interface SyncPriceResult {
  providerPriceId: string;
  outcome: SyncOutcome;
  /**
   * Prices this sync retired because they no longer match the local row (an amount the owner
   * changed). Retired, not deleted: subscriptions already on them keep billing.
   */
  archivedPriceIds: string[];
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

export interface PauseSubscriptionInput {
  providerSubscriptionId: string;
}

export interface ResumeSubscriptionInput {
  providerSubscriptionId: string;
}

export interface ScheduleCancellationInput {
  providerSubscriptionId: string;
}

export interface ReverseCancellationInput {
  providerSubscriptionId: string;
}

/**
 * Move a subscription to another catalog price (a storage add-on changing tier or interval).
 *
 * `chargeNow`: invoice the prorated difference straight away and apply the change only if that
 * invoice is paid -- for a move to something bigger, so a larger cap is never handed out against a
 * declined card. Otherwise the proration is credited or charged on the next regular invoice.
 */
export interface ChangeSubscriptionPriceInput {
  providerSubscriptionId: string;
  /** The provider's price id (Stripe `price_...`). */
  priceId: string;
  chargeNow: boolean;
  /**
   * The instant the proration is computed at, in Unix seconds: the one the buyer was shown in
   * `previewSubscriptionPriceChange`, so what is charged is exactly what they confirmed.
   */
  prorationDate: number;
  /**
   * Stable for one confirmed change: a retried or repeated request with the same key is answered
   * from the provider's first result and never charged a second time.
   */
  idempotencyKey: string;
  /** Replaces the subscription's metadata keys given here (the new local `price_id`, say). */
  metadata: Record<string, string>;
  /**
   * With `chargeNow`: the amount the buyer confirmed. The invoice is built and checked against it
   * before anything is charged; a different amount charges nothing (`failure: "amount_changed"`).
   */
  expectedAmountMinor?: number;
  /**
   * With `chargeNow`: the card to charge, one of the customer's own (`listPaymentMethods`). Only
   * this card is tried, and the renewal card is left as it is. Null: the subscription's default.
   */
  paymentMethodId?: string | null;
}

export interface ChangeSubscriptionPriceResult {
  /** False when nothing changed: the payment did not go through, or the amount was not the one confirmed. */
  applied: boolean;
  /** Why nothing changed, when `applied` is false. */
  failure?: "declined" | "amount_changed";
  /** The provider's reason for a decline, for the buyer ("Your card has insufficient funds."). */
  declineMessage?: string;
  /**
   * The invoice this change created (with `chargeNow`), as the provider recorded it: what the card
   * was actually charged, to check against what the buyer confirmed. Null when none was created.
   */
  invoice: { id: string; amountPaidMinor: number; currency: string } | null;
}

/**
 * Move a subscription to another price from its next renewal on, with nothing charged or credited
 * now (Stripe: a subscription schedule whose second phase starts at the current period's end).
 */
export interface ScheduleSubscriptionPriceChangeInput {
  providerSubscriptionId: string;
  priceId: string;
  /** Written onto the subscription when the new price starts (the new local `price_id`, say). */
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface ScheduleSubscriptionPriceChangeResult {
  scheduleId: string;
  /** When the new price starts: the end of the current period. */
  effectiveAt: Date;
}

/** A saved card of the customer, as the payer picks it: never the full number. */
export interface SavedPaymentMethod extends PaymentMethodSummary {
  id: string;
  /** The card renewals are charged to. */
  isDefault: boolean;
}

/** A card or other payment method, as the buyer would recognise it. */
export interface PaymentMethodSummary {
  brand: string;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface SubscriptionInvoiceSummary {
  id: string;
  number: string | null;
  status: string | null;
  created: Date;
  amountDueMinor: number;
  amountPaidMinor: number;
  /** Refunded so far on the payment behind it. */
  amountRefundedMinor: number;
  currency: string;
  /** Why it was raised: `subscription_create`, `subscription_cycle`, `subscription_update`, ... */
  billingReason: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export interface SubscriptionBillingSummary {
  paymentMethod: PaymentMethodSummary | null;
  /** The next regular bill, or null when the subscription will not renew. */
  nextBill: { amountMinor: number; currency: string; at: Date } | null;
  /** Newest first. */
  invoices: SubscriptionInvoiceSummary[];
}

/** What `changeSubscriptionPrice` with the same inputs would bill, computed without changing it. */
export interface PreviewSubscriptionPriceChangeInput {
  providerSubscriptionId: string;
  priceId: string;
  chargeNow: boolean;
  /** Unix seconds; send the same value to `changeSubscriptionPrice`. */
  prorationDate: number;
}

export interface PreviewSubscriptionPriceChangeResult {
  /**
   * With `chargeNow`, the amount charged at once (the new price for the rest of the period, less
   * the unused part of the old one, less any customer credit). Without it, the total of the next
   * regular invoice, credits included.
   */
  amountDueMinor: number;
  /** ISO 4217, upper case. */
  currency: string;
}

/**
 * Purchases of one add-on the provider knows about that Studafy may not have heard of yet (its
 * webhook still on the way): subscriptions that are live or still settling their first payment,
 * and hosted checkouts still open for payment.
 */
export interface AddonPurchasesInFlight {
  liveSubscriptionIds: string[];
  openCheckoutSessionIds: string[];
}

export interface ListInvoicesInput {
  customerId: string;
  limit?: number;
  startingAfter?: string;
}

export interface InvoiceSummary {
  id: string;
  status: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  created: Date;
  periodStart: Date;
  periodEnd: Date;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export interface ListInvoicesResult {
  invoices: InvoiceSummary[];
  hasMore: boolean;
}

/**
 * Return money for one payment, in full or in part.
 *
 * `invoiceId` is the payment exactly as `listInvoices` names it -- a Stripe invoice, or a Tap
 * charge -- so a caller never has to know which provider-side object actually holds the money.
 * `idempotencyKey` must be stable for one refund attempt: a retried call with the same key must not
 * refund twice where the provider supports it.
 */
export interface RefundInput {
  invoiceId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export interface RefundResult {
  providerRefundId: string;
  /** `pending` when the provider accepted the refund but settles it asynchronously. */
  status: "succeeded" | "pending";
}

export interface PaymentProviderPort {
  /**
   * Stripe only: whether the configured key opens the live account (true) or a Sandbox (false), read
   * from the key's prefix. Undefined when unknown (a test double, or Tap): no mode decision is made.
   */
  readonly livemode?: boolean;
  createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult>;
  /**
   * The customer as the configured key sees it: its mode, or null when this account has no such
   * customer (it belongs to the other mode, or was deleted). Throws on a provider failure.
   */
  retrieveCustomer?(customerId: string): Promise<{ livemode: boolean } | null>;
  /** The customer this account already holds for a school (`metadata.school_id`), or null. */
  findCustomerBySchoolId?(schoolId: string): Promise<string | null>;
  /**
   * The subscription as the configured key sees it: its mode, or null when this account has no such
   * subscription. Throws on a provider failure.
   */
  retrieveSubscriptionMode?(subscriptionId: string): Promise<{ livemode: boolean } | null>;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CreateCheckoutSessionResult>;
  /** A one-time hosted payment (fees). See `CreatePaymentSessionInput`. */
  createPaymentSession(input: CreatePaymentSessionInput): Promise<CreatePaymentSessionResult>;
  createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<CreateBillingPortalSessionResult>;
  syncProduct(input: SyncProductInput): Promise<SyncProductResult>;
  syncPrice(input: SyncPriceInput): Promise<SyncPriceResult>;
  parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent>;
  lookupProductById(providerProductId: string): Promise<LookupProductResult | null>;
  lookupPriceById(providerPriceId: string): Promise<LookupPriceResult | null>;
  /**
   * Stop billing a subscription without canceling it. Used to pause a student's AI subscription
   * when their school is suspended; must be resumable via `resumeSubscription`. Idempotent: pausing
   * an already-paused subscription is a no-op update, not an error.
   */
  pauseSubscription(input: PauseSubscriptionInput): Promise<void>;
  /**
   * Resume billing a subscription paused via `pauseSubscription`. Idempotent for the same reason.
   */
  resumeSubscription(input: ResumeSubscriptionInput): Promise<void>;
  /**
   * Schedule a subscription to cancel at the end of its current billing period. Does not end access
   * immediately and does not itself move local subscription status -- the eventual
   * `customer.subscription.deleted` webhook is what does that, through the existing state machine.
   */
  scheduleCancellation(input: ScheduleCancellationInput): Promise<void>;
  /** Undo a pending end-of-period cancellation. No-op if the subscription was not scheduled to cancel. */
  reverseCancellation(input: ReverseCancellationInput): Promise<void>;
  /**
   * Move a subscription to another price, prorated. Optional: only a provider that keeps the
   * subscription itself (Stripe) can; Tap has no subscription object to change.
   */
  changeSubscriptionPrice?(
    input: ChangeSubscriptionPriceInput,
  ): Promise<ChangeSubscriptionPriceResult>;
  /** Schedule a price change for the next renewal. Implemented wherever `changeSubscriptionPrice` is. */
  scheduleSubscriptionPriceChange?(
    input: ScheduleSubscriptionPriceChangeInput,
  ): Promise<ScheduleSubscriptionPriceChangeResult>;
  /** Undo a scheduled change: the subscription carries on as it is. Idempotent. */
  releaseSubscriptionSchedule?(scheduleId: string): Promise<void>;
  /**
   * Invoice items waiting for the customer's next invoice (prorations from earlier changes, say).
   * A preview counts them but an immediate change does not, so a change is refused while any exist.
   */
  countPendingInvoiceItems?(customerId: string): Promise<{ count: number; netMinor: number }>;
  /** Payment method, next bill and invoices of one subscription. */
  describeSubscriptionBilling?(providerSubscriptionId: string): Promise<SubscriptionBillingSummary>;
  /**
   * A hosted page where the customer replaces their card, and nothing else: no plan change and no
   * cancellation, so the provider and Studafy never disagree about the plan.
   */
  createPaymentMethodPortalSession?(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<CreateBillingPortalSessionResult>;
  /** The customer's saved cards, the subscription's renewal card marked as default. */
  listPaymentMethods?(input: {
    customerId: string;
    providerSubscriptionId: string | null;
  }): Promise<SavedPaymentMethod[]>;
  /** A hosted page where the customer saves a new card without paying anything. */
  createCardSetupSession?(input: {
    customerId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<CreateBillingPortalSessionResult>;
  /** Make `paymentMethodId` the card the subscription renews on. */
  setSubscriptionPaymentMethod?(input: {
    providerSubscriptionId: string;
    paymentMethodId: string;
  }): Promise<void>;
  /** The bill `changeSubscriptionPrice` would produce. Implemented wherever it is. */
  previewSubscriptionPriceChange?(
    input: PreviewSubscriptionPriceChangeInput,
  ): Promise<PreviewSubscriptionPriceChangeResult>;
  /**
   * The customer's purchases of the add-on named by `metadata.addon` that are live or still open
   * for payment at the provider, whatever Studafy has recorded so far.
   */
  findAddonPurchasesInFlight?(input: {
    customerId: string;
    addon: string;
  }): Promise<AddonPurchasesInFlight>;
  /**
   * Close a hosted checkout so it can no longer be paid. `"completed"` when it was paid before it
   * could be closed; `"expired"` when it is closed (or already was).
   */
  expireCheckoutSession?(sessionId: string): Promise<"expired" | "completed">;
  /** List invoices billed to a customer, newest first. */
  listInvoices(input: ListInvoicesInput): Promise<ListInvoicesResult>;
  /**
   * Refund one paid invoice (or Tap charge), fully or partially. A provider that cannot refund
   * throws a 501 `PAYMENT_PROVIDER_OPERATION_UNSUPPORTED`; a provider-side failure is a 502.
   */
  refund(input: RefundInput): Promise<RefundResult>;
}
