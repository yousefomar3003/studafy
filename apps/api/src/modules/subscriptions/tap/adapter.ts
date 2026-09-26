/**
 * Tap Payments behind `PaymentProviderPort` (ST-298).
 *
 * ## What Tap provides, and how each port operation maps onto it
 *
 * Tap is a charge API with a hosted payment page. It has customers, charges and saved cards; it has
 * no product or price catalog, no subscription object and no customer billing portal. So:
 *
 *   - `createCustomer`, `createCheckoutSession`, `createPaymentSession`, `parseWebhook` and
 *     `listInvoices` (the customer's charges) are real Tap calls.
 *   - A subscription checkout saves the card (`save_card`). Renewals are Studafy's job: the renewal
 *     worker in apps/workers charges that card each period. That is why pause, resume and
 *     cancellation have nothing to tell Tap -- see the note on those methods.
 *   - `lookupProductById` / `lookupPriceById` return `null`: nothing exists at Tap to find.
 *   - `syncProduct`, `syncPrice` and `createBillingPortalSession` throw a 501
 *     `PAYMENT_PROVIDER_OPERATION_UNSUPPORTED`: returning success would claim a change that did not
 *     happen anywhere.
 *
 * ## No card data touches Studafy
 *
 * Every charge a payer makes goes through Tap's hosted page (`source: src_all`), where card, mada,
 * KNET or Benefit details are entered -- which of those appear is Tap account configuration per
 * currency. Renewals charge the saved card by id through a single-use Tap token. This process only
 * ever handles charge, card and agreement *ids*, statuses and amounts.
 */

import { ERROR_CODES } from "@studafy/constants";
import {
  fromTapAmount,
  TapAmountError,
  TapApiError,
  TapClient,
  verifyTapHashString,
} from "@studafy/tap-payments";

import { PaymentProviderError } from "../ports/payment-provider";

import { normalizeTapCharge, TapChargeShapeError } from "./event-normalizer";

import type {
  CreateBillingPortalSessionInput,
  CreateBillingPortalSessionResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  CreateCustomerInput,
  CreateCustomerResult,
  CreatePaymentSessionInput,
  CreatePaymentSessionResult,
  ListInvoicesInput,
  ListInvoicesResult,
  LookupPriceResult,
  LookupProductResult,
  ParsedWebhookEvent,
  PauseSubscriptionInput,
  PaymentProviderPort,
  ResumeSubscriptionInput,
  ReverseCancellationInput,
  ScheduleCancellationInput,
  SyncPriceInput,
  SyncPriceResult,
  SyncProductInput,
  SyncProductResult,
} from "../ports/payment-provider";
import type { TapCharge, TapClientOptions } from "@studafy/tap-payments";

export interface TapAdapterOptions extends TapClientOptions {
  /** Public URL of `POST /api/subscriptions/webhook/tap`, sent on every charge as `post.url`. */
  webhookUrl: string;
}

export class TapAdapter implements PaymentProviderPort {
  private readonly client: TapClient;
  private readonly secretKey: string;
  private readonly webhookUrl: string;

  constructor(options: TapAdapterOptions) {
    if (!options.secretKey) throw new Error("TapAdapter requires a secret key");
    if (!options.webhookUrl) throw new Error("TapAdapter requires a webhook URL");

    this.client = new TapClient(options);
    this.secretKey = options.secretKey;
    this.webhookUrl = options.webhookUrl;
  }

  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    requireValue(input.name, "name");
    const customer = await translate(() => this.client.createCustomer(input));
    return { providerCustomerId: customer.id };
  }

  /**
   * The first charge of a subscription, on Tap's hosted page, saving the card for renewals.
   *
   * Tap has a single `redirect.url` for every outcome, so `cancelUrl` has nowhere to go. Tap appends
   * `tap_id` to the redirect; the page it lands on must read the charge status rather than assume
   * success -- the webhook, not the redirect, is what changes subscription state.
   */
  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CreateCheckoutSessionResult> {
    requireValue(input.customerId, "customerId");

    const charge = await translate(() =>
      this.client.createHostedCharge({
        amountMinor: input.amountMinor * (input.quantity ?? 1),
        currency: input.currency,
        customerId: input.customerId,
        description: "Studafy subscription",
        metadata: { ...input.metadata, billing_reason: "subscription_create" },
        orderReference: input.priceId,
        webhookUrl: this.webhookUrl,
        redirectUrl: input.successUrl,
        saveCard: true,
      }),
    );
    return hostedPage(charge);
  }

  /** A one-time fee payment on Tap's hosted page. No card is saved; no `billing_reason` is set. */
  async createPaymentSession(
    input: CreatePaymentSessionInput,
  ): Promise<CreatePaymentSessionResult> {
    requireValue(input.customerId, "customerId");
    if (Object.hasOwn(input.metadata, "billing_reason")) {
      throw new PaymentProviderError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        "A one-time payment must not carry a subscription billing_reason",
      );
    }

    const charge = await translate(() =>
      this.client.createHostedCharge({
        amountMinor: input.amountMinor,
        currency: input.currency,
        customerId: input.customerId,
        description: input.description,
        metadata: input.metadata,
        webhookUrl: this.webhookUrl,
        redirectUrl: input.successUrl,
        saveCard: false,
      }),
    );
    return hostedPage(charge);
  }

  /**
   * Verify the `hashstring`, then re-read the charge from Tap and normalize *that*.
   *
   * The digest covers the status, amount and references but not `metadata` or `customer` -- the two
   * fields attribution reads -- so the posted body cannot be trusted for them even once it verifies.
   * The re-read costs one API call per webhook and makes every field authoritative.
   *
   * Failures are split by what they mean: a bad or absent signature is a 400, a Tap outage while
   * re-reading is a 502. The processor alerts on the first and asks for redelivery on the second.
   */
  async parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent> {
    if (!signature) {
      throw invalidWebhook("Missing hashstring header");
    }

    let posted: TapCharge;
    try {
      posted = JSON.parse(payload.toString("utf8")) as TapCharge;
    } catch {
      throw invalidWebhook("Webhook body is not JSON");
    }

    if (posted.object !== "charge" || !verifyTapHashString(posted, signature, this.secretKey)) {
      throw invalidWebhook("Invalid hashstring");
    }

    const charge = await translate(() => this.client.retrieveCharge(posted.id!));

    try {
      return normalizeTapCharge(charge);
    } catch (error) {
      if (error instanceof TapChargeShapeError) throw invalidWebhook(error.message);
      throw error;
    }
  }

  /**
   * The customer's charges, newest first, as invoice summaries.
   *
   * Tap issues no invoice object for a charge, so there is no hosted invoice or PDF; the period is
   * the one Studafy stamped on a renewal charge's metadata, or the charge date otherwise.
   */
  async listInvoices(input: ListInvoicesInput): Promise<ListInvoicesResult> {
    requireValue(input.customerId, "customerId");

    const page = await translate(() =>
      this.client.listCharges({
        customerId: input.customerId,
        limit: input.limit ?? 20,
        startingAfter: input.startingAfter,
      }),
    );

    return {
      invoices: page.charges.filter((charge) => charge.id).map(toInvoiceSummary),
      hasMore: page.hasMore,
    };
  }

  async lookupProductById(_providerProductId: string): Promise<LookupProductResult | null> {
    return null;
  }

  async lookupPriceById(_providerPriceId: string): Promise<LookupPriceResult | null> {
    return null;
  }

  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<CreateBillingPortalSessionResult> {
    requireValue(input.customerId, "customerId");
    throw unsupported("a customer billing portal");
  }

  async syncProduct(input: SyncProductInput): Promise<SyncProductResult> {
    requireValue(input.name, "name");
    throw unsupported("a product catalog");
  }

  async syncPrice(input: SyncPriceInput): Promise<SyncPriceResult> {
    requireValue(input.productId, "productId");
    throw unsupported("a price catalog");
  }

  // Pause, resume and cancellation: Tap bills nothing on its own -- every renewal is a charge the
  // Studafy renewal worker decides to make, and it charges only live subscriptions not flagged
  // `cancel_at_period_end`. The local status and flag the callers write are therefore the whole of
  // the change, and there is nothing to tell Tap. Validated per the port contract, then a no-op.

  async pauseSubscription(input: PauseSubscriptionInput): Promise<void> {
    requireValue(input.providerSubscriptionId, "providerSubscriptionId");
  }

  async resumeSubscription(input: ResumeSubscriptionInput): Promise<void> {
    requireValue(input.providerSubscriptionId, "providerSubscriptionId");
  }

  async scheduleCancellation(input: ScheduleCancellationInput): Promise<void> {
    requireValue(input.providerSubscriptionId, "providerSubscriptionId");
  }

  async reverseCancellation(input: ReverseCancellationInput): Promise<void> {
    requireValue(input.providerSubscriptionId, "providerSubscriptionId");
  }
}

/** Run a Tap call, re-raising its failures as the port's error type. */
async function translate<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    // Always 502: whatever Tap answered, the failure is upstream of our caller.
    if (error instanceof TapApiError) {
      throw new PaymentProviderError(502, ERROR_CODES.TAP_API_ERROR, error.message);
    }
    if (error instanceof TapAmountError) {
      throw new PaymentProviderError(400, ERROR_CODES.VALIDATION_FAILED, error.message);
    }
    throw error;
  }
}

function hostedPage(charge: TapCharge): { url: string; sessionId: string } {
  const url = charge.transaction?.url;
  if (!charge.id || !url) {
    throw new PaymentProviderError(
      502,
      ERROR_CODES.TAP_API_ERROR,
      "Tap charge returned no hosted payment URL",
    );
  }
  return { url, sessionId: charge.id };
}

const TAP_STATUS_TO_INVOICE_STATUS: Readonly<Record<string, string>> = {
  CAPTURED: "paid",
  INITIATED: "open",
  IN_PROGRESS: "open",
};

function toInvoiceSummary(charge: TapCharge): ListInvoicesResult["invoices"][number] {
  const currency = (charge.currency ?? "").toUpperCase();
  const amountMinor = fromTapAmount(charge.amount ?? 0, currency) ?? 0;
  const created = new Date(Number(charge.transaction?.created ?? 0));
  const status = charge.status?.toUpperCase() ?? "";

  const metadata = charge.metadata ?? {};
  const periodStart = Number(metadata.period_start);
  const periodEnd = Number(metadata.period_end);
  const hasPeriod = Number.isFinite(periodStart) && Number.isFinite(periodEnd);

  return {
    id: charge.id!,
    status: Object.hasOwn(TAP_STATUS_TO_INVOICE_STATUS, status)
      ? TAP_STATUS_TO_INVOICE_STATUS[status]!
      : "uncollectible",
    amountDue: amountMinor,
    amountPaid: status === "CAPTURED" ? amountMinor : 0,
    currency,
    created,
    periodStart: hasPeriod ? new Date(periodStart * 1000) : created,
    periodEnd: hasPeriod ? new Date(periodEnd * 1000) : created,
    hostedInvoiceUrl: null,
    invoicePdf: null,
  };
}

function requireValue(value: string, field: string): void {
  if (!value || value.trim() === "") {
    throw new PaymentProviderError(400, ERROR_CODES.VALIDATION_FAILED, `${field} is required`);
  }
}

function unsupported(capability: string): PaymentProviderError {
  return new PaymentProviderError(
    501,
    ERROR_CODES.PAYMENT_PROVIDER_OPERATION_UNSUPPORTED,
    `Tap Payments has no ${capability}`,
  );
}

function invalidWebhook(message: string): PaymentProviderError {
  return new PaymentProviderError(400, ERROR_CODES.TAP_WEBHOOK_INVALID, message);
}
