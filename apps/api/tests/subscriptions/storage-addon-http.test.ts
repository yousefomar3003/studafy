/**
 * The storage add-on over HTTP: a principal (license:read / license:manage) sees the offer and can
 * start a checkout; a teacher is refused both. The pricing, attribution and cap rules themselves are
 * covered in src/modules/subscriptions/__tests__/storage-addon.test.ts.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AUTH_CHANNELS } from "../../src/modules/auth";
import {
  assignRole,
  authenticatedRequest,
  createSchool,
  createTestApp,
  createTestDatabase,
  createUser,
  integrationEnabled,
  migrateDatabase,
} from "../harness";

import type { PaymentProviderPort } from "../../src/modules/subscriptions/ports/payment-provider";
import type { TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
const checkouts: Record<string, string>[] = [];

const stripe = {
  createCustomer: () => Promise.resolve({ providerCustomerId: "cus_storage_http" }),
  createCheckoutSession: (input: { metadata: Record<string, string> }) => {
    checkouts.push(input.metadata);
    return Promise.resolve({ url: "https://checkout.example/storage", sessionId: "cs_http" });
  },
  changeSubscriptionPrice: () => Promise.resolve({ applied: true }),
} as unknown as PaymentProviderPort;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  await database.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`
      UPDATE app.plan_prices pp
      SET stripe_price_id = 'price_' || p.code || '_' || pp.billing_interval::text
      FROM app.plans p
      WHERE p.id = pp.plan_id AND p.code IN ('storage_100gb', 'storage_1tb')
    `;
  });
  const created = createTestApp({ database: database.sql, stripeProvider: stripe });
  await created.ready;
  harness = created;
}, 120_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

async function seed(role: Role): Promise<{ schoolId: string; userId: string }> {
  const sql = database!.sql;
  const school = await createSchool(sql);
  const user = await createUser(sql, school.id);
  await assignRole(sql, school.id, user.id, role);
  return { schoolId: school.id, userId: user.id };
}

function request(
  seeded: { schoolId: string; userId: string },
  role: Role,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return authenticatedRequest(
    harness!,
    method,
    path,
    { schoolId: seeded.schoolId, userId: seeded.userId, channel: AUTH_CHANNELS.WEB, roles: [role] },
    body === undefined
      ? undefined
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } },
  );
}

interface Offer {
  tiers: { planCode: string; prices: { id: string; interval: string }[] }[];
  availableOnline: boolean;
}

describeDb("storage add-on routes", () => {
  test("a principal sees the offer and can start a checkout", async () => {
    const seeded = await seed("PRINCIPAL");

    const offer = await request(seeded, "PRINCIPAL", "GET", "/api/subscriptions/storage/offer");
    expect(offer.status).toBe(200);
    const body = (await offer.json()) as Offer;
    expect(body.availableOnline).toBe(true);
    expect(body.tiers.map((tier) => tier.planCode)).toEqual(["storage_100gb", "storage_1tb"]);

    const priceId = body.tiers[0]!.prices.find((price) => price.interval === "monthly")!.id;
    const started = await request(
      seeded,
      "PRINCIPAL",
      "POST",
      "/api/subscriptions/storage/checkout",
      {
        priceId,
        successUrl: "https://app.example/admin/storage?checkout=success",
        cancelUrl: "https://app.example/admin/storage?checkout=cancelled",
      },
    );
    expect(started.status).toBe(200);
    expect(((await started.json()) as { url: string }).url).toBe(
      "https://checkout.example/storage",
    );
    expect(checkouts.at(-1)).toMatchObject({ school_id: seeded.schoolId, addon: "storage" });
  });

  test("a teacher can neither see the offer nor buy", async () => {
    const seeded = await seed("INSTRUCTOR");

    const offer = await request(seeded, "INSTRUCTOR", "GET", "/api/subscriptions/storage/offer");
    expect(offer.status).toBe(403);

    const started = await request(
      seeded,
      "INSTRUCTOR",
      "POST",
      "/api/subscriptions/storage/checkout",
      {
        priceId: crypto.randomUUID(),
        successUrl: "https://app.example/s",
        cancelUrl: "https://app.example/c",
      },
    );
    expect(started.status).toBe(403);
  });
});
