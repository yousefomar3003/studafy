/**
 * POST /api/admin/subscriptions/sync-prices, against a real database and the real Stripe adapter
 * over an in-memory Stripe (fake-stripe-catalog.ts).
 *
 * The sync is about to be run in production to publish the storage add-on prices (000205), over a
 * catalogue earlier runs already published, so what matters is what a *repeated* run does: nothing,
 * unless a row actually changed.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { syncPlanPrices } from "../services/price-sync-service";
import { priceLookupKey, StripeAdapter } from "../stripe/adapter";

import { FakeStripeCatalog } from "./fake-stripe-catalog";
import { createBillingDatabase, silentLogger } from "./webhook-fixture";

import type { TestDatabase } from "../../../../tests/harness";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | null = null;
const catalog = new FakeStripeCatalog();
const adapter = new StripeAdapter({
  secretKey: "unused-a-client-is-given",
  webhookSecret: "whsec_test",
  client: catalog.client(),
});

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

interface Row {
  id: string;
  stripe_id: string | null;
  updated_at: Date;
}

async function planRows(db: TestDatabase): Promise<Row[]> {
  return db.sql<Row[]>`
    SELECT id, stripe_product_id AS stripe_id, updated_at FROM app.plans ORDER BY id
  `;
}

async function priceRows(db: TestDatabase): Promise<Row[]> {
  return db.sql<Row[]>`
    SELECT id, stripe_price_id AS stripe_id, updated_at FROM app.plan_prices ORDER BY id
  `;
}

function sync(db: TestDatabase) {
  return syncPlanPrices(db.sql, adapter, silentLogger);
}

// One catalogue, built up step by step: each test starts from the state the one before left.
describe("syncPlanPrices", () => {
  integrationTest("the first run publishes every plan and price once", async () => {
    const db = database!;
    const plans = await planRows(db);
    const prices = await priceRows(db);
    // The migrations seed the licence plans, the AI add-on and the storage add-on.
    expect(plans.length).toBeGreaterThan(0);
    expect(prices.length).toBeGreaterThan(0);
    await db.sql`UPDATE app.plans SET stripe_product_id = NULL`;
    await db.sql`UPDATE app.plan_prices SET stripe_price_id = NULL`;

    const result = await sync(db);

    expect(result.products).toEqual({ created: plans.length, updated: 0, unchanged: 0 });
    expect(result.prices).toEqual({ created: prices.length, updated: 0, unchanged: 0 });
    expect(result.syncedPlans).toBe(plans.length);
    expect(result.syncedPrices).toBe(prices.length);
    expect(catalog.products.size).toBe(plans.length);
    expect(catalog.prices.size).toBe(prices.length);
    for (const row of await priceRows(db)) {
      expect(catalog.prices.get(row.stripe_id!)?.lookup_key).toBe(priceLookupKey(row.id));
    }
  });

  integrationTest("a second run creates nothing and writes nothing", async () => {
    const db = database!;
    const plansBefore = await planRows(db);
    const pricesBefore = await priceRows(db);
    const writes = { ...catalog.writes };

    const result = await sync(db);

    expect(result.products).toEqual({ created: 0, updated: 0, unchanged: plansBefore.length });
    expect(result.prices).toEqual({ created: 0, updated: 0, unchanged: pricesBefore.length });
    expect(result.archivedPrices).toBe(0);
    expect(catalog.writes).toEqual(writes);
    // Not even updated_at moves: a row is written only when its id changes.
    expect(await planRows(db)).toEqual(plansBefore);
    expect(await priceRows(db)).toEqual(pricesBefore);
  });

  integrationTest("a changed amount creates one price and archives the old one", async () => {
    const db = database!;
    const [target] = await db.sql<{ id: string; stripe_price_id: string; amount_minor: number }[]>`
      SELECT pp.id, pp.stripe_price_id, pp.amount_minor
      FROM app.plan_prices pp JOIN app.plans p ON p.id = pp.plan_id
      WHERE p.code = 'storage_100gb' AND pp.billing_interval = 'monthly'
    `;
    expect(target).toBeDefined();
    await db.sql`
      UPDATE app.plan_prices SET amount_minor = amount_minor + 100 WHERE id = ${target!.id}::uuid
    `;
    const pricesBefore = await priceRows(db);

    const result = await sync(db);

    expect(result.prices.created).toBe(1);
    expect(result.prices.updated).toBe(0);
    expect(result.prices.unchanged).toBe(pricesBefore.length - 1);
    expect(result.products.created).toBe(0);
    expect(result.archivedPrices).toBe(1);

    const [after] = await db.sql<{ stripe_price_id: string }[]>`
      SELECT stripe_price_id FROM app.plan_prices WHERE id = ${target!.id}::uuid
    `;
    expect(after!.stripe_price_id).not.toBe(target!.stripe_price_id);
    expect(catalog.prices.get(after!.stripe_price_id)?.unit_amount).toBe(
      Number(target!.amount_minor) + 100,
    );
    expect(catalog.prices.get(target!.stripe_price_id)?.active).toBe(false);
    // Only that one row was repointed.
    const changed = (await priceRows(db)).filter(
      (row, index) => row.stripe_id !== pricesBefore.at(index)?.stripe_id,
    );
    expect(changed.map((row) => row.id)).toEqual([target!.id]);
  });

  integrationTest("lost or stale stored ids are recovered without creating anything", async () => {
    const db = database!;
    const [plan] = await db.sql<{ id: string; stripe_product_id: string }[]>`
      SELECT id, stripe_product_id FROM app.plans WHERE code = 'storage_1tb'
    `;
    const [price] = await db.sql<{ id: string; stripe_price_id: string }[]>`
      SELECT id, stripe_price_id FROM app.plan_prices WHERE plan_id = ${plan!.id}::uuid LIMIT 1
    `;
    // A product id Stripe does not know (another account, a wiped test mode), and a price whose id
    // write never landed.
    await db.sql`UPDATE app.plans SET stripe_product_id = 'prod_gone' WHERE id = ${plan!.id}::uuid`;
    await db.sql`UPDATE app.plan_prices SET stripe_price_id = NULL WHERE id = ${price!.id}::uuid`;
    const writes = { ...catalog.writes };

    const result = await sync(db);

    expect(result.products.created).toBe(0);
    expect(result.prices.created).toBe(0);
    expect(catalog.writes).toEqual(writes);
    const [planAfter] = await db.sql<{ stripe_product_id: string }[]>`
      SELECT stripe_product_id FROM app.plans WHERE id = ${plan!.id}::uuid
    `;
    const [priceAfter] = await db.sql<{ stripe_price_id: string }[]>`
      SELECT stripe_price_id FROM app.plan_prices WHERE id = ${price!.id}::uuid
    `;
    expect(planAfter!.stripe_product_id).toBe(plan!.stripe_product_id);
    expect(priceAfter!.stripe_price_id).toBe(price!.stripe_price_id);
  });
});
