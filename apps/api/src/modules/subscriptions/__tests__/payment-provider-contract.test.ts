// Contract tests for PaymentProviderPort.
//
// Every adapter implementation must pass this suite. Adapters call
// `contractTests('Stripe', () => new StripeAdapter(config))` from their own
// test file. This keeps the contract definition in one place and prevents
// adapter-specific tests from silently diverging from the port.

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PaymentProviderError } from "../ports/payment-provider";

import type {
  CancelAiSubscriptionParams,
  CancelSubscriptionParams,
  CheckoutResult,
  CreateCheckoutParams,
  CreatePortalParams,
  CustomerResult,
  NormalizedWebhookEvent,
  NormalizeWebhookParams,
  PaymentProviderPort,
  PortalResult,
  ResolveCustomerParams,
} from "../ports/payment-provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AdapterFactory = () => PaymentProviderPort;

const aSchoolId = () => crypto.randomUUID();
const aPlanId = () => crypto.randomUUID();
const aPriceId = () => crypto.randomUUID();
const aStudentId = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

export function contractTests(name: string, createAdapter: AdapterFactory): void {
  describe(`${name} — PaymentProviderPort contract`, () => {
    // -- Shape ---------------------------------------------------------------

    test("exposes all port methods", () => {
      const adapter = createAdapter();

      expect(adapter).toBeDefined();
      expect(typeof adapter.createCheckout).toBe("function");
      expect(typeof adapter.createPortal).toBe("function");
      expect(typeof adapter.cancelSubscription).toBe("function");
      expect(typeof adapter.cancelAiSubscription).toBe("function");
      expect(typeof adapter.normalizeWebhookEvent).toBe("function");
      expect(typeof adapter.resolveCustomer).toBe("function");
    });

    // -- createCheckout ------------------------------------------------------

    test("returns a session id and URL on success", async () => {
      const adapter = createAdapter();
      const params: CreateCheckoutParams = {
        schoolId: aSchoolId(),
        planId: aPlanId(),
        priceId: aPriceId(),
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      };

      const result: CheckoutResult = await adapter.createCheckout(params);

      expect(result).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.sessionId).not.toBe("");
      expect(typeof result.url).toBe("string");
      expect(result.url).not.toBe("");
    });

    test("rejects empty schoolId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const params: CreateCheckoutParams = {
        schoolId: "",
        planId: aPlanId(),
        priceId: aPriceId(),
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      };

      await expect(adapter.createCheckout(params)).rejects.toThrow(PaymentProviderError);
    });

    // -- createPortal --------------------------------------------------------

    test("returns a session id and URL on success", async () => {
      const adapter = createAdapter();
      const params: CreatePortalParams = {
        schoolId: aSchoolId(),
        returnUrl: "https://example.com/portal",
      };

      const result: PortalResult = await adapter.createPortal(params);

      expect(result).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.sessionId).not.toBe("");
      expect(typeof result.url).toBe("string");
      expect(result.url).not.toBe("");
    });

    test("rejects empty schoolId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const params: CreatePortalParams = {
        schoolId: "",
        returnUrl: "https://example.com/portal",
      };

      await expect(adapter.createPortal(params)).rejects.toThrow(PaymentProviderError);
    });

    // -- cancelSubscription ---------------------------------------------------

    test("resolves on success", async () => {
      const adapter = createAdapter();
      const params: CancelSubscriptionParams = {
        schoolId: aSchoolId(),
      };

      await expect(adapter.cancelSubscription(params)).resolves.toBeUndefined();
    });

    test("accepts immediately flag and reason", async () => {
      const adapter = createAdapter();
      const params: CancelSubscriptionParams = {
        schoolId: aSchoolId(),
        immediately: true,
        reason: "Customer request",
      };

      await expect(adapter.cancelSubscription(params)).resolves.toBeUndefined();
    });

    test("rejects empty schoolId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const params: CancelSubscriptionParams = {
        schoolId: "",
      };

      await expect(adapter.cancelSubscription(params)).rejects.toThrow(PaymentProviderError);
    });

    // -- cancelAiSubscription ------------------------------------------------

    test("resolves on success", async () => {
      const adapter = createAdapter();
      const params: CancelAiSubscriptionParams = {
        schoolId: aSchoolId(),
        studentId: aStudentId(),
      };

      await expect(adapter.cancelAiSubscription(params)).resolves.toBeUndefined();
    });

    test("accepts immediately flag and reason", async () => {
      const adapter = createAdapter();
      const params: CancelAiSubscriptionParams = {
        schoolId: aSchoolId(),
        studentId: aStudentId(),
        immediately: true,
        reason: "Student request",
      };

      await expect(adapter.cancelAiSubscription(params)).resolves.toBeUndefined();
    });

    test("rejects empty schoolId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const params: CancelAiSubscriptionParams = {
        schoolId: "",
        studentId: aStudentId(),
      };

      await expect(adapter.cancelAiSubscription(params)).rejects.toThrow(PaymentProviderError);
    });

    // -- normalizeWebhookEvent ------------------------------------------------

    test("returns a NormalizedWebhookEvent on success", async () => {
      const adapter = createAdapter();
      const params: NormalizeWebhookParams = {
        rawBody: JSON.stringify({ id: "evt_test", type: "invoice.paid" }),
        signature: "test_sig",
      };

      const result: NormalizedWebhookEvent = await adapter.normalizeWebhookEvent(params);

      expect(result).toBeDefined();
      expect(typeof result.provider).toBe("string");
      expect(result.provider).not.toBe("");
      expect(typeof result.providerEventId).toBe("string");
      expect(result.providerEventId).not.toBe("");
      expect(typeof result.eventType).toBe("string");
      expect(result.eventType).not.toBe("");
      expect(result.payload).toBeDefined();
      expect(typeof result.payload).toBe("object");
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    test("rejects empty signature with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const params: NormalizeWebhookParams = {
        rawBody: "{}",
        signature: "",
      };

      await expect(adapter.normalizeWebhookEvent(params)).rejects.toThrow(PaymentProviderError);
    });

    // -- resolveCustomer ------------------------------------------------------

    test("returns a provider customer id on success", async () => {
      const adapter = createAdapter();
      const params: ResolveCustomerParams = {
        schoolId: aSchoolId(),
        email: "school@example.com",
        name: "Test School",
      };

      const result: CustomerResult = await adapter.resolveCustomer(params);

      expect(result).toBeDefined();
      expect(typeof result.providerCustomerId).toBe("string");
      expect(result.providerCustomerId).not.toBe("");
    });

    test("rejects empty email with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const params: ResolveCustomerParams = {
        schoolId: aSchoolId(),
        email: "",
        name: "Test School",
      };

      await expect(adapter.resolveCustomer(params)).rejects.toThrow(PaymentProviderError);
    });

    // -- Error contract -------------------------------------------------------

    test("all errors are instances of PaymentProviderError", async () => {
      const adapter = createAdapter();

      const methods: { name: string; call: () => Promise<unknown> }[] = [
        {
          name: "createCheckout",
          call: () =>
            adapter.createCheckout({
              schoolId: "",
              planId: "",
              priceId: "",
              successUrl: "",
              cancelUrl: "",
            }),
        },
        {
          name: "createPortal",
          call: () => adapter.createPortal({ schoolId: "", returnUrl: "" }),
        },
        {
          name: "cancelSubscription",
          call: () => adapter.cancelSubscription({ schoolId: "" }),
        },
        {
          name: "cancelAiSubscription",
          call: () => adapter.cancelAiSubscription({ schoolId: "", studentId: "" }),
        },
        {
          name: "normalizeWebhookEvent",
          call: () => adapter.normalizeWebhookEvent({ rawBody: "", signature: "" }),
        },
        {
          name: "resolveCustomer",
          call: () => adapter.resolveCustomer({ schoolId: "", email: "", name: "" }),
        },
      ];

      let tested = 0;
      for (const { name, call } of methods) {
        try {
          await call();
        } catch (error) {
          tested++;
          expect(error, `${name} should throw PaymentProviderError`).toBeInstanceOf(
            PaymentProviderError,
          );
        }
      }

      // At least one method rejected empty input.
      expect(tested).toBeGreaterThan(0);
    });
  });
}

// ---------------------------------------------------------------------------
// Mock adapter — validates the contract suite itself is sound
// ---------------------------------------------------------------------------

class MockAdapter implements PaymentProviderPort {
  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    if (!params.schoolId || !params.planId || !params.priceId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "Required params missing");
    }
    return { sessionId: "cs_mock", url: `https://checkout.example.com/${params.schoolId}` };
  }

  async createPortal(params: CreatePortalParams): Promise<PortalResult> {
    if (!params.schoolId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "schoolId is required");
    }
    return { sessionId: "ps_mock", url: `https://portal.example.com/${params.schoolId}` };
  }

  async cancelSubscription(params: CancelSubscriptionParams): Promise<void> {
    if (!params.schoolId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "schoolId is required");
    }
  }

  async cancelAiSubscription(params: CancelAiSubscriptionParams): Promise<void> {
    if (!params.schoolId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "schoolId is required");
    }
  }

  async normalizeWebhookEvent(params: NormalizeWebhookParams): Promise<NormalizedWebhookEvent> {
    if (!params.signature) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "Signature required");
    }
    return {
      provider: "mock",
      providerEventId: "evt_mock",
      eventType: "invoice.paid",
      payload: JSON.parse(params.rawBody),
      createdAt: new Date(),
    };
  }

  async resolveCustomer(params: ResolveCustomerParams): Promise<CustomerResult> {
    if (!params.email) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "Email is required");
    }
    return { providerCustomerId: `cus_mock_${params.schoolId}` };
  }
}

contractTests("Mock", () => new MockAdapter());
