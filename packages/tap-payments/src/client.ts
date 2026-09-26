/**
 * A minimal client for Tap Payments' REST API v2.
 *
 * Shared by apps/api (checkout, webhook re-reads, invoice listing) and apps/workers (renewal
 * charges), so both speak to Tap with one request builder and one error shape. It knows nothing
 * about Studafy's ports or error codes; callers translate `TapApiError` into their own.
 *
 * Card data never passes through here. Hosted charges send the payer to Tap's page, and renewals
 * charge a card Tap already holds, by its id, through a single-use token Tap mints for it.
 */

import { toTapAmount } from "./currency";

import type {
  CreateHostedChargeInput,
  CreateSavedCardChargeInput,
  ListChargesInput,
  ListChargesResult,
  TapCharge,
} from "./charge";

export const TAP_API_BASE_URL = "https://api.tap.company/v2";

/** Upper bound on one Tap API call. Callers may hold a database transaction open meanwhile. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface TapClientOptions {
  /** `sk_test_...` or `sk_live_...`. Also the HMAC key Tap signs webhooks with. */
  secretKey: string;
  /** Overridable for tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * A failed Tap call.
 *
 * `status` is the HTTP status Tap answered with, or 502 when Tap could not be reached or answered
 * with something unreadable -- in both cases the fault is upstream of the caller.
 */
export class TapApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TapApiError";
  }
}

export class TapClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: TapClientOptions) {
    if (!options.secretKey) throw new Error("TapClient requires a secret key");
    this.secretKey = options.secretKey;
    this.baseUrl = options.baseUrl ?? TAP_API_BASE_URL;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** True for a sandbox key. Test-mode charges never move money. */
  get isTestMode(): boolean {
    return this.secretKey.startsWith("sk_test_");
  }

  async createCustomer(input: {
    name: string;
    email?: string;
    metadata: Record<string, string>;
  }): Promise<{ id: string }> {
    // Tap splits names; a school or payer name is stored whole in first_name rather than guessed
    // apart. Email is sent only when known -- Tap rejects an empty string as an invalid address.
    const customer = await this.request<{ id?: string }>("POST", "/customers", {
      first_name: input.name,
      ...(input.email ? { email: input.email } : {}),
      metadata: input.metadata,
    });
    if (!customer.id) throw new TapApiError(502, "Tap returned no customer id");
    return { id: customer.id };
  }

  /** A customer-initiated charge on Tap's hosted page. Returns the charge with `transaction.url`. */
  createHostedCharge(input: CreateHostedChargeInput): Promise<TapCharge> {
    return this.request<TapCharge>("POST", "/charges", {
      amount: toTapAmount(input.amountMinor, input.currency),
      currency: input.currency.toUpperCase(),
      customer_initiated: true,
      threeDSecure: true,
      save_card: input.saveCard,
      description: input.description,
      metadata: input.metadata,
      ...(input.orderReference ? { reference: { order: input.orderReference } } : {}),
      receipt: { email: true, sms: false },
      customer: { id: input.customerId },
      // src_all: Tap's page offers every method enabled on the account for this currency --
      // card, mada, KNET, Benefit -- so method availability is account configuration, not code.
      source: { id: "src_all" },
      post: { url: input.webhookUrl },
      redirect: { url: input.redirectUrl },
    });
  }

  /**
   * A merchant-initiated charge against a saved card: mint a single-use token for the card, then
   * charge the token under the card's payment agreement. Tap answers with the charge's final status
   * directly (there is no payer to redirect) and also posts it to `webhookUrl`.
   */
  async chargeSavedCard(input: CreateSavedCardChargeInput): Promise<TapCharge> {
    const token = await this.request<{ id?: string }>("POST", "/tokens", {
      saved_card: { card_id: input.cardId, customer_id: input.customerId },
    });
    if (!token.id) throw new TapApiError(502, "Tap returned no token for the saved card");

    return this.request<TapCharge>("POST", "/charges", {
      amount: toTapAmount(input.amountMinor, input.currency),
      currency: input.currency.toUpperCase(),
      customer_initiated: false,
      threeDSecure: false,
      save_card: false,
      payment_agreement: { id: input.paymentAgreementId },
      description: input.description,
      metadata: input.metadata,
      ...(input.orderReference ? { reference: { order: input.orderReference } } : {}),
      receipt: { email: true, sms: false },
      customer: { id: input.customerId },
      source: { id: token.id },
      post: { url: input.webhookUrl },
    });
  }

  retrieveCharge(chargeId: string): Promise<TapCharge> {
    return this.request<TapCharge>("GET", `/charges/${encodeURIComponent(chargeId)}`);
  }

  async listCharges(input: ListChargesInput): Promise<ListChargesResult> {
    const page = await this.request<{ charges?: TapCharge[]; has_more?: boolean }>(
      "POST",
      "/charges/list",
      {
        customers: [input.customerId],
        limit: input.limit,
        ...(input.startingAfter ? { starting_after: input.startingAfter } : {}),
      },
    );
    return {
      charges: Array.isArray(page.charges) ? page.charges : [],
      hasMore: page.has_more === true,
    };
  }

  /**
   * One Tap API call. Every failure -- network, timeout, non-2xx, unreadable body -- leaves as a
   * `TapApiError`, with Tap's own error description when it sent one.
   */
  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TapApiError(502, `Tap unreachable: ${reason}`);
    }

    const parsed = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new TapApiError(
        response.status >= 500 ? 502 : response.status,
        `Tap ${method} ${path} failed with ${response.status}: ${describeTapError(parsed)}`,
      );
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new TapApiError(502, "Tap returned no JSON body");
    }
    return parsed as T;
  }
}

/** Tap errors arrive as `{ errors: [{ code, description }] }`. */
function describeTapError(body: unknown): string {
  const errors = (body as { errors?: { code?: unknown; description?: unknown }[] } | null)?.errors;
  const first = Array.isArray(errors) ? errors[0] : undefined;
  if (first && typeof first.description === "string") {
    return typeof first.code === "string"
      ? `${first.code} ${first.description}`
      : first.description;
  }
  return "no error description";
}
