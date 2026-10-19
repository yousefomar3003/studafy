/**
 * Buying the AI add-on on the website: what the offer lists, and who the checkout lets pay for
 * whom -- against a real database (the parent links and RLS are the thing under test).
 */

import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { getAiOffer } from "../services/ai-offer-service";
import { createAiCheckoutSession } from "../services/checkout-service";

import { createBillingDatabase, createBillingFixture } from "./webhook-fixture";

import type { BillingFixture } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

/** Runs `run` as `studafy_admin` inside the fixture school's tenant context. */
async function asAdmin<T>(f: BillingFixture, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    return run(tx);
  }) as Promise<T>;
}

/** A user of the fixture school with no student record (a parent, or a stranger). */
async function addUser(f: BillingFixture, label: string): Promise<string> {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@local`;
  return asAdmin(f, async (tx) => {
    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${f.schoolId}::uuid, ${email}, ${email}, ${label}, 'active')
      RETURNING id
    `;
    return user!.id;
  });
}

async function linkParent(f: BillingFixture, parentUserId: string): Promise<void> {
  await asAdmin(f, async (tx) => {
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${f.schoolId}::uuid, 'Test family', ${parentUserId}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${f.schoolId}::uuid, ${parentUserId}::uuid, ${f.studentId}::uuid, 'mother', ${family!.id}::uuid)
    `;
  });
}

/**
 * The AI add-on's catalog price, synced to the (fake) provider. The catalog is global and holds one
 * price per currency and interval, so every test shares this one row.
 */
async function addAiPrice(f: BillingFixture): Promise<string> {
  return asAdmin(f, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor, is_active, stripe_price_id)
      SELECT p.id, c.id, 'monthly', 499, true, 'price_ai_test'
      FROM app.plans p, app.currencies c
      WHERE p.code = 'ai_addon' AND c.code = 'USD'
      ON CONFLICT (plan_id, currency_id, billing_interval)
        DO UPDATE SET is_active = true, amount_minor = 499
      RETURNING id
    `;
    return row!.id;
  });
}

async function withdrawAiPrice(f: BillingFixture): Promise<void> {
  await asAdmin(f, async (tx) => {
    await tx`
      UPDATE app.plan_prices SET is_active = false
      WHERE plan_id = (SELECT id FROM app.plans WHERE code = 'ai_addon')
    `;
  });
}

function offerFor(f: BillingFixture, userId: string) {
  return getAiOffer(f.db.sql, { schoolId: f.schoolId, userId });
}

const checkouts: string[] = [];
const provider = {
  createCheckoutSession: async (input: { customerId: string }) => {
    checkouts.push(input.customerId);
    return { url: "https://checkout.example/session", sessionId: "cs_test_1" };
  },
} as unknown as PaymentProviderPort;

function checkoutAs(f: BillingFixture, userId: string, priceId: string) {
  return createAiCheckoutSession(
    f.db.sql,
    { stripe: provider, tap: null },
    {
      schoolId: f.schoolId,
      priceId,
      studentId: f.studentId,
      successUrl: "https://app.example/account/ai?checkout=success",
      cancelUrl: "https://app.example/account/ai?checkout=cancelled",
      tenantContext: { schoolId: f.schoolId, userId },
    },
  );
}

describe("the AI add-on offer", () => {
  integrationTest("has no price until one is set, then the catalog's", async () => {
    const f = await createBillingFixture(database!);
    await withdrawAiPrice(f);

    expect((await offerFor(f, f.studentUserId)).price).toBeNull();

    const priceId = await addAiPrice(f);

    expect((await offerFor(f, f.studentUserId)).price).toEqual({
      id: priceId,
      amountMinor: 499,
      currency: "USD",
      interval: "monthly",
    });
  });

  integrationTest("lists the student themselves, and a linked parent's child", async () => {
    const f = await createBillingFixture(database!);
    const parent = await addUser(f, "parent");
    await linkParent(f, parent);

    const own = await offerFor(f, f.studentUserId);
    const parents = await offerFor(f, parent);

    expect(own.students).toEqual([{ id: f.studentId, name: "Test Student", active: false }]);
    expect(parents.students).toEqual(own.students);
  });

  integrationTest("lists no one for a user who is neither", async () => {
    const f = await createBillingFixture(database!);
    const stranger = await addUser(f, "stranger");

    expect((await offerFor(f, stranger)).students).toEqual([]);
  });

  integrationTest("marks a student whose add-on is live as active", async () => {
    const f = await createBillingFixture(database!);
    await asAdmin(f, async (tx) => {
      await tx`
        INSERT INTO app.ai_subscriptions (school_id, student_id, status, current_period_start, current_period_end)
        VALUES (${f.schoolId}::uuid, ${f.studentId}::uuid, 'active', now(), now() + interval '30 days')
      `;
    });

    expect((await offerFor(f, f.studentUserId)).students[0]!.active).toBe(true);
  });
});

describe("who the AI checkout lets pay", () => {
  integrationTest("the student and a linked parent reach the provider", async () => {
    const f = await createBillingFixture(database!);
    const parent = await addUser(f, "parent");
    await linkParent(f, parent);
    const priceId = await addAiPrice(f);

    expect((await checkoutAs(f, f.studentUserId, priceId)).url).toBe(
      "https://checkout.example/session",
    );
    expect((await checkoutAs(f, parent, priceId)).url).toBe("https://checkout.example/session");
  });

  integrationTest("anyone else gets the not-found a missing student gets", async () => {
    const f = await createBillingFixture(database!);
    const stranger = await addUser(f, "stranger");
    const priceId = await addAiPrice(f);

    let code: string | undefined;
    try {
      await checkoutAs(f, stranger, priceId);
    } catch (error) {
      code = (error as CodedHttpException).code;
    }

    expect(code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });
});
