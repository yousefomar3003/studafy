// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { PaymentProviderError } from "../ports/payment-provider";

import type {
  CreateCustomerInput,
  CreateCustomerResult,
  CreateCheckoutSessionInput,
  CreateCheckoutSessionResult,
  CreateBillingPortalSessionInput,
  CreateBillingPortalSessionResult,
  SyncProductInput,
  SyncProductResult,
  SyncPriceInput,
  SyncPriceResult,
  ParsedWebhookEvent,
  LookupProductResult,
  LookupPriceResult,
  PauseSubscriptionInput,
  ResumeSubscriptionInput,
  PaymentProviderPort,
} from "../ports/payment-provider";

type AdapterFactory = () => PaymentProviderPort;

export function contractTests(name: string, createAdapter: AdapterFactory): void {
  describe(`${name} — PaymentProviderPort contract`, () => {
    test("exposes all port methods", () => {
      const adapter = createAdapter();

      expect(adapter).toBeDefined();
      expect(typeof adapter.createCustomer).toBe("function");
      expect(typeof adapter.createCheckoutSession).toBe("function");
      expect(typeof adapter.createBillingPortalSession).toBe("function");
      expect(typeof adapter.syncProduct).toBe("function");
      expect(typeof adapter.syncPrice).toBe("function");
      expect(typeof adapter.parseWebhook).toBe("function");
      expect(typeof adapter.lookupProductById).toBe("function");
      expect(typeof adapter.lookupPriceById).toBe("function");
      expect(typeof adapter.pauseSubscription).toBe("function");
      expect(typeof adapter.resumeSubscription).toBe("function");
    });

    test("createCustomer rejects empty name with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const input: CreateCustomerInput = { name: "", email: "", metadata: {} };
      await expect(adapter.createCustomer(input)).rejects.toThrow(PaymentProviderError);
    });

    test("createCheckoutSession rejects empty customerId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const input: CreateCheckoutSessionInput = {
        customerId: "",
        priceId: "price_mock",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
        metadata: {},
      };
      await expect(adapter.createCheckoutSession(input)).rejects.toThrow(PaymentProviderError);
    });

    test("createBillingPortalSession rejects empty customerId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const input: CreateBillingPortalSessionInput = {
        customerId: "",
        returnUrl: "https://example.com",
      };
      await expect(adapter.createBillingPortalSession(input)).rejects.toThrow(PaymentProviderError);
    });

    test("syncProduct rejects empty name with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const input: SyncProductInput = { localId: "plan_mock", name: "", active: true };
      await expect(adapter.syncProduct(input)).rejects.toThrow(PaymentProviderError);
    });

    test("syncPrice rejects empty productId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const input: SyncPriceInput = {
        localId: "price_mock",
        productId: "",
        amountMinor: 1000,
        currency: "USD",
        interval: "month",
        active: true,
      };
      await expect(adapter.syncPrice(input)).rejects.toThrow(PaymentProviderError);
    });

    test("parseWebhook rejects empty signature with PaymentProviderError", async () => {
      const adapter = createAdapter();
      const payload = Buffer.from(JSON.stringify({ type: "test", data: {} }));
      await expect(adapter.parseWebhook(payload, "")).rejects.toThrow(PaymentProviderError);
    });

    test("lookupProductById returns null for unknown id", async () => {
      const adapter = createAdapter();
      const result = await adapter.lookupProductById("prod_unknown");
      expect(result).toBeNull();
    });

    test("lookupPriceById returns null for unknown id", async () => {
      const adapter = createAdapter();
      const result = await adapter.lookupPriceById("price_unknown");
      expect(result).toBeNull();
    });

    test("pauseSubscription rejects empty providerSubscriptionId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      await expect(adapter.pauseSubscription({ providerSubscriptionId: "" })).rejects.toThrow(
        PaymentProviderError,
      );
    });

    test("resumeSubscription rejects empty providerSubscriptionId with PaymentProviderError", async () => {
      const adapter = createAdapter();
      await expect(adapter.resumeSubscription({ providerSubscriptionId: "" })).rejects.toThrow(
        PaymentProviderError,
      );
    });

    test("pauseSubscription and resumeSubscription resolve for a known subscription id", async () => {
      const adapter = createAdapter();
      await expect(
        adapter.pauseSubscription({ providerSubscriptionId: "sub_mock" }),
      ).resolves.toBeUndefined();
      await expect(
        adapter.resumeSubscription({ providerSubscriptionId: "sub_mock" }),
      ).resolves.toBeUndefined();
    });

    test("all errors are instances of PaymentProviderError", async () => {
      const adapter = createAdapter();

      const methods: { name: string; call: () => Promise<unknown> }[] = [
        {
          name: "createCustomer",
          call: () => adapter.createCustomer({ name: "", email: "", metadata: {} }),
        },
        {
          name: "createCheckoutSession",
          call: () =>
            adapter.createCheckoutSession({
              customerId: "",
              priceId: "",
              successUrl: "",
              cancelUrl: "",
              metadata: {},
            }),
        },
        {
          name: "createBillingPortalSession",
          call: () => adapter.createBillingPortalSession({ customerId: "", returnUrl: "" }),
        },
        {
          name: "syncProduct",
          call: () => adapter.syncProduct({ localId: "", name: "", active: true }),
        },
        {
          name: "syncPrice",
          call: () =>
            adapter.syncPrice({
              localId: "",
              productId: "",
              amountMinor: 0,
              currency: "",
              interval: "month",
              active: true,
            }),
        },
        {
          name: "parseWebhook",
          call: () => adapter.parseWebhook(Buffer.from("{}"), ""),
        },
        {
          name: "pauseSubscription",
          call: () => adapter.pauseSubscription({ providerSubscriptionId: "" }),
        },
        {
          name: "resumeSubscription",
          call: () => adapter.resumeSubscription({ providerSubscriptionId: "" }),
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

      expect(tested).toBeGreaterThan(0);
    });
  });
}

class MockAdapter implements PaymentProviderPort {
  async createCustomer(input: CreateCustomerInput): Promise<CreateCustomerResult> {
    if (!input.name) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "Name is required");
    }
    return { providerCustomerId: `cus_mock_${input.name}` };
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<CreateCheckoutSessionResult> {
    if (!input.customerId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "customerId is required");
    }
    return { url: `https://checkout.example.com/${input.customerId}`, sessionId: "cs_mock" };
  }

  async createBillingPortalSession(
    input: CreateBillingPortalSessionInput,
  ): Promise<CreateBillingPortalSessionResult> {
    if (!input.customerId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "customerId is required");
    }
    return { url: `https://portal.example.com/${input.customerId}` };
  }

  async syncProduct(input: SyncProductInput): Promise<SyncProductResult> {
    if (!input.name) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "Product name is required");
    }
    return { providerProductId: `prod_mock_${input.localId}` };
  }

  async syncPrice(input: SyncPriceInput): Promise<SyncPriceResult> {
    if (!input.productId) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "productId is required");
    }
    return { providerPriceId: `price_mock_${input.localId}` };
  }

  async parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent> {
    if (!signature) {
      throw new PaymentProviderError(400, "VALIDATION_FAILED" as never, "Signature is required");
    }
    // The envelope, not just the object: `id` is the idempotency key the processor claims on and
    // `created` is what every ordering decision is made against, so an adapter that dropped them
    // would satisfy the type and break deduplication (ST-132).
    const event = JSON.parse(payload.toString()) as {
      id?: string;
      type?: string;
      created?: number;
      livemode?: boolean;
      data?: Record<string, unknown>;
    };
    return {
      id: event.id ?? "evt_mock",
      type: event.type ?? "unknown",
      effectiveAt: new Date((event.created ?? 0) * 1000),
      livemode: event.livemode ?? false,
      data: event.data ?? {},
    };
  }

  async lookupProductById(_providerProductId: string): Promise<LookupProductResult | null> {
    return null;
  }

  async lookupPriceById(_providerPriceId: string): Promise<LookupPriceResult | null> {
    return null;
  }

  async pauseSubscription(input: PauseSubscriptionInput): Promise<void> {
    if (!input.providerSubscriptionId) {
      throw new PaymentProviderError(
        400,
        "VALIDATION_FAILED" as never,
        "providerSubscriptionId is required",
      );
    }
  }

  async resumeSubscription(input: ResumeSubscriptionInput): Promise<void> {
    if (!input.providerSubscriptionId) {
      throw new PaymentProviderError(
        400,
        "VALIDATION_FAILED" as never,
        "providerSubscriptionId is required",
      );
    }
  }
}

contractTests("Mock", () => new MockAdapter());
