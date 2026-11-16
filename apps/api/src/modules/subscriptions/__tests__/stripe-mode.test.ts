/**
 * Running production on Stripe Sandbox keys and back (000225, docs/billing/stripe-modes.md), against
 * a real database: the key's mode, one Stripe customer per school and mode (never a new one per
 * failed checkout), a storage add-on bought in the other mode neither blocking a purchase nor being
 * touched through the wrong key, webhooks from the other mode ignored, and the offer's test-mode flag.
 */

import { stripeModeFromKey } from "@studafy/billing";
import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { createStorageCheckoutSession } from "../services/checkout-service";
import { getStorageOffer } from "../services/storage-addon-service";
import { handleBillingWebhook } from "../webhooks/webhook-processor";

import {
  createBillingDatabase,
  createBillingFixture,
  createProviderStub,
  encodeEvent,
  resetBillingEvents,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture, StubEventInput } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { CreateCustomerInput, PaymentProviderPort } from "../ports/payment-provider";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const CONTEXT = { path: "/api/subscriptions/webhook/stripe", requestId: null };

let database: TestDatabase | null = null;
let gb100Monthly = "";

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
  const rows = await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return tx<{ id: string; code: string; billing_interval: string }[]>`
      UPDATE app.plan_prices pp
      SET stripe_price_id = 'price_' || p.code || '_' || pp.billing_interval::text
      FROM app.plans p
      WHERE p.id = pp.plan_id AND p.code IN ('storage_100gb', 'storage_1tb')
      RETURNING pp.id, p.code, pp.billing_interval::text AS billing_interval
    `;
  });
  gb100Monthly = rows.find(
    (r) => r.code === "storage_100gb" && r.billing_interval === "monthly",
  )!.id;
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

afterEach(async () => {
  if (database) await resetBillingEvents(database);
});

async function asAdmin<T>(f: BillingFixture, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

async function schoolCustomer(f: BillingFixture) {
  const [row] = await asAdmin(
    f,
    (tx) => tx<{ stripe_customer_id: string | null; stripe_customer_livemode: boolean | null }[]>`
      SELECT stripe_customer_id, stripe_customer_livemode FROM app.schools
      WHERE id = ${f.schoolId}::uuid
    `,
  );
  return row!;
}

async function setSchoolCustomer(f: BillingFixture, id: string | null, livemode: boolean | null) {
  await asAdmin(
    f,
    (tx) => tx`
      UPDATE app.schools SET stripe_customer_id = ${id}, stripe_customer_livemode = ${livemode}
      WHERE id = ${f.schoolId}::uuid
    `,
  );
}

async function storageRow(f: BillingFixture) {
  const [row] = await asAdmin(
    f,
    (tx) => tx<{ status: string; stripe_livemode: boolean | null }[]>`
      SELECT status::text AS status, stripe_livemode
      FROM app.storage_subscriptions WHERE school_id = ${f.schoolId}::uuid
    `,
  );
  return row;
}

interface FakeStripe {
  port: PaymentProviderPort;
  created: CreateCustomerInput[];
  /** Customers Stripe holds, by school id, as search would find them (none while search lags). */
  searchable: Map<string, string>;
  searchLags: boolean;
  /** Subscriptions this account can see, with their mode. */
  subscriptions: Map<string, boolean>;
  /** Customers this account can see, with their mode. */
  customers: Map<string, boolean>;
  inFlightLive: string[];
  checkouts: string[];
}

/** A Stripe account in one mode; only what a storage checkout touches. */
function fakeStripe(livemode: boolean): FakeStripe {
  const fake: FakeStripe = {
    created: [],
    searchable: new Map(),
    searchLags: false,
    subscriptions: new Map(),
    customers: new Map(),
    inFlightLive: [],
    checkouts: [],
    port: undefined as unknown as PaymentProviderPort,
  };
  const unused = () => Promise.reject(new Error("not used"));
  fake.port = {
    livemode,
    createCustomer: (input: CreateCustomerInput) => {
      fake.created.push(input);
      // Stripe replays a create with the same idempotency key: the same customer comes back.
      const id = `cus_${livemode ? "live" : "test"}_${input.idempotencyKey ?? fake.created.length}`;
      fake.customers.set(id, livemode);
      fake.searchable.set(input.metadata.school_id!, id);
      return Promise.resolve({ providerCustomerId: id });
    },
    findCustomerBySchoolId: (schoolId: string) =>
      Promise.resolve(fake.searchLags ? null : (fake.searchable.get(schoolId) ?? null)),
    retrieveCustomer: (id: string) =>
      Promise.resolve(fake.customers.has(id) ? { livemode: fake.customers.get(id)! } : null),
    retrieveSubscriptionMode: (id: string) =>
      Promise.resolve(
        fake.subscriptions.has(id) ? { livemode: fake.subscriptions.get(id)! } : null,
      ),
    createCheckoutSession: (input: { customerId: string }) => {
      fake.checkouts.push(input.customerId);
      return Promise.resolve({ url: "https://checkout.example/storage", sessionId: "cs_storage" });
    },
    findAddonPurchasesInFlight: () =>
      Promise.resolve({ liveSubscriptionIds: [...fake.inFlightLive], openCheckoutSessionIds: [] }),
    expireCheckoutSession: () => Promise.resolve("expired"),
    changeSubscriptionPrice: unused,
    previewSubscriptionPriceChange: unused,
    scheduleSubscriptionPriceChange: unused,
    releaseSubscriptionSchedule: unused,
    countPendingInvoiceItems: () => Promise.resolve({ count: 0, netMinor: 0 }),
  } as unknown as PaymentProviderPort;
  return fake;
}

function registry(stripe: FakeStripe): PaymentProviderRegistry {
  return { stripe: stripe.port, tap: null };
}

function checkout(f: BillingFixture, stripe: FakeStripe) {
  return createStorageCheckoutSession(f.db.sql, registry(stripe), {
    schoolId: f.schoolId,
    priceId: gb100Monthly,
    successUrl: "https://app.example/storage?checkout=success",
    cancelUrl: "https://app.example/storage?checkout=cancelled",
    tenantContext: { schoolId: f.schoolId },
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error === null) return null;
  expect(error).toBeInstanceOf(CodedHttpException);
  return (error as { code: string }).code;
}

function storagePurchased(f: BillingFixture, subscription: string): StubEventInput {
  return {
    id: `evt_${subscription}`,
    type: "checkout.session.completed",
    created: 1_700_000_100,
    data: {
      id: `cs_${subscription}`,
      customer: f.stripeCustomerId,
      subscription,
      metadata: { school_id: f.schoolId, addon: "storage", price_id: gb100Monthly },
    },
  };
}

function deliver(f: BillingFixture, event: StubEventInput, livemode?: boolean) {
  const provider = createProviderStub();
  if (livemode !== undefined) Object.assign(provider, { livemode });
  return handleBillingWebhook(
    { database: f.db.sql, providerName: "stripe", provider, logger: silentLogger },
    encodeEvent(event),
    "t=1,v1=stub",
    CONTEXT,
  );
}

describe("the key's mode", () => {
  test("is read from the key's prefix", () => {
    expect(stripeModeFromKey("sk_live_abc")).toBe("live");
    expect(stripeModeFromKey("rk_live_abc")).toBe("live");
    expect(stripeModeFromKey("sk_test_abc")).toBe("sandbox");
    expect(stripeModeFromKey("rk_test_abc")).toBe("sandbox");
    expect(stripeModeFromKey("placeholder")).toBeNull();
  });
});

describe("one Stripe customer per school and mode", () => {
  integrationTest("a failed checkout's customer is reused by the next one", async () => {
    const f = await createBillingFixture(database!);
    await setSchoolCustomer(f, null, null);
    const stripe = fakeStripe(false);
    stripe.inFlightLive = ["sub_paid_elsewhere"];

    // Fails after the customer was made: the transaction that stored it rolls back.
    expect(await codeOf(checkout(f, stripe))).toBe(ERROR_CODES.STORAGE_ADDON_PURCHASE_PENDING);
    expect((await schoolCustomer(f)).stripe_customer_id).toBeNull();
    expect(stripe.created).toHaveLength(1);

    stripe.inFlightLive = [];
    expect(await codeOf(checkout(f, stripe))).toBeNull();
    // Found by search, not created again.
    expect(stripe.created).toHaveLength(1);
    const stored = await schoolCustomer(f);
    expect(stored.stripe_customer_id).toBe(stripe.checkouts[0]!);
    expect(stored.stripe_customer_livemode).toBe(false);
  });

  integrationTest("while search lags, the retry repeats the same idempotency key", async () => {
    const f = await createBillingFixture(database!);
    await setSchoolCustomer(f, null, null);
    const stripe = fakeStripe(false);
    stripe.searchLags = true;
    stripe.inFlightLive = ["sub_paid_elsewhere"];
    await codeOf(checkout(f, stripe));
    stripe.inFlightLive = [];
    await checkout(f, stripe);

    expect(stripe.created).toHaveLength(2);
    expect(stripe.created[0]!.idempotencyKey).toBe(stripe.created[1]!.idempotencyKey!);
    expect(stripe.created[0]!.idempotencyKey).toContain(`school-customer:${f.schoolId}:sandbox:`);
  });

  integrationTest("a customer from the other mode is replaced by this mode's", async () => {
    const f = await createBillingFixture(database!);
    await setSchoolCustomer(f, "cus_live_original", true);
    const sandbox = fakeStripe(false);

    await checkout(f, sandbox);

    const stored = await schoolCustomer(f);
    expect(stored.stripe_customer_id).not.toBe("cus_live_original");
    expect(stored.stripe_customer_livemode).toBe(false);
    expect(sandbox.checkouts).toEqual([stored.stripe_customer_id!]);
  });

  integrationTest("a stored customer of unknown mode is asked about once and kept", async () => {
    const f = await createBillingFixture(database!);
    await setSchoolCustomer(f, "cus_known_to_sandbox", null);
    const sandbox = fakeStripe(false);
    sandbox.customers.set("cus_known_to_sandbox", false);

    await checkout(f, sandbox);

    expect(sandbox.created).toHaveLength(0);
    expect(await schoolCustomer(f)).toEqual({
      stripe_customer_id: "cus_known_to_sandbox",
      stripe_customer_livemode: false,
    });
  });
});

describe("a storage add-on bought in the other mode", () => {
  integrationTest("is ended for this mode and does not block a purchase", async () => {
    const f = await createBillingFixture(database!);
    await deliver(f, storagePurchased(f, "sub_live_storage"));
    expect((await storageRow(f))?.status).toBe("active");

    // Production now runs on Sandbox keys, which cannot see the live subscription.
    const sandbox = fakeStripe(false);
    const offer = await getStorageOffer(f.db.sql, registry(sandbox), { schoolId: f.schoolId });
    expect(offer.current).toBeNull();
    expect(offer.testMode).toBe(true);
    expect(await storageRow(f)).toEqual({ status: "canceled", stripe_livemode: true });

    expect(await codeOf(checkout(f, sandbox))).toBeNull();
  });

  integrationTest("one this mode can see stays live", async () => {
    const f = await createBillingFixture(database!);
    await deliver(f, storagePurchased(f, "sub_sandbox_storage"));
    const sandbox = fakeStripe(false);
    sandbox.subscriptions.set("sub_sandbox_storage", false);

    const offer = await getStorageOffer(f.db.sql, registry(sandbox), { schoolId: f.schoolId });
    expect(offer.current?.planCode).toBe("storage_100gb");
    expect(await storageRow(f)).toEqual({ status: "active", stripe_livemode: false });
    expect(await codeOf(checkout(f, sandbox))).toBe(ERROR_CODES.STORAGE_ADDON_ALREADY_ACTIVE);
  });

  integrationTest("a purchase records the mode it was made in", async () => {
    const f = await createBillingFixture(database!);
    const event = storagePurchased(f, "sub_new_sandbox");
    event.data.livemode = false;
    await deliver(f, event);
    expect((await storageRow(f))?.stripe_livemode).toBe(false);
  });
});

describe("webhooks from the other mode", () => {
  integrationTest("are answered 200 and never applied", async () => {
    const f = await createBillingFixture(database!);
    // The stub reports every event as a Sandbox event; the configured key is live.
    const outcome = await deliver(f, storagePurchased(f, "sub_from_sandbox"), true);
    expect(outcome).toEqual({ received: true, outcome: "ignored" });
    expect(await storageRow(f)).toBeUndefined();
  });
});
