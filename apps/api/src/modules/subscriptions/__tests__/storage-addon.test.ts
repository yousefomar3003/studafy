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
  createStoragePaymentMethodSession,
  getStorageBilling,
  getStorageOffer,
  previewStorageTierChange,
  setStorageAddonCancellation,
  undoScheduledStorageChange,
} from "../services/storage-addon-service";
import {
  getPlatformStorageSubscription,
  refundPlatformStorageInvoice,
} from "../services/storage-platform-service";
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
  PreviewSubscriptionPriceChangeInput,
  RefundInput,
  ScheduleSubscriptionPriceChangeInput,
  SubscriptionBillingSummary,
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
  previews: PreviewSubscriptionPriceChangeInput[];
  cancellations: string[];
  /** What the next price change answers: applied, or held for a payment. */
  applyChanges: boolean;
  /** What every preview bills, in minor units. */
  previewAmount: number;
  /** Storage subscriptions Stripe holds for the customer that Studafy may not know of. */
  liveSubscriptionIds: string[];
  /** Storage checkouts still open at Stripe. */
  openCheckoutSessionIds: string[];
  /** Open checkouts that turn out to have been paid when they are expired. */
  paidWhileExpiring: Set<string>;
  expired: string[];
  /** What the invoice an immediate change creates takes from the card; null: the preview amount. */
  chargedAmount: number | null;
  schedules: ScheduleSubscriptionPriceChangeInput[];
  released: string[];
  /** Invoice items waiting for the customer's next invoice. */
  pendingItems: { count: number; netMinor: number };
  refunds: RefundInput[];
  refundFails: boolean;
  billing: SubscriptionBillingSummary;
  portalSessions: { customerId: string; returnUrl: string }[];
}

/** When a scheduled change takes effect in the fake: the end of the current period. */
const SCHEDULED_AT = new Date("2030-01-01T00:00:00.000Z");

function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    checkouts: [],
    changes: [],
    previews: [],
    cancellations: [],
    applyChanges: true,
    previewAmount: 3_900,
    liveSubscriptionIds: [],
    openCheckoutSessionIds: [],
    paidWhileExpiring: new Set(),
    expired: [],
    chargedAmount: null,
    schedules: [],
    released: [],
    pendingItems: { count: 0, netMinor: 0 },
    refunds: [],
    refundFails: false,
    billing: {
      paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
      nextBill: { amountMinor: 1_000, currency: "USD", at: SCHEDULED_AT },
      invoices: [
        {
          id: "in_storage_1",
          number: "S-0001",
          status: "paid",
          created: new Date("2026-11-14T10:46:00.000Z"),
          amountDueMinor: 3_879,
          amountPaidMinor: 3_879,
          amountRefundedMinor: 0,
          currency: "USD",
          billingReason: "subscription_update",
          hostedInvoiceUrl: "https://invoice.example/in_storage_1",
          invoicePdf: null,
        },
      ],
    },
    portalSessions: [],
    port: undefined as unknown as PaymentProviderPort,
  };
  fake.port = {
    createCheckoutSession: (input: CreateCheckoutSessionInput) => {
      fake.checkouts.push(input);
      return Promise.resolve({ url: "https://checkout.example/storage", sessionId: "cs_storage" });
    },
    findAddonPurchasesInFlight: () =>
      Promise.resolve({
        liveSubscriptionIds: [...fake.liveSubscriptionIds],
        openCheckoutSessionIds: [...fake.openCheckoutSessionIds],
      }),
    expireCheckoutSession: (sessionId: string) => {
      fake.expired.push(sessionId);
      return Promise.resolve(fake.paidWhileExpiring.has(sessionId) ? "completed" : "expired");
    },
    previewSubscriptionPriceChange: (input: PreviewSubscriptionPriceChangeInput) => {
      fake.previews.push(input);
      return Promise.resolve({ amountDueMinor: fake.previewAmount, currency: "USD" });
    },
    changeSubscriptionPrice: async (input: ChangeSubscriptionPriceInput) => {
      fake.changes.push(input);
      // Long enough for a concurrent request to reach the row lock while this one holds it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        applied: fake.applyChanges,
        invoice: fake.applyChanges
          ? {
              id: `in_${input.providerSubscriptionId}_${fake.changes.length}`,
              amountPaidMinor: fake.chargedAmount ?? fake.previewAmount,
              currency: "USD",
            }
          : null,
      };
    },
    scheduleSubscriptionPriceChange: (input: ScheduleSubscriptionPriceChangeInput) => {
      fake.schedules.push(input);
      return Promise.resolve({
        scheduleId: `sub_sched_${fake.schedules.length}`,
        effectiveAt: SCHEDULED_AT,
      });
    },
    releaseSubscriptionSchedule: (scheduleId: string) => {
      fake.released.push(scheduleId);
      return Promise.resolve();
    },
    countPendingInvoiceItems: () => Promise.resolve({ ...fake.pendingItems }),
    describeSubscriptionBilling: () => Promise.resolve(fake.billing),
    createPaymentMethodPortalSession: (input: { customerId: string; returnUrl: string }) => {
      fake.portalSessions.push(input);
      return Promise.resolve({ url: "https://billing.example/portal" });
    },
    refund: (input: RefundInput) => {
      fake.refunds.push(input);
      if (fake.refundFails) return Promise.reject(new Error("card network unavailable"));
      return Promise.resolve({
        providerRefundId: `re_${fake.refunds.length}`,
        status: "succeeded",
      });
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

/** A `customer.subscription.updated` for a storage subscription now on `stripePriceId`. */
function storageUpdated(
  f: BillingFixture,
  id: string,
  created: number,
  subscription: string,
  stripePriceId: string,
): StubEventInput {
  return {
    id,
    type: "customer.subscription.updated",
    created,
    data: {
      object: "subscription",
      id: subscription,
      customer: f.stripeCustomerId,
      status: "active",
      metadata: { school_id: f.schoolId, addon: "storage" },
      items: { data: [{ id: `si_${subscription}`, price: { id: stripePriceId } }] },
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

describe("never paying twice for storage", () => {
  integrationTest(
    "a checkout is refused while Stripe already holds a storage subscription Studafy has not heard of",
    async () => {
      const f = await createBillingFixture(database!);
      const stripe = fakeStripe();
      // The first checkout was paid; its webhook is still on the way, so there is no row yet.
      stripe.liveSubscriptionIds = ["sub_paid_a_moment_ago"];

      await expectCode(
        checkout(f, stripe, prices.tb1Monthly),
        409,
        ERROR_CODES.STORAGE_ADDON_PURCHASE_PENDING,
      );
      expect(stripe.checkouts).toHaveLength(0);
      expect(await storageRow(f)).toBeUndefined();
    },
  );

  integrationTest("earlier open checkouts are closed before a new one is made", async () => {
    const f = await createBillingFixture(database!);
    const stripe = fakeStripe();
    stripe.openCheckoutSessionIds = ["cs_first_tab", "cs_second_tab"];

    await checkout(f, stripe, prices.tb1Monthly);

    expect(stripe.expired).toEqual(["cs_first_tab", "cs_second_tab"]);
    expect(stripe.checkouts).toHaveLength(1);
  });

  integrationTest(
    "an open checkout paid while it was being closed refuses the new one",
    async () => {
      const f = await createBillingFixture(database!);
      const stripe = fakeStripe();
      stripe.openCheckoutSessionIds = ["cs_paying_now"];
      stripe.paidWhileExpiring.add("cs_paying_now");

      await expectCode(
        checkout(f, stripe, prices.gb100Monthly),
        409,
        ERROR_CODES.STORAGE_ADDON_PURCHASE_PENDING,
      );
      expect(stripe.checkouts).toHaveLength(0);
    },
  );

  integrationTest(
    "a double click makes checkouts one after the other, never side by side",
    async () => {
      const f = await createBillingFixture(database!);
      const stripe = fakeStripe();
      // Each new checkout is open at Stripe for the next request to find.
      const create = stripe.port.createCheckoutSession.bind(stripe.port);
      stripe.port.createCheckoutSession = async (input) => {
        const result = await create(input);
        stripe.openCheckoutSessionIds.push(`cs_${stripe.checkouts.length}`);
        return result;
      };

      await Promise.all([
        checkout(f, stripe, prices.gb100Monthly),
        checkout(f, stripe, prices.gb100Monthly),
      ]);

      expect(stripe.checkouts).toHaveLength(2);
      // The second request ran after the first and closed its checkout: only one can be paid.
      expect(stripe.expired).toEqual(["cs_1"]);
    },
  );
});

describe("changing and canceling", () => {
  async function bought(f: BillingFixture, subscription: string): Promise<void> {
    await deliver(
      f,
      storagePurchased(f, `evt_${subscription}`, 1_700_000_100, subscription, prices.gb100Monthly),
    );
  }

  async function bought1tb(f: BillingFixture, subscription: string): Promise<void> {
    await deliver(
      f,
      storagePurchased(f, `evt_${subscription}`, 1_700_000_100, subscription, prices.tb1Monthly),
    );
  }

  function preview(f: BillingFixture, stripe: FakeStripe, priceId: string) {
    return previewStorageTierChange(f.db.sql, registry(stripe), {
      schoolId: f.schoolId,
      priceId,
      tenantContext: { schoolId: f.schoolId },
    });
  }

  function change(
    f: BillingFixture,
    stripe: FakeStripe,
    priceId: string,
    confirmed: { prorationDate: Date; expectedAmountMinor: number; requestKey?: string },
  ) {
    return changeStorageTier(f.db.sql, registry(stripe), {
      schoolId: f.schoolId,
      priceId,
      prorationDate: confirmed.prorationDate,
      expectedAmountMinor: confirmed.expectedAmountMinor,
      requestKey: confirmed.requestKey ?? "6f1d1c2e-1111-4a4a-8b8b-000000000001",
      tenantContext: { schoolId: f.schoolId },
    });
  }

  integrationTest("the preview shows what moving up costs now, and charges nothing", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_preview");
    const stripe = fakeStripe();
    stripe.previewAmount = 3_871;

    const shown = await preview(f, stripe, prices.tb1Monthly);

    expect(shown).toMatchObject({
      amountDueNowMinor: 3_871,
      nextBillMinor: 4_900,
      currency: "USD",
      chargeNow: true,
      capBytes: 1024 * GIB,
    });
    expect(stripe.previews).toEqual([
      {
        providerSubscriptionId: "sub_storage_preview",
        priceId: "price_storage_1tb_monthly",
        chargeNow: true,
        prorationDate: shown.prorationDate.getTime() / 1000,
      },
    ]);
    expect(stripe.changes).toHaveLength(0);
    expect(await capOf(f)).toBe(100 * GIB);
  });

  integrationTest("moving up charges exactly the confirmed amount and raises the cap", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_up");
    const stripe = fakeStripe();
    const shown = await preview(f, stripe, prices.tb1Monthly);

    const current = await change(f, stripe, prices.tb1Monthly, {
      prorationDate: shown.prorationDate,
      expectedAmountMinor: shown.amountDueNowMinor,
      requestKey: "6f1d1c2e-1111-4a4a-8b8b-0000000000aa",
    });

    expect(stripe.changes).toHaveLength(1);
    expect(stripe.changes[0]).toMatchObject({
      providerSubscriptionId: "sub_storage_up",
      priceId: "price_storage_1tb_monthly",
      chargeNow: true,
      prorationDate: shown.prorationDate.getTime() / 1000,
      metadata: { price_id: prices.tb1Monthly, billing_interval: "monthly" },
    });
    expect(stripe.changes[0]!.idempotencyKey).toEndWith(":6f1d1c2e-1111-4a4a-8b8b-0000000000aa");
    expect(current).toMatchObject({ planCode: "storage_1tb", capBytes: 1024 * GIB });
    expect(await capOf(f)).toBe(1024 * GIB);
  });

  integrationTest("a price that moved since the preview charges nothing", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_moved");
    const stripe = fakeStripe();
    const shown = await preview(f, stripe, prices.tb1Monthly);
    stripe.previewAmount = shown.amountDueNowMinor + 1;

    await expectCode(
      change(f, stripe, prices.tb1Monthly, {
        prorationDate: shown.prorationDate,
        expectedAmountMinor: shown.amountDueNowMinor,
      }),
      409,
      ERROR_CODES.STORAGE_ADDON_PRICE_CHANGED,
    );
    expect(stripe.changes).toHaveLength(0);
    expect(await capOf(f)).toBe(100 * GIB);
  });

  integrationTest(
    "a preview older than half an hour is refused before anything is asked",
    async () => {
      const f = await createBillingFixture(database!);
      await bought(f, "sub_storage_stale");
      const stripe = fakeStripe();

      await expectCode(
        change(f, stripe, prices.tb1Monthly, {
          prorationDate: new Date(Date.now() - 31 * 60 * 1000),
          expectedAmountMinor: stripe.previewAmount,
        }),
        409,
        ERROR_CODES.STORAGE_ADDON_PRICE_CHANGED,
      );
      expect(stripe.previews).toHaveLength(0);
      expect(stripe.changes).toHaveLength(0);
    },
  );

  integrationTest("a double click on confirm charges once", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_double");
    const stripe = fakeStripe();
    const shown = await preview(f, stripe, prices.tb1Monthly);
    const confirmed = {
      prorationDate: shown.prorationDate,
      expectedAmountMinor: shown.amountDueNowMinor,
    };

    const results = await Promise.allSettled([
      change(f, stripe, prices.tb1Monthly, confirmed),
      change(f, stripe, prices.tb1Monthly, confirmed),
    ]);

    expect(stripe.changes).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: ERROR_CODES.STORAGE_ADDON_ALREADY_ACTIVE,
    });
  });

  integrationTest("a declined payment changes nothing", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_declined");
    const stripe = fakeStripe();
    stripe.applyChanges = false;
    const shown = await preview(f, stripe, prices.tb1Monthly);

    await expectCode(
      change(f, stripe, prices.tb1Monthly, {
        prorationDate: shown.prorationDate,
        expectedAmountMinor: shown.amountDueNowMinor,
      }),
      402,
      ERROR_CODES.STORAGE_ADDON_PAYMENT_FAILED,
    );
    expect(await storageRow(f)).toMatchObject({ plan_price_id: prices.gb100Monthly });
    expect(await capOf(f)).toBe(100 * GIB);
  });

  integrationTest(
    "anything charged beyond the confirmed amount is refunded at once and recorded",
    async () => {
      const f = await createBillingFixture(database!);
      await bought(f, "sub_storage_over");
      const stripe = fakeStripe();
      stripe.previewAmount = 0;
      const shown = await preview(f, stripe, prices.tb1Monthly);
      expect(shown.amountDueNowMinor).toBe(0);
      // Stripe charges the card what the preview called free (the 2026-11-14 report).
      stripe.chargedAmount = 3_862;

      await change(f, stripe, prices.tb1Monthly, {
        prorationDate: shown.prorationDate,
        expectedAmountMinor: 0,
        requestKey: "6f1d1c2e-1111-4a4a-8b8b-0000000000bb",
      });

      expect(stripe.refunds).toHaveLength(1);
      expect(stripe.refunds[0]).toMatchObject({
        invoiceId: "in_sub_storage_over_1",
        amountMinor: 3_862,
        currency: "USD",
        idempotencyKey:
          "storage-overcharge:in_sub_storage_over_1:6f1d1c2e-1111-4a4a-8b8b-0000000000bb",
      });
      const [incident] = await asAdmin(
        f,
        (tx) => tx<{ status: string; refund_minor: string; stripe_refund_id: string | null }[]>`
          SELECT status, refund_minor::text AS refund_minor, stripe_refund_id
          FROM app.storage_billing_incidents WHERE school_id = ${f.schoolId}::uuid
        `,
      );
      expect(incident).toEqual({
        status: "refunded",
        refund_minor: "3862",
        stripe_refund_id: "re_1",
      });
      expect(await capOf(f)).toBe(1024 * GIB);
    },
  );

  integrationTest("a refund that fails is left for a person, never lost", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_over_fail");
    const stripe = fakeStripe();
    const shown = await preview(f, stripe, prices.tb1Monthly);
    stripe.chargedAmount = shown.amountDueNowMinor + 500;
    stripe.refundFails = true;

    await change(f, stripe, prices.tb1Monthly, {
      prorationDate: shown.prorationDate,
      expectedAmountMinor: shown.amountDueNowMinor,
    });

    const [incident] = await asAdmin(
      f,
      (tx) => tx<{ status: string; refund_minor: string; last_error: string | null }[]>`
        SELECT status, refund_minor::text AS refund_minor, last_error
        FROM app.storage_billing_incidents WHERE school_id = ${f.schoolId}::uuid
      `,
    );
    expect(incident).toEqual({
      status: "needs_review",
      refund_minor: "500",
      last_error: "card network unavailable",
    });
  });

  integrationTest("exactly the confirmed amount refunds nothing", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_exact");
    const stripe = fakeStripe();
    const shown = await preview(f, stripe, prices.tb1Monthly);

    await change(f, stripe, prices.tb1Monthly, {
      prorationDate: shown.prorationDate,
      expectedAmountMinor: shown.amountDueNowMinor,
    });

    expect(stripe.refunds).toHaveLength(0);
  });

  integrationTest(
    "an amount left over from an earlier change blocks a change, before anything is asked",
    async () => {
      const f = await createBillingFixture(database!);
      await bought(f, "sub_storage_leftover");
      const stripe = fakeStripe();
      stripe.pendingItems = { count: 2, netMinor: -3_879 };

      await expectCode(
        preview(f, stripe, prices.tb1Monthly),
        409,
        ERROR_CODES.STORAGE_ADDON_UNSETTLED,
      );
      await expectCode(
        change(f, stripe, prices.tb1Monthly, {
          prorationDate: new Date(),
          expectedAmountMinor: 0,
        }),
        409,
        ERROR_CODES.STORAGE_ADDON_UNSETTLED,
      );
      expect(stripe.previews).toHaveLength(0);
      expect(stripe.changes).toHaveLength(0);
    },
  );

  integrationTest(
    "moving down is scheduled for the renewal: nothing charged, the storage kept until then",
    async () => {
      const f = await createBillingFixture(database!);
      await bought1tb(f, "sub_storage_down");
      const stripe = fakeStripe();

      const shown = await preview(f, stripe, prices.gb100Monthly);
      expect(shown).toMatchObject({
        timing: "renewal",
        amountDueNowMinor: 0,
        nextBillMinor: 1_000,
        chargeNow: false,
      });
      expect(stripe.previews).toHaveLength(0);

      const current = await change(f, stripe, prices.gb100Monthly, {
        prorationDate: shown.prorationDate,
        expectedAmountMinor: 0,
        requestKey: "6f1d1c2e-1111-4a4a-8b8b-0000000000cc",
      });

      expect(stripe.changes).toHaveLength(0);
      expect(stripe.schedules).toEqual([
        {
          providerSubscriptionId: "sub_storage_down",
          priceId: "price_storage_100gb_monthly",
          metadata: { price_id: prices.gb100Monthly, billing_interval: "monthly" },
          idempotencyKey: expect.stringContaining("6f1d1c2e-1111-4a4a-8b8b-0000000000cc"),
        },
      ]);
      expect(current).toMatchObject({
        planCode: "storage_1tb",
        capBytes: 1024 * GIB,
        pendingChange: {
          planCode: "storage_100gb",
          capBytes: 100 * GIB,
          effectiveAt: SCHEDULED_AT,
        },
      });
      expect(await capOf(f)).toBe(1024 * GIB);

      // A second change waits until this one is applied or undone.
      await expectCode(
        preview(f, stripe, prices.tb1Monthly),
        409,
        ERROR_CODES.STORAGE_ADDON_CHANGE_PENDING,
      );

      // An event from before the renewal (still the old price) changes nothing.
      await deliver(
        f,
        storageUpdated(
          f,
          "evt_down_before",
          1_700_000_200,
          "sub_storage_down",
          "price_storage_1tb_monthly",
        ),
      );
      expect(await capOf(f)).toBe(1024 * GIB);

      // At the renewal Stripe moves the subscription to the new price: the row follows.
      await deliver(
        f,
        storageUpdated(
          f,
          "evt_down_renewed",
          1_700_000_300,
          "sub_storage_down",
          "price_storage_100gb_monthly",
        ),
      );
      expect(await storageRow(f)).toMatchObject({
        plan_price_id: prices.gb100Monthly,
        cap_bytes: String(100 * GIB),
      });
      const [cleared] = await asAdmin(
        f,
        (tx) => tx<{ pending_plan_price_id: string | null; stripe_schedule_id: string | null }[]>`
          SELECT pending_plan_price_id, stripe_schedule_id FROM app.storage_subscriptions
          WHERE school_id = ${f.schoolId}::uuid
        `,
      );
      expect(cleared).toEqual({ pending_plan_price_id: null, stripe_schedule_id: null });
      expect(await capOf(f)).toBe(100 * GIB);
    },
  );

  integrationTest("moving to yearly is scheduled for the renewal too", async () => {
    const f = await createBillingFixture(database!);
    await bought(f, "sub_storage_yearly");
    const stripe = fakeStripe();

    const shown = await preview(f, stripe, prices.gb100Yearly);
    expect(shown).toMatchObject({ timing: "renewal", amountDueNowMinor: 0, chargeNow: false });

    await change(f, stripe, prices.gb100Yearly, {
      prorationDate: shown.prorationDate,
      expectedAmountMinor: 0,
    });

    expect(stripe.changes).toHaveLength(0);
    expect(stripe.schedules[0]).toMatchObject({ priceId: "price_storage_100gb_yearly" });
    expect(await capOf(f)).toBe(100 * GIB);
  });

  integrationTest(
    "a scheduled change can be undone, and a change at renewal costs nothing",
    async () => {
      const f = await createBillingFixture(database!);
      await bought1tb(f, "sub_storage_undo");
      const stripe = fakeStripe();
      const shown = await preview(f, stripe, prices.gb100Monthly);

      // Confirming a renewal change with any amount but 0 is refused.
      await expectCode(
        change(f, stripe, prices.gb100Monthly, {
          prorationDate: shown.prorationDate,
          expectedAmountMinor: 100,
        }),
        409,
        ERROR_CODES.STORAGE_ADDON_PRICE_CHANGED,
      );

      await change(f, stripe, prices.gb100Monthly, {
        prorationDate: shown.prorationDate,
        expectedAmountMinor: 0,
      });
      const undone = await undoScheduledStorageChange(f.db.sql, registry(stripe), {
        schoolId: f.schoolId,
        tenantContext: { schoolId: f.schoolId },
      });

      expect(stripe.released).toEqual(["sub_sched_1"]);
      expect(undone.pendingChange).toBeNull();
      expect(await capOf(f)).toBe(1024 * GIB);
      await expectCode(
        undoScheduledStorageChange(f.db.sql, registry(stripe), {
          schoolId: f.schoolId,
          tenantContext: { schoolId: f.schoolId },
        }),
        409,
        ERROR_CODES.STORAGE_ADDON_NO_PENDING_CHANGE,
      );
    },
  );

  integrationTest("canceling drops a change scheduled for the renewal first", async () => {
    const f = await createBillingFixture(database!);
    await bought1tb(f, "sub_storage_cancel_pending");
    const stripe = fakeStripe();
    const shown = await preview(f, stripe, prices.gb100Monthly);
    await change(f, stripe, prices.gb100Monthly, {
      prorationDate: shown.prorationDate,
      expectedAmountMinor: 0,
    });

    await setStorageAddonCancellation(f.db.sql, registry(stripe), {
      schoolId: f.schoolId,
      cancel: true,
      tenantContext: { schoolId: f.schoolId },
    });

    expect(stripe.released).toEqual(["sub_sched_1"]);
    expect(stripe.cancellations).toEqual(["cancel:sub_storage_cancel_pending"]);
    expect(await storageRow(f)).toMatchObject({ cancel_at_period_end: true });
  });

  integrationTest(
    "the school sees its card, next bill and invoices, and can replace the card",
    async () => {
      const f = await createBillingFixture(database!);
      await bought(f, "sub_storage_billing");
      const stripe = fakeStripe();
      const providers = registry(stripe);
      const params = { schoolId: f.schoolId, tenantContext: { schoolId: f.schoolId } };

      const billing = await getStorageBilling(f.db.sql, providers, params);
      expect(billing).toEqual(stripe.billing);

      const session = await createStoragePaymentMethodSession(f.db.sql, providers, {
        ...params,
        returnUrl: "https://app.example/portal/license/storage",
      });
      expect(session.url).toBe("https://billing.example/portal");
      expect(stripe.portalSessions).toEqual([
        { customerId: f.stripeCustomerId, returnUrl: "https://app.example/portal/license/storage" },
      ]);
    },
  );

  integrationTest(
    "the super admin refunds a storage invoice, never more than it took",
    async () => {
      const f = await createBillingFixture(database!);
      await bought(f, "sub_storage_admin_refund");
      const stripe = fakeStripe();
      const providers = registry(stripe);
      const actor = {
        kind: "platform" as const,
        userId: f.studentUserId,
        homeSchoolId: f.schoolId,
      };

      const view = await getPlatformStorageSubscription(f.db.sql, providers, f.schoolId, actor);
      expect(view.subscription).toMatchObject({
        planCode: "storage_100gb",
        stripeSubscriptionId: "sub_storage_admin_refund",
      });
      expect(view.billing?.invoices).toHaveLength(1);

      const refund = (amountMinor: number, invoiceId = "in_storage_1") =>
        refundPlatformStorageInvoice(f.db.sql, providers, {
          schoolId: f.schoolId,
          invoiceId,
          amountMinor,
          reason: "Charged twice on 14 November",
          requestKey: "6f1d1c2e-1111-4a4a-8b8b-0000000000dd",
          actor,
        });

      await expectCode(refund(3_880), 422, ERROR_CODES.STORAGE_ADDON_REFUND_INVALID);
      await expectCode(
        refund(100, "in_someone_else"),
        422,
        ERROR_CODES.STORAGE_ADDON_REFUND_INVALID,
      );
      expect(stripe.refunds).toHaveLength(0);

      const result = await refund(3_879);
      expect(result).toEqual({ refundId: "re_1", status: "succeeded", amountMinor: 3_879 });
      expect(stripe.refunds[0]).toMatchObject({
        invoiceId: "in_storage_1",
        amountMinor: 3_879,
        idempotencyKey: "storage-admin-refund:in_storage_1:6f1d1c2e-1111-4a4a-8b8b-0000000000dd",
      });
    },
  );

  integrationTest("there is nothing to change or cancel without a live add-on", async () => {
    const f = await createBillingFixture(database!);
    const stripe = fakeStripe();

    await expectCode(
      preview(f, stripe, prices.tb1Monthly),
      409,
      ERROR_CODES.STORAGE_ADDON_NOT_ACTIVE,
    );
    await expectCode(
      change(f, stripe, prices.tb1Monthly, {
        prorationDate: new Date(),
        expectedAmountMinor: 0,
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

describe("a second storage subscription", () => {
  async function duplicates(f: BillingFixture) {
    const rows = await asAdmin(
      f,
      (tx) => tx<
        {
          stripe_subscription_id: string;
          kept_stripe_subscription_id: string | null;
          source: string;
          status: string;
        }[]
      >`
        SELECT stripe_subscription_id, kept_stripe_subscription_id, source, status
        FROM app.storage_duplicate_subscriptions WHERE school_id = ${f.schoolId}::uuid
        ORDER BY created_at
      `,
    );
    return [...rows];
  }

  async function period(f: BillingFixture) {
    const [row] = await asAdmin(
      f,
      (tx) => tx<{ current_period_end: Date }[]>`
        SELECT current_period_end FROM app.storage_subscriptions
        WHERE school_id = ${f.schoolId}::uuid
      `,
    );
    return row!.current_period_end.getTime();
  }

  function storageRenewed(
    f: BillingFixture,
    id: string,
    created: number,
    subscription: string,
  ): StubEventInput {
    return {
      id,
      type: "customer.subscription.updated",
      created,
      data: {
        id: subscription,
        customer: f.stripeCustomerId,
        status: "active",
        metadata: { school_id: f.schoolId, addon: "storage" },
        items: {
          data: [{ current_period_start: created, current_period_end: created + 31 * 86_400 }],
        },
      },
    };
  }

  integrationTest(
    "its cancellation never ends the school's storage, and its renewal never moves the period",
    async () => {
      const f = await createBillingFixture(database!);
      await deliver(
        f,
        storagePurchased(f, "evt_dup_a1", 1_700_000_100, "sub_dup_a", prices.gb100Monthly),
      );
      const before = await period(f);

      expect(
        await deliver(f, storageRenewed(f, "evt_dup_r1", 1_700_100_000, "sub_dup_stray")),
      ).toEqual({ received: true, outcome: "parked" });
      expect(
        await deliver(f, storageDeleted(f, "evt_dup_d1", 1_700_100_100, "sub_dup_stray")),
      ).toEqual({ received: true, outcome: "parked" });

      expect(await storageRow(f)).toMatchObject({
        status: "active",
        stripe_subscription_id: "sub_dup_a",
      });
      expect(await period(f)).toBe(before);
      expect(await capOf(f)).toBe(100 * GIB);
      // Seen without a checkout: flagged for a person, never canceled automatically.
      expect(await duplicates(f)).toEqual([
        {
          stripe_subscription_id: "sub_dup_stray",
          kept_stripe_subscription_id: "sub_dup_a",
          source: "event",
          status: "needs_review",
        },
      ]);
    },
  );

  integrationTest(
    "a second completed purchase is kept and the one it replaces retired, exactly once",
    async () => {
      const f = await createBillingFixture(database!);
      await deliver(
        f,
        storagePurchased(f, "evt_dup_b1", 1_700_000_100, "sub_dup_old", prices.gb100Monthly),
      );

      // The new subscription's own event can arrive before its checkout: it is only flagged.
      await deliver(f, storageRenewed(f, "evt_dup_b2", 1_700_000_150, "sub_dup_new"));
      expect((await duplicates(f))[0]).toMatchObject({ source: "event", status: "needs_review" });

      const bought = storagePurchased(
        f,
        "evt_dup_b3",
        1_700_000_200,
        "sub_dup_new",
        prices.tb1Monthly,
      );
      expect(await deliver(f, bought)).toEqual({ received: true, outcome: "processed" });
      // A redelivery of the same completion (a new event id) changes nothing more.
      await deliver(f, { ...bought, id: "evt_dup_b3_again" });

      expect(await storageRow(f)).toMatchObject({
        status: "active",
        plan_price_id: prices.tb1Monthly,
        cap_bytes: String(STORAGE_ADDON_TIERS.storage_1tb.capBytes),
        stripe_subscription_id: "sub_dup_new",
      });
      expect(await capOf(f)).toBe(1024 * GIB);
      expect(await duplicates(f)).toEqual([
        {
          stripe_subscription_id: "sub_dup_old",
          kept_stripe_subscription_id: "sub_dup_new",
          source: "checkout",
          status: "pending",
        },
      ]);

      // A late copy of the old purchase, and the cancellation the worker causes, are finished with
      // and never move the add-on back or end it.
      expect(
        await deliver(
          f,
          storagePurchased(f, "evt_dup_b4", 1_700_000_300, "sub_dup_old", prices.gb100Monthly),
        ),
      ).toEqual({ received: true, outcome: "processed" });
      expect(
        await deliver(f, storageDeleted(f, "evt_dup_b5", 1_700_000_400, "sub_dup_old")),
      ).toEqual({ received: true, outcome: "processed" });

      expect(await storageRow(f)).toMatchObject({
        status: "active",
        plan_price_id: prices.tb1Monthly,
        stripe_subscription_id: "sub_dup_new",
      });
      expect(await duplicates(f)).toHaveLength(1);

      // Later events of the kept subscription move the add-on as usual.
      await deliver(f, storageDeleted(f, "evt_dup_b6", 1_700_000_500, "sub_dup_new"));
      expect((await storageRow(f))?.status).toBe("canceled");
    },
  );
});
