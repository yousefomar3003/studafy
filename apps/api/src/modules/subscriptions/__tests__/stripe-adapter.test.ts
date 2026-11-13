import { describe, expect, test } from "bun:test"; // eslint-disable-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in
import Stripe from "stripe";

import { PaymentProviderError } from "../ports/payment-provider";
import { priceLookupKey, StripeAdapter } from "../stripe/adapter";

import { FakeStripeCatalog } from "./fake-stripe-catalog";

import type { SyncPriceInput, SyncProductInput } from "../ports/payment-provider";

test("StripeAdapter constructor throws on empty secret key", () => {
  expect(() => new StripeAdapter({ secretKey: "", webhookSecret: "" })).toThrow();
});

test("StripeAdapter rejects live key in dev mode check", () => {
  const key = "sk_live_fake_key_for_test";
  expect(() => new StripeAdapter({ secretKey: key, webhookSecret: "whsec_test" })).not.toThrow();
});

test("StripeAdapter webhook parse fails with invalid signature", async () => {
  const adapter = new StripeAdapter({
    secretKey: "sk_test_placeholder",
    webhookSecret: "whsec_test",
  });

  const payload = Buffer.from(JSON.stringify({ type: "test", data: { id: "evt_1" } }));
  await expect(adapter.parseWebhook(payload, "bad_signature")).rejects.toThrow();
});

// Regression: under Bun the SDK verifies with Web Crypto, which has no synchronous form, so the
// synchronous constructEvent() rejected every webhook -- valid ones included -- and the test above
// could not tell. A payload signed the way Stripe signs it must be accepted.
test("StripeAdapter accepts a correctly signed webhook", async () => {
  const secret = "whsec_test_secret";
  const adapter = new StripeAdapter({ secretKey: "sk_test_placeholder", webhookSecret: secret });
  const body = JSON.stringify({
    id: "evt_test_1",
    object: "event",
    type: "checkout.session.completed",
    created: 1_790_000_000,
    livemode: false,
    data: { object: { id: "cs_test_1", object: "checkout.session" } },
  });
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret });

  const event = await adapter.parseWebhook(Buffer.from(body), signature);

  expect(event.id).toBe("evt_test_1");
  expect(event.type).toBe("checkout.session.completed");
  expect(event.effectiveAt).toEqual(new Date(1_790_000_000 * 1000));
});

// ---------------------------------------------------------------------------------------------------
// Catalog sync. Every run of POST /api/admin/subscriptions/sync-prices used to create a fresh product
// and price for every row, duplicating the whole catalogue in Stripe and leaving the old prices live.
// These run the real adapter over an in-memory Stripe (fake-stripe-catalog.ts).
// ---------------------------------------------------------------------------------------------------

const PLAN_ID = "7d4c1f8e-0000-4000-8000-000000000001";
const PRICE_ID = "7d4c1f8e-0000-4000-8000-000000000002";

function catalogAdapter(catalog: FakeStripeCatalog): StripeAdapter {
  return new StripeAdapter({
    secretKey: "unused-a-client-is-given",
    webhookSecret: "whsec_test",
    client: catalog.client(),
  });
}

function productInput(overrides: Partial<SyncProductInput> = {}): SyncProductInput {
  return {
    localId: PLAN_ID,
    name: "Storage 100 GB",
    description: "Extra storage",
    active: true,
    ...overrides,
  };
}

function priceInput(productId: string, overrides: Partial<SyncPriceInput> = {}): SyncPriceInput {
  return {
    localId: PRICE_ID,
    productId,
    amountMinor: 1000,
    currency: "USD",
    interval: "month",
    active: true,
    ...overrides,
  };
}

describe("StripeAdapter catalog sync", () => {
  test("a second run with the stored ids creates and updates nothing", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);

    const product = await adapter.syncProduct(productInput());
    const price = await adapter.syncPrice(priceInput(product.providerProductId));
    expect(product.outcome).toBe("created");
    expect(price.outcome).toBe("created");
    expect(catalog.prices.get(price.providerPriceId)?.lookup_key).toBe(priceLookupKey(PRICE_ID));

    const writesAfterFirstRun = { ...catalog.writes };
    const again = await adapter.syncProduct(
      productInput({ providerProductId: product.providerProductId }),
    );
    const priceAgain = await adapter.syncPrice(
      priceInput(again.providerProductId, { providerPriceId: price.providerPriceId }),
    );

    expect(again).toEqual({ providerProductId: product.providerProductId, outcome: "unchanged" });
    expect(priceAgain).toEqual({
      providerPriceId: price.providerPriceId,
      outcome: "unchanged",
      archivedPriceIds: [],
    });
    expect(catalog.writes).toEqual(writesAfterFirstRun);
    expect(catalog.products.size).toBe(1);
    expect(catalog.prices.size).toBe(1);
  });

  test("a renamed plan updates its product in place", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = await adapter.syncProduct(productInput());

    const renamed = await adapter.syncProduct(
      productInput({
        name: "Storage 100GB",
        description: undefined,
        active: false,
        providerProductId: product.providerProductId,
      }),
    );

    expect(renamed).toEqual({ providerProductId: product.providerProductId, outcome: "updated" });
    expect(catalog.products.size).toBe(1);
    expect(catalog.products.get(product.providerProductId)).toMatchObject({
      name: "Storage 100GB",
      description: null,
      active: false,
    });
  });

  test("a changed amount creates one new price and archives the old one", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = await adapter.syncProduct(productInput());
    const first = await adapter.syncPrice(priceInput(product.providerProductId));

    const changed = await adapter.syncPrice(
      priceInput(product.providerProductId, {
        amountMinor: 1200,
        providerPriceId: first.providerPriceId,
      }),
    );

    expect(changed.outcome).toBe("created");
    expect(changed.providerPriceId).not.toBe(first.providerPriceId);
    expect(changed.archivedPriceIds).toEqual([first.providerPriceId]);
    expect(catalog.prices.size).toBe(2);
    expect(catalog.activePrices().map((price) => price.id)).toEqual([changed.providerPriceId]);
    expect(catalog.prices.get(changed.providerPriceId)).toMatchObject({
      unit_amount: 1200,
      lookup_key: priceLookupKey(PRICE_ID),
    });
    // The lookup key moved with it, so it always names the live price.
    expect(catalog.prices.get(first.providerPriceId)?.lookup_key).toBeNull();

    // And the run after that is quiet again.
    const writes = { ...catalog.writes };
    const settled = await adapter.syncPrice(
      priceInput(product.providerProductId, {
        amountMinor: 1200,
        providerPriceId: changed.providerPriceId,
      }),
    );
    expect(settled.outcome).toBe("unchanged");
    expect(catalog.writes).toEqual(writes);
  });

  test("changing an amount and back within a day makes a fresh price, not a replay", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = await adapter.syncProduct(productInput());
    const at10 = await adapter.syncPrice(priceInput(product.providerProductId));
    const at12 = await adapter.syncPrice(
      priceInput(product.providerProductId, {
        amountMinor: 1200,
        providerPriceId: at10.providerPriceId,
      }),
    );

    const back = await adapter.syncPrice(
      priceInput(product.providerProductId, { providerPriceId: at12.providerPriceId }),
    );

    expect(back.outcome).toBe("created");
    expect(back.providerPriceId).not.toBe(at10.providerPriceId);
    expect(catalog.activePrices().map((price) => price.id)).toEqual([back.providerPriceId]);
  });

  test("toggling a price inactive archives it without creating another", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = await adapter.syncProduct(productInput());
    const price = await adapter.syncPrice(priceInput(product.providerProductId));

    const off = await adapter.syncPrice(
      priceInput(product.providerProductId, {
        active: false,
        providerPriceId: price.providerPriceId,
      }),
    );

    expect(off).toEqual({
      providerPriceId: price.providerPriceId,
      outcome: "updated",
      archivedPriceIds: [],
    });
    expect(catalog.prices.size).toBe(1);
    expect(catalog.activePrices()).toEqual([]);
  });

  test("a stored product Stripe no longer has is recovered by its metadata", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const existing = catalog.seedProduct({
      name: "Storage 100 GB",
      description: "Extra storage",
      metadata: { local_plan_id: PLAN_ID },
    });

    const result = await adapter.syncProduct(productInput({ providerProductId: "prod_gone" }));

    expect(result).toEqual({ providerProductId: existing.id, outcome: "unchanged" });
    expect(catalog.writes.productCreates).toBe(0);
  });

  test("a stored product that cannot be found anywhere is recreated", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);

    const result = await adapter.syncProduct(productInput({ providerProductId: "prod_gone" }));

    expect(result.outcome).toBe("created");
    expect(catalog.products.get(result.providerProductId)?.metadata.local_plan_id).toBe(PLAN_ID);
  });

  test("with no stored ids, the product and price already in Stripe are reused", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = catalog.seedProduct({
      name: "Storage 100 GB",
      description: "Extra storage",
      metadata: { local_plan_id: PLAN_ID },
    });
    const price = catalog.seedPrice({
      product: product.id,
      unit_amount: 1000,
      currency: "usd",
      lookup_key: priceLookupKey(PRICE_ID),
      metadata: { local_price_id: PRICE_ID },
    });

    const productResult = await adapter.syncProduct(productInput({ providerProductId: null }));
    const priceResult = await adapter.syncPrice(priceInput(product.id, { providerPriceId: null }));

    expect(productResult).toEqual({ providerProductId: product.id, outcome: "unchanged" });
    expect(priceResult).toEqual({
      providerPriceId: price.id,
      outcome: "unchanged",
      archivedPriceIds: [],
    });
    expect(catalog.writes).toEqual({
      productCreates: 0,
      productUpdates: 0,
      priceCreates: 0,
      priceUpdates: 0,
    });
  });

  test("a price published before lookup keys is found by metadata and given its key", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = catalog.seedProduct({
      name: "Storage 100 GB",
      metadata: { local_plan_id: PLAN_ID },
    });
    const legacy = catalog.seedPrice({
      product: product.id,
      unit_amount: 1000,
      currency: "usd",
      metadata: { local_price_id: PRICE_ID },
    });

    const result = await adapter.syncPrice(priceInput(product.id));

    expect(result).toEqual({
      providerPriceId: legacy.id,
      outcome: "updated",
      archivedPriceIds: [],
    });
    expect(catalog.prices.get(legacy.id)?.lookup_key).toBe(priceLookupKey(PRICE_ID));
    expect(catalog.writes.priceCreates).toBe(0);
  });

  test("a stored price id that went missing falls back to the lookup key", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    const product = await adapter.syncProduct(productInput());
    const price = await adapter.syncPrice(priceInput(product.providerProductId));

    const result = await adapter.syncPrice(
      priceInput(product.providerProductId, { providerPriceId: "price_gone" }),
    );

    expect(result).toEqual({
      providerPriceId: price.providerPriceId,
      outcome: "unchanged",
      archivedPriceIds: [],
    });
    expect(catalog.prices.size).toBe(1);
  });

  test("a create retried before its id was stored returns the first object, not a duplicate", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);
    // Search has not indexed the first create yet, so only the idempotency key can catch it.
    catalog.searchIndexed = false;

    const first = await adapter.syncProduct(productInput());
    const retried = await adapter.syncProduct(productInput());

    expect(retried.providerProductId).toBe(first.providerProductId);
    expect(catalog.products.size).toBe(1);
    expect(catalog.idempotencyKeys[0]).toStartWith(`studafy-sync-product-${PLAN_ID}-`);
    expect(catalog.idempotencyKeys[1]).toBe(catalog.idempotencyKeys[0]!);
  });

  test("Stripe failures surface as a 502 PaymentProviderError", async () => {
    const catalog = new FakeStripeCatalog();
    const adapter = catalogAdapter(catalog);

    // The product does not exist, so Stripe refuses the price.
    const failure = adapter.syncPrice(priceInput("prod_nowhere"));

    await expect(failure).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(failure).rejects.toMatchObject({ status: 502 });
  });
});
