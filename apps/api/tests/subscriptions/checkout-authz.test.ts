/**
 * QA-013: only school billing administrators may start a school-plan checkout.
 *
 * Both school checkouts were guarded by the web channel alone ("any authenticated web staff session
 * may do today" -- but students and parents have web sessions too). Any of them could make Studafy
 * create or bind the school's Stripe/Tap customer, read the enrolled-student count off the seat
 * quantity, and pay to activate or link the school's subscription.
 *
 * Requires a live PostgreSQL instance, gated on TEST_DATABASE_URL:
 *
 *   TEST_DATABASE_URL=postgres://... bun test tests/subscriptions/checkout-authz.test.ts
 */

import { ROLES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFullTenant,
  createTestApp,
  createTestDatabase,
  integrationEnabled,
  migrateDatabase,
  mintTestToken,
} from "../harness";
import { FakeStripeProvider } from "../mocks/fake-stripe-provider";

import type { TenantFixture, TestApp, TestDatabase } from "../harness";
import type { Role } from "@studafy/constants";

const describeDb = integrationEnabled ? describe : describe.skip;

let database: TestDatabase | undefined;
let harness: TestApp | undefined;
let tenant: TenantFixture;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase();
  await migrateDatabase(database.url);
  tenant = await createFullTenant(database.sql);
  const created = createTestApp({
    database: database.sql,
    stripeProvider: new FakeStripeProvider(),
  });
  await created.ready;
  harness = created;
}, 60_000);

afterAll(async () => {
  harness?.keyStore.destroy();
  await database?.cleanup();
});

const ROUTES = [
  {
    path: "/api/subscriptions/checkout",
    body: {
      priceId: crypto.randomUUID(),
      successUrl: "https://studafy.example/ok",
      cancelUrl: "https://studafy.example/no",
    },
  },
  {
    path: "/api/subscriptions/school/checkout",
    body: {
      planId: crypto.randomUUID(),
      successUrl: "https://studafy.example/ok",
      cancelUrl: "https://studafy.example/no",
    },
  },
];

async function start(role: Role, path: string, body: unknown): Promise<number> {
  const token = await mintTestToken(harness!.keyStore, {
    schoolId: tenant.schoolId,
    userId: tenant.users[role].id,
    roles: [role],
    channel: "web",
  });
  const response = await harness!.app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.status;
}

describeDb("school-plan checkout authorization (QA-013)", () => {
  for (const route of ROUTES) {
    for (const role of [ROLES.STUDENT, ROLES.PARENT, ROLES.INSTRUCTOR, ROLES.GUEST]) {
      test(`${role} cannot start POST ${route.path}`, async () => {
        expect(await start(role, route.path, route.body)).toBe(403);
      });
    }
    test(`ORG_ADMIN passes the permission gate on POST ${route.path}`, async () => {
      // The ids are random, so the handler refuses after the gate; only the gate is under test.
      expect(await start(ROLES.ORG_ADMIN, route.path, route.body)).not.toBe(403);
    });
  }
});
