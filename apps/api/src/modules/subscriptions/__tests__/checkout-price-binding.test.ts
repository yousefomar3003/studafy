/**
 * QA-012: a checkout only sells the product it is for.
 *
 * Both checkouts that take a caller-supplied price id looked it up by `id AND is_active` alone, and
 * the webhook later activates whatever the session was for (an AI subscription keyed on
 * `metadata.student_id`, or the school's plan) regardless of what was paid. So the AI add-on could
 * be bought at any other plan's active price -- a cheaper storage tier, another plan's tier price,
 * another currency -- and renew at it; and the legacy school checkout could activate the school's
 * plan with an AI or storage price. Each checkout now accepts only prices of its own plan family.
 */

import { ERROR_CODES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { createAiCheckoutSession, createSchoolCheckoutSession } from "../services/checkout-service";

import { createBillingDatabase, createBillingFixture } from "./webhook-fixture";

import type { BillingFixture } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderPort } from "../ports/payment-provider";

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

/** An active monthly USD price for the plan with `planCode`, synced to the fake provider. */
async function priceFor(f: BillingFixture, planCode: string, amountMinor: number): Promise<string> {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor, is_active, stripe_price_id)
      SELECT p.id, c.id, 'monthly', ${amountMinor}, true, ${`price_${planCode}_test`}
      FROM app.plans p, app.currencies c
      WHERE p.code = ${planCode} AND c.code = 'USD'
      ON CONFLICT (plan_id, currency_id, billing_interval)
        DO UPDATE SET is_active = true, amount_minor = EXCLUDED.amount_minor,
                      stripe_price_id = EXCLUDED.stripe_price_id
      RETURNING id
    `;
    if (!row) throw new Error(`no plan with code ${planCode}`);
    return row.id;
  }) as Promise<string>;
}

const provider = {
  createCheckoutSession: async () => ({
    url: "https://checkout.example/session",
    sessionId: "cs_test_binding",
  }),
  createCustomer: async () => ({ id: `cus_${crypto.randomUUID().slice(0, 8)}` }),
} as unknown as PaymentProviderPort;

const urls = {
  successUrl: "https://app.example/billing?checkout=success",
  cancelUrl: "https://app.example/billing?checkout=cancelled",
};

function aiCheckout(f: BillingFixture, priceId: string) {
  return createAiCheckoutSession(
    f.db.sql,
    { stripe: provider, tap: null },
    {
      schoolId: f.schoolId,
      priceId,
      studentId: f.studentId,
      ...urls,
      tenantContext: { schoolId: f.schoolId, userId: f.studentUserId },
    },
  );
}

function schoolCheckout(f: BillingFixture, priceId: string) {
  return createSchoolCheckoutSession(
    f.db.sql,
    { stripe: provider, tap: null },
    { schoolId: f.schoolId, priceId, ...urls, tenantContext: { schoolId: f.schoolId } },
  );
}

async function refusal(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CodedHttpException) return error.code;
    throw error;
  }
}

describe("checkout price binding (QA-012)", () => {
  integrationTest("the AI add-on checkout refuses a storage or school-plan price", async () => {
    const f = await createBillingFixture(database!);
    const storagePrice = await priceFor(f, "storage_100gb", 100);
    const schoolPrice = await priceFor(f, "free", 50);

    expect(await refusal(aiCheckout(f, storagePrice))).toBe(
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
    );
    expect(await refusal(aiCheckout(f, schoolPrice))).toBe(
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
    );
  });

  integrationTest("the AI add-on checkout still accepts the AI add-on's own price", async () => {
    const f = await createBillingFixture(database!);
    const aiPrice = await priceFor(f, "ai_addon", 599);
    expect(await refusal(aiCheckout(f, aiPrice))).toBeNull();
  });

  integrationTest("the school-plan checkout refuses an AI add-on or storage price", async () => {
    const f = await createBillingFixture(database!);
    const aiPrice = await priceFor(f, "ai_addon", 599);
    const storagePrice = await priceFor(f, "storage_1tb", 900);

    expect(await refusal(schoolCheckout(f, aiPrice))).toBe(
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
    );
    expect(await refusal(schoolCheckout(f, storagePrice))).toBe(
      ERROR_CODES.SUBSCRIPTION_CHECKOUT_FAILED,
    );
  });

  integrationTest("the school-plan checkout still accepts a school plan's price", async () => {
    const f = await createBillingFixture(database!);
    const schoolPrice = await priceFor(f, "free", 50);
    expect(await refusal(schoolCheckout(f, schoolPrice))).toBeNull();
  });
});
