/**
 * The paid storage add-on (db/migrations/000205), against a real database: what the offer lists,
 * what the checkout sends the provider, how the webhook pipeline creates and moves the add-on row
 * without touching the school's own subscription, how the upload cap follows it, and changing tier
 * and canceling.
 */

import { ERROR_CODES, INCLUDED_STORAGE_BYTES, STORAGE_ADDON_TIERS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { getStorageUsage } from "../../storage/quota-service";
import { createStorageCheckoutSession } from "../services/checkout-service";
import {
  changeStorageTier,
  getStorageOffer,
  setStorageAddonCancellation,
} from "../services/storage-addon-service";
import { handleBillingWebhook } from "../webhooks/webhook-processor";

import {
  createBillingDatabase,
  createBillingFixture,
  createProviderStub,
  encodeEvent,
  readSubscriptionStatus,
  resetBillingEvents,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture, StubEventInput } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type {
  ChangeSubscriptionPriceInput,
  CreateCheckoutSessionInput,
  PaymentProviderPort,
} from "../ports/payment-provider";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const CONTEXT = { path: "/api/subscriptions/webhook/stripe", requestId: null };
const GIB = 1024 ** 3;

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
  await syncStoragePrices(database);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

afterEach(async () => {
  if (database) await resetBillingEvents(database);
});

interface Prices {
  gb100Monthly: string;
  gb100Yearly: string;
  tb1Monthly: string;
}

let prices: Prices;

/**
 * The migration seeds the USD prices; give them Stripe ids as POST /api/admin/subscriptions/
 * sync-prices would, so a Stripe checkout can charge them.
 */
async function syncStoragePrices(db: TestDatabase): Promise<void> {
  const rows = await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return tx<{ id: string; code: string; billing_interval: string }[]>`
      UPDATE app.plan_prices pp
      SET stripe_price_id = 'price_' || p.code || '_' || pp.billing_interval::text
      FROM app.plans p
      WHERE p.id = pp.plan_id AND p.code IN ('storage_100gb', 'storage_1tb')
      RETURNING pp.id, p.code, pp.billing_interval::text AS billing_interval
    `;
  });
  const find = (code: string, interval: string) =>
    rows.find((row) => row.code === code && row.billing_interval === interval)!.id;
  prices = {
    gb100Monthly: find("storage_100gb", "monthly"),
    gb100Yearly: find("storage_100gb", "yearly"),
    tb1Monthly: find("storage_1tb", "monthly"),
  };
}

async function asAdmin<T>(f: BillingFixture, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

function capOf(f: BillingFixture): Promise<number> {
  return asAdmin(f, async (tx) => (await getStorageUsage(tx)).capBytes);
}

async function storageRow(f: BillingFixture) {
  const [row] = await asAdmin(
    f,
    (tx) => tx<
      {
        status: string;
        cap_bytes: string;
        plan_price_id: string | null;
        stripe_subscription_id: string | null;
        cancel_at_period_end: boolean;
      }[]
    >`
      SELECT status::text AS status, cap_bytes::text AS cap_bytes, plan_price_id,
             stripe_subscription_id, cancel_at_period_end
      FROM app.storage_subscriptions WHERE school_id = ${f.schoolId}::uuid
    `,
  );
  return row;
}

interface FakeStripe {
  port: PaymentProviderPort;
  checkouts: CreateCheckoutSessionInput[];
  changes: ChangeSubscriptionPriceInput[];
  cancellations: string[];
  /** What the next price change answers: applied, or held for a payment. */
  applyChanges: boolean;
}

function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    checkouts: [],
    changes: [],
    cancellations: [],
    applyChanges: true,
    port: undefined as unknown as PaymentProviderPort,
  };
  fake.port = {
    createCheckoutSession: (input: CreateCheckoutSessionInput) => {
      fake.checkouts.push(input);
      return Promise.resolve({ url: "https://checkout.example/storage", sessionId: "cs_storage" });
    },
    changeSubscriptionPrice: (input: ChangeSubscriptionPriceInput) => {
      fake.changes.push(input);
      return Promise.resolve({ applied: fake.applyChanges });
    },
    scheduleCancellation: (input: { providerSubscriptionId: string }) => {
      fake.cancellations.push(`cancel:${input.providerSubscriptionId}`);
      return Promise.resolve();
    },
    reverseCancellation: (input: { providerSubscriptionId: string }) => {
      fake.cancellations.push(`reverse:${input.providerSubscriptionId}`);
      return Promise.resolve();
    },
  } as unknown as PaymentProviderPort;
  return fake;
}

function registry(stripe: FakeStripe): PaymentProviderRegistry {
  return { stripe: stripe.port, tap: null };
}

function deliver(f: BillingFixture, event: StubEventInput) {
  return handleBillingWebhook(
    {
      database: f.db.sql,
      providerName: "stripe",
      provider: createProviderStub(),
      logger: silentLogger,
    },
    encodeEvent(event),
    "t=1,v1=stub",
    CONTEXT,
  );
}

/** The `checkout.session.completed` our storage checkout produces, as Stripe sends it back. */
function storagePurchased(
  f: BillingFixture,
  id: string,
  created: number,
  subscription: string,
  priceId: string,
): StubEventInput {
  return {
    id,
    type: "checkout.session.completed",
    created,
    data: {
      id: `cs_${id}`,
      customer: f.stripeCustomerId,
      subscription,
      metadata: { school_id: f.schoolId, addon: "storage", price_id: priceId },
    },
  };
}

function storageDeleted(
  f: BillingFixture,
  id: string,
  created: number,
  subscription: string,
): StubEventInput {
  return {
    id,
    type: "customer.subscription.deleted",
    created,
    data: {
      id: subscription,
      customer: f.stripeCustomerId,
      status: "canceled",
      metadata: { school_id: f.schoolId, addon: "storage" },
    },
  };
}

function checkout(f: BillingFixture, stripe: FakeStripe, priceId: string) {
  return createStorageCheckoutSession(f.db.sql, registry(stripe), {
    schoolId: f.schoolId,
    priceId,
    successUrl: "https://app.example/admin/storage?checkout=success",
    cancelUrl: "https://app.example/admin/storage?checkout=cancelled",
    tenantContext: { schoolId: f.schoolId },
  });
}

async function expectCode(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CodedHttpException);
  const coded = error as { status: number; code: string };
  expect(coded.status).toBe(status);
  expect(coded.code).toBe(code);
}

describe("the storage offer", () => {
  integrationTest("lists both tiers in USD with the included 10 GB as the cap", async () => {
    const f = await createBillingFixture(database!);
    const offer = await getStorageOffer(f.db.sql, registry(fakeStripe()), {
      schoolId: f.schoolId,
    });

    expect(offer.currency).toBe("USD");
    expect(offer.current).toBeNull();
    expect(offer.availableOnline).toBe(true);
    expect(offer.usage).toEqual({
      usedBytes: 0,
      capBytes: INCLUDED_STORAGE_BYTES,
      includedBytes: INCLUDED_STORAGE_BYTES,
    });
    expect(
      offer.tiers.map((tier) => ({
        planCode: tier.planCode,
        capBytes: tier.capBytes,
        prices: tier.prices.map((price) => [price.interval, price.amountMinor, price.currency]),
      })),
    ).toEqual([
      {
        planCode: "storage_100gb",
        capBytes: 100 * GIB,
        prices: [
          ["monthly", 1000, "USD"],
          ["yearly", 10000, "USD"],
        ],
      },
      {
        planCode: "storage_1tb",
        capBytes: 1024 * GIB,
        prices: [
          ["monthly", 4900, "USD"],
          ["yearly", 49000, "USD"],
        ],
      },
    ]);
  });

  integrationTest("is not available online for a school billed through Tap", async () => {
    const f = await createBillingFixture(database!);
    const tap = fakeStripe();
    const offer = await getStorageOffer(
      f.db.sql,
      { stripe: null, tap: tap.port, tapCountries: new Set(["US"]) },
      { schoolId: f.schoolId },
    );
    expect(offer.availableOnline).toBe(false);

    await expectCode(
      createStorageCheckoutSession(
        f.db.sql,
        { stripe: null, tap: tap.port, tapCountries: new Set(["US"]) },
        {
          schoolId: f.schoolId,
          priceId: prices.gb100Monthly,
          successUrl: "https://app.example/s",
          cancelUrl: "https://app.example/c",
          tenantContext: { schoolId: f.schoolId },
        },
      ),
      409,
      ERROR_CODES.STORAGE_ADDON_UNAVAILABLE,
    );
    expect(tap.checkouts).toHaveLength(0);
  });
});

describe("buying storage", () => {
  integrationTest(
    "the checkout charges the Stripe price and marks the purchase as storage",
    async () => {
      const f = await createBillingFixture(database!);
      const stripe = fakeStripe();

      const result = await checkout(f, stripe, prices.gb100Monthly);

      expect(result.url).toBe("https://checkout.example/storage");
      expect(stripe.checkouts).toHaveLength(1);
      expect(stripe.checkouts[0]).toMatchObject({
        customerId: f.stripeCustomerId,
        priceId: "price_storage_100gb_monthly",
        metadata: {
          school_id: f.schoolId,
          addon: "storage",
          price_id: prices.gb100Monthly,
          billing_interval: "monthly",
        },
      });
    },
  );

  integrationTest("refuses a price that is not a storage price", async () => {
    const f = await createBillingFixture(database!);
    const [other] = await asAdmin(
      f,
      (tx) => tx<{ id: string }[]>`
        INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor, stripe_price_id)
        SELECT s.plan_id, c.id, 'monthly', 100, ${`price_plan_${f.schoolId.slice(0, 8)}`}
        FROM app.subscriptions s, app.currencies c
        WHERE s.school_id = ${f.schoolId}::uuid AND c.code = 'USD'
        RETURNING id
      `,
    );

    await expectCode(
      checkout(f, fakeStripe(), other!.id),
      400,
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
    );
  });

  integrationTest(
    "the completed checkout creates the add-on, raises the cap, and leaves the school plan alone",
    async () => {
      const f = await createBillingFixture(database!);
      expect(await capOf(f)).toBe(INCLUDED_STORAGE_BYTES);

      const outcome = await deliver(
        f,
        storagePurchased(f, "evt_st_buy", 1_700_000_100, "sub_storage_a", prices.gb100Monthly),
      );

      expect(outcome).toEqual({ received: true, outcome: "processed" });
      expect(await storageRow(f)).toMatchObject({
        status: "active",
        cap_bytes: String(STORAGE_ADDON_TIERS.storage_100gb.capBytes),
        plan_price_id: prices.gb100Monthly,
        stripe_subscription_id: "sub_storage_a",
      });
      expect(await capOf(f)).toBe(100 * GIB);
      // Without the storage attribution this event would have activated the school's own plan.
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");

      // A second purchase while one is live is refused before any provider call.
      const stripe = fakeStripe();
      await expectCode(
        checkout(f, stripe, prices.tb1Monthly),
        409,
        ERROR_CODES.STORAGE_ADDON_ALREADY_ACTIVE,
      );
      expect(stripe.checkouts).toHaveLength(0);
    },
  );

  integrationTest(
    "ending the add-on drops the cap back to the included storage, and buying again restarts it",
    async () => {
      const f = await createBillingFixture(database!);
      await deliver(
        f,
        storagePurchased(f, "evt_st_b1", 1_700_000_100, "sub_storage_b", prices.gb100Monthly),
      );
      await deliver(f, storageDeleted(f, "evt_st_d1", 1_700_000_200, "sub_storage_b"));

      expect((await storageRow(f))?.status).toBe("canceled");
      expect(await capOf(f)).toBe(INCLUDED_STORAGE_BYTES);
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");

      await deliver(
        f,
        storagePurchased(f, "evt_st_b2", 1_700_000_300, "sub_storage_c", prices.tb1Monthly),
      );

      expect(await storageRow(f)).toMatchObject({
        status: "active",
        plan_price_id: prices.tb1Monthly,
        stripe_subscription_id: "sub_storage_c",
      });
      expect(await capOf(f)).toBe(1024 * GIB);
    },
  );

  integrationTest("a storage event for a school that never bought one is parked", async () => {
    const f = await createBillingFixture(database!);
    const outcome = await deliver(
      f,
      storageDeleted(f, "evt_st_orphan", 1_700_000_100, "sub_storage_unknown"),
    );
    expect(outcome).toEqual({ received: true, outcome: "parked" });
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
  });
});

describe("changing and canceling", () => {
  async function bought(f: BillingFixture, subscription: string): Promise<void> {
    await deliver(
      f,
      storagePurchased(f, `evt_${subscription}`, 1_700_000_100, subscription, prices.gb100Monthly),
    );
  }

  integrationTest("moving up charges now and raises the cap once paid", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_up");
    const stripe = fakeStripe();

    const current = await changeStorageTier(f.db.sql, registry(stripe), {
      schoolId: f.schoolId,
      priceId: prices.tb1Monthly,
      tenantContext: { schoolId: f.schoolId },
    });

    expect(stripe.changes).toEqual([
      {
        providerSubscriptionId: "sub_storage_up",
        priceId: "price_storage_1tb_monthly",
        chargeNow: true,
        metadata: { price_id: prices.tb1Monthly, billing_interval: "monthly" },
      },
    ]);
    expect(current).toMatchObject({ planCode: "storage_1tb", capBytes: 1024 * GIB });
    expect(await capOf(f)).toBe(1024 * GIB);
  });

  integrationTest("a declined payment changes nothing", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_declined");
    const stripe = fakeStripe();
    stripe.applyChanges = false;

    await expectCode(
      changeStorageTier(f.db.sql, registry(stripe), {
        schoolId: f.schoolId,
        priceId: prices.tb1Monthly,
        tenantContext: { schoolId: f.schoolId },
      }),
      402,
      ERROR_CODES.STORAGE_ADDON_PAYMENT_FAILED,
    );
    expect(await storageRow(f)).toMatchObject({ plan_price_id: prices.gb100Monthly });
    expect(await capOf(f)).toBe(100 * GIB);
  });

  integrationTest("moving to yearly on the same tier is charged now", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_yearly");
    const stripe = fakeStripe();

    await changeStorageTier(f.db.sql, registry(stripe), {
      schoolId: f.schoolId,
      priceId: prices.gb100Yearly,
      tenantContext: { schoolId: f.schoolId },
    });

    expect(stripe.changes[0]).toMatchObject({ chargeNow: true });
    expect(await capOf(f)).toBe(100 * GIB);
  });

  integrationTest("there is nothing to change or cancel without a live add-on", async () => {
    const f = await createBillingFixture(database!);
    const stripe = fakeStripe();

    await expectCode(
      changeStorageTier(f.db.sql, registry(stripe), {
        schoolId: f.schoolId,
        priceId: prices.tb1Monthly,
        tenantContext: { schoolId: f.schoolId },
      }),
      409,
      ERROR_CODES.STORAGE_ADDON_NOT_ACTIVE,
    );
    await expectCode(
      setStorageAddonCancellation(f.db.sql, registry(stripe), {
        schoolId: f.schoolId,
        cancel: true,
        tenantContext: { schoolId: f.schoolId },
      }),
      409,
      ERROR_CODES.STORAGE_ADDON_NOT_ACTIVE,
    );
  });

  integrationTest(
    "canceling keeps the storage until the period ends, and can be undone",
    async () => {
      const f = await createBillingFixture(database!);
      await bought(f, "sub_storage_cancel");
      const stripe = fakeStripe();
      const providers = registry(stripe);
      const params = { schoolId: f.schoolId, tenantContext: { schoolId: f.schoolId } };

      await setStorageAddonCancellation(f.db.sql, providers, { ...params, cancel: true });
      expect(await storageRow(f)).toMatchObject({ status: "active", cancel_at_period_end: true });
      expect(await capOf(f)).toBe(100 * GIB);

      await setStorageAddonCancellation(f.db.sql, providers, { ...params, cancel: false });
      expect((await storageRow(f))?.cancel_at_period_end).toBe(false);

      expect(stripe.cancellations).toEqual([
        "cancel:sub_storage_cancel",
        "reverse:sub_storage_cancel",
      ]);
    },
  );
});
