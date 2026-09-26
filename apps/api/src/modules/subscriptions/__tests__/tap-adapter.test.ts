import { computeTapHashString } from "@studafy/tap-payments";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PaymentProviderError } from "../ports/payment-provider";
import { TapAdapter } from "../tap/adapter";

import type { TapCharge } from "@studafy/tap-payments";

const SECRET = "sk_test_adapter_fixture";
const WEBHOOK_URL = "https://api.studafy.test/api/subscriptions/webhook/tap";
const BASE_URL = "https://tap.test/v2";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Route = (body: unknown) => { status: number; body: unknown };

/** A fetch that answers from a route table and records what it was asked. */
function fakeTap(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method, url, headers: init?.headers as Record<string, string>, body });

    const handler = routes[`${method} ${url.replace(BASE_URL, "")}`];
    if (!handler) return new Response("not found", { status: 404 });
    const answer = handler(body);
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;

  const adapter = new TapAdapter({
    secretKey: SECRET,
    webhookUrl: WEBHOOK_URL,
    baseUrl: BASE_URL,
    fetch: fetchFn,
  });

  return { adapter, requests };
}

const hostedCharge: Route = () => ({
  status: 200,
  body: {
    id: "chg_TS01",
    status: "INITIATED",
    transaction: { url: "https://checkout.tap.test/chg_TS01" },
  },
});

async function expectProviderError(promise: Promise<unknown>, status: number, code: string) {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentProviderError);
  expect((error as PaymentProviderError).status as number).toBe(status);
  expect((error as PaymentProviderError).code as string).toBe(code);
}

describe("TapAdapter.createCheckoutSession", () => {
  const input = {
    customerId: "cus_TS01",
    priceId: "0b6f7a2e-price",
    amountMinor: 15_500,
    currency: "jod",
    successUrl: "https://app.studafy.test/billing/return",
    cancelUrl: "https://app.studafy.test/billing",
    metadata: { school_id: "school-1", plan_id: "plan-1", billing_interval: "monthly" },
  };

  test("creates a hosted JOD charge that saves the card, and returns Tap's page", async () => {
    const { adapter, requests } = fakeTap({ "POST /charges": hostedCharge });

    const session = await adapter.createCheckoutSession(input);

    expect(session).toEqual({ url: "https://checkout.tap.test/chg_TS01", sessionId: "chg_TS01" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(requests[0]!.body).toMatchObject({
      amount: 15.5,
      currency: "JOD",
      customer_initiated: true,
      save_card: true,
      customer: { id: "cus_TS01" },
      source: { id: "src_all" },
      post: { url: WEBHOOK_URL },
      redirect: { url: input.successUrl },
      metadata: {
        school_id: "school-1",
        plan_id: "plan-1",
        billing_interval: "monthly",
        billing_reason: "subscription_create",
      },
    });
  });

  test("sends no card fields: the payer enters them on Tap's page", async () => {
    const { adapter, requests } = fakeTap({ "POST /charges": hostedCharge });

    await adapter.createCheckoutSession(input);

    const serialized = JSON.stringify(requests[0]!.body);
    for (const field of ["number", "cvc", "exp_month", "exp_year"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  test("multiplies the unit amount by the seat quantity", async () => {
    const { adapter, requests } = fakeTap({ "POST /charges": hostedCharge });

    await adapter.createCheckoutSession({ ...input, amountMinor: 2_250, quantity: 40 });

    expect(requests[0]!.body!.amount).toBe(90);
  });

  test("any Tap failure is a 502 carrying Tap's description, never Tap's own status", async () => {
    const { adapter } = fakeTap({
      "POST /charges": () => ({
        status: 401,
        body: { errors: [{ code: "2107", description: "Invalid API key" }] },
      }),
    });

    const error = await adapter.createCheckoutSession(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect((error as PaymentProviderError).status as number).toBe(502);
    expect((error as PaymentProviderError).message).toContain("Invalid API key");
  });

  test("a charge without a payment URL is an error, not a broken redirect", async () => {
    const { adapter } = fakeTap({
      "POST /charges": () => ({ status: 200, body: { id: "chg_TS01", transaction: {} } }),
    });
    await expectProviderError(adapter.createCheckoutSession(input), 502, "TAP_API_ERROR");
  });

  test("rejects an empty customer or an unsettled currency without calling Tap", async () => {
    const { adapter, requests } = fakeTap({});
    await expectProviderError(
      adapter.createCheckoutSession({ ...input, customerId: "" }),
      400,
      "VALIDATION_FAILED",
    );
    await expectProviderError(
      adapter.createCheckoutSession({ ...input, currency: "JPY" }),
      400,
      "VALIDATION_FAILED",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("TapAdapter.createPaymentSession", () => {
  const input = {
    customerId: "cus_PAYER",
    amountMinor: 120_000,
    currency: "JOD",
    description: "Tuition ACC-SINV-0001",
    successUrl: "https://app.studafy.test/fees/return",
    cancelUrl: "https://app.studafy.test/fees",
    metadata: { purpose: "fee_payment", online_payment_id: "pay-1", school_id: "school-1" },
  };

  test("creates a one-time hosted charge that saves no card and sets no billing_reason", async () => {
    const { adapter, requests } = fakeTap({ "POST /charges": hostedCharge });

    const session = await adapter.createPaymentSession(input);

    expect(session.sessionId).toBe("chg_TS01");
    expect(requests[0]!.body).toMatchObject({
      amount: 120,
      currency: "JOD",
      save_card: false,
      source: { id: "src_all" },
      metadata: input.metadata,
    });
    expect((requests[0]!.body!.metadata as Record<string, unknown>).billing_reason).toBeUndefined();
  });

  test("refuses metadata that would make a fee look like a subscription payment", async () => {
    const { adapter, requests } = fakeTap({});
    await expectProviderError(
      adapter.createPaymentSession({
        ...input,
        metadata: { ...input.metadata, billing_reason: "subscription_cycle" },
      }),
      400,
      "VALIDATION_FAILED",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("TapAdapter.createCustomer", () => {
  test("creates a customer with metadata and omits an empty email", async () => {
    const { adapter, requests } = fakeTap({
      "POST /customers": () => ({ status: 200, body: { id: "cus_TS01" } }),
    });

    const result = await adapter.createCustomer({
      name: "Amman Academy",
      email: "",
      metadata: { school_id: "school-1" },
    });

    expect(result).toEqual({ providerCustomerId: "cus_TS01" });
    expect(requests[0]!.body).toEqual({
      first_name: "Amman Academy",
      metadata: { school_id: "school-1" },
    });
  });

  test("rejects an empty name without calling Tap", async () => {
    const { adapter, requests } = fakeTap({});
    await expectProviderError(
      adapter.createCustomer({ name: "", email: "", metadata: {} }),
      400,
      "VALIDATION_FAILED",
    );
    expect(requests).toHaveLength(0);
  });
});

describe("TapAdapter.parseWebhook", () => {
  const stored: TapCharge = {
    id: "chg_TS01",
    object: "charge",
    live_mode: false,
    status: "CAPTURED",
    amount: 15.5,
    currency: "JOD",
    customer: { id: "cus_TS01" },
    metadata: {
      school_id: "school-1",
      billing_reason: "subscription_create",
      billing_interval: "monthly",
    },
    reference: { gateway: "g1", payment: "p1" },
    transaction: { created: "1727251200000" },
    card: { id: "card_TS01" },
    payment_agreement: { id: "payment_agreement_TS01" },
  };

  const signed = (body: TapCharge) => ({
    payload: Buffer.from(JSON.stringify(body)),
    signature: computeTapHashString(body, SECRET)!,
  });

  test("verifies, re-reads the charge from Tap, and normalizes the stored copy", async () => {
    const { adapter, requests } = fakeTap({
      "GET /charges/chg_TS01": () => ({ status: 200, body: stored }),
    });

    const { payload, signature } = signed(stored);
    const event = await adapter.parseWebhook(payload, signature);

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${BASE_URL}/charges/chg_TS01`,
    ]);
    expect(event).toMatchObject({
      id: "chg_TS01:CAPTURED",
      type: "checkout.session.completed",
      livemode: false,
      data: {
        customer: "cus_TS01",
        metadata: { school_id: "school-1" },
        payment_method: {
          tap_card_id: "card_TS01",
          tap_payment_agreement_id: "payment_agreement_TS01",
        },
      },
    });
  });

  test("unsigned fields are taken from Tap, never from the posted body", async () => {
    const { adapter } = fakeTap({
      "GET /charges/chg_TS01": () => ({ status: 200, body: stored }),
    });

    // A genuine signature over a body whose metadata was edited in transit: still verifies,
    // because Tap does not sign metadata -- and must still not move another school's subscription.
    const tampered = { ...stored, metadata: { school_id: "attacker-school" } };
    const { payload, signature } = signed(tampered);
    const event = await adapter.parseWebhook(payload, signature);

    expect((event.data.metadata as Record<string, unknown>).school_id).toBe("school-1");
  });

  test("a bad signature is a 400 and never calls Tap", async () => {
    const { adapter, requests } = fakeTap({});
    const { payload } = signed(stored);
    await expectProviderError(
      adapter.parseWebhook(payload, "0".repeat(64)),
      400,
      "TAP_WEBHOOK_INVALID",
    );
    await expectProviderError(adapter.parseWebhook(payload, ""), 400, "TAP_WEBHOOK_INVALID");
    await expectProviderError(
      adapter.parseWebhook(Buffer.from("not json"), "abc"),
      400,
      "TAP_WEBHOOK_INVALID",
    );
    expect(requests).toHaveLength(0);
  });

  test("a non-charge object is refused", async () => {
    const { adapter } = fakeTap({});
    const { payload, signature } = signed({ ...stored, object: "refund" });
    await expectProviderError(adapter.parseWebhook(payload, signature), 400, "TAP_WEBHOOK_INVALID");
  });

  test("Tap failing during the re-read is a 502, distinguishable from a bad signature", async () => {
    const { adapter } = fakeTap({
      "GET /charges/chg_TS01": () => ({ status: 503, body: { errors: [] } }),
    });
    const { payload, signature } = signed(stored);
    await expectProviderError(adapter.parseWebhook(payload, signature), 502, "TAP_API_ERROR");
  });
});

describe("TapAdapter.listInvoices", () => {
  test("maps the customer's charges to invoice summaries", async () => {
    const { adapter, requests } = fakeTap({
      "POST /charges/list": () => ({
        status: 200,
        body: {
          has_more: true,
          charges: [
            {
              id: "chg_R2",
              status: "CAPTURED",
              amount: 15.5,
              currency: "JOD",
              transaction: { created: "1730000000000" },
              metadata: { period_start: "1730000000", period_end: "1732600000" },
            },
            {
              id: "chg_R1",
              status: "DECLINED",
              amount: 15.5,
              currency: "JOD",
              transaction: { created: "1727251200000" },
            },
          ],
        },
      }),
    });

    const page = await adapter.listInvoices({ customerId: "cus_TS01", limit: 2 });

    expect(requests[0]!.body).toEqual({ customers: ["cus_TS01"], limit: 2 });
    expect(page.hasMore).toBe(true);
    expect(page.invoices[0]).toMatchObject({
      id: "chg_R2",
      status: "paid",
      amountDue: 15_500,
      amountPaid: 15_500,
      currency: "JOD",
      hostedInvoiceUrl: null,
    });
    expect(page.invoices[0]!.periodStart.toISOString()).toBe("2024-10-27T03:33:20.000Z");
    expect(page.invoices[1]).toMatchObject({
      id: "chg_R1",
      status: "uncollectible",
      amountPaid: 0,
    });
  });
});

describe("TapAdapter — operations Tap has no equivalent for", () => {
  const { adapter } = fakeTap({});
  const unsupported = "PAYMENT_PROVIDER_OPERATION_UNSUPPORTED";

  test("catalog sync and the billing portal answer 501", async () => {
    await expectProviderError(
      adapter.syncProduct({ localId: "p", name: "Plan", active: true }),
      501,
      unsupported,
    );
    await expectProviderError(
      adapter.syncPrice({
        localId: "p",
        productId: "prod",
        amountMinor: 100,
        currency: "JOD",
        interval: "month",
        active: true,
      }),
      501,
      unsupported,
    );
    await expectProviderError(
      adapter.createBillingPortalSession({ customerId: "cus", returnUrl: "https://x.test" }),
      501,
      unsupported,
    );
  });

  test("pause, resume and cancellation have nothing to tell Tap: validated, then no-ops", async () => {
    const id = { providerSubscriptionId: "s" };
    await expect(adapter.pauseSubscription(id)).resolves.toBeUndefined();
    await expect(adapter.resumeSubscription(id)).resolves.toBeUndefined();
    await expect(adapter.scheduleCancellation(id)).resolves.toBeUndefined();
    await expect(adapter.reverseCancellation(id)).resolves.toBeUndefined();
    await expectProviderError(
      adapter.pauseSubscription({ providerSubscriptionId: "" }),
      400,
      "VALIDATION_FAILED",
    );
  });

  test("lookups find nothing, because nothing exists at Tap to find", async () => {
    expect(await adapter.lookupProductById("prod_x")).toBeNull();
    expect(await adapter.lookupPriceById("price_x")).toBeNull();
  });
});

describe("TapAdapter constructor", () => {
  test("requires a secret key and a webhook URL", () => {
    expect(() => new TapAdapter({ secretKey: "", webhookUrl: WEBHOOK_URL })).toThrow();
    expect(() => new TapAdapter({ secretKey: SECRET, webhookUrl: "" })).toThrow();
  });
});
