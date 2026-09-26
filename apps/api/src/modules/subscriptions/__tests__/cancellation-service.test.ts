/**
 * End-of-period cancellation across providers (ST-137, ST-298), against a real database.
 *
 * A Stripe-billed subscription must be cancelled at Stripe, because Stripe renews it. A Tap-billed
 * one is renewed by Studafy's own worker, which reads `cancel_at_period_end` -- so cancelling it
 * must work with no provider call at all, even on a deployment with no Stripe key.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { reverseCancellation, scheduleCancellation } from "../services/cancellation-service";

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

function stripeSpy() {
  const calls: string[] = [];
  const port = {
    async scheduleCancellation(input: { providerSubscriptionId: string }) {
      calls.push(`schedule:${input.providerSubscriptionId}`);
    },
    async reverseCancellation(input: { providerSubscriptionId: string }) {
      calls.push(`reverse:${input.providerSubscriptionId}`);
    },
  } as unknown as PaymentProviderPort;
  return { port, calls };
}

/** Re-bill the fixture's subscription: Tap (saved card, no Stripe id) or nothing at all. */
async function rebill(f: BillingFixture, billing: "tap" | "none"): Promise<void> {
  await f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    await tx`
      UPDATE app.subscriptions
      SET stripe_subscription_id = NULL,
          tap_card_id = ${billing === "tap" ? "card_TS" : null},
          tap_payment_agreement_id = ${billing === "tap" ? "payment_agreement_TS" : null},
          status = 'active'
      WHERE id = ${f.subscriptionId}::uuid
    `;
  });
}

const params = (f: BillingFixture) => ({
  schoolId: f.schoolId,
  tenantContext: { schoolId: f.schoolId },
});

describe("scheduleCancellation / reverseCancellation", () => {
  integrationTest("a Stripe-billed subscription is cancelled at Stripe", async () => {
    const f = await createBillingFixture(database!);
    const stripe = stripeSpy();

    const after = await scheduleCancellation(
      f.db.sql,
      { stripe: stripe.port, tap: null },
      { ...params(f), reason: "too expensive" },
    );
    await reverseCancellation(f.db.sql, { stripe: stripe.port, tap: null }, params(f));

    expect(after.cancelAtPeriodEnd).toBe(true);
    expect(stripe.calls).toEqual([
      `schedule:${f.stripeSubscriptionId}`,
      `reverse:${f.stripeSubscriptionId}`,
    ]);
  });

  integrationTest(
    "a Tap-billed subscription is cancelled locally, with no provider at all",
    async () => {
      const f = await createBillingFixture(database!);
      await rebill(f, "tap");

      const after = await scheduleCancellation(f.db.sql, { stripe: null, tap: null }, params(f));
      expect(after.cancelAtPeriodEnd).toBe(true);

      const reversed = await reverseCancellation(f.db.sql, { stripe: null, tap: null }, params(f));
      expect(reversed.cancelAtPeriodEnd).toBe(false);
      expect(reversed.retentionState).toBe("retained");
    },
  );

  integrationTest("a subscription no provider has billed cannot be cancelled", async () => {
    const f = await createBillingFixture(database!);
    await rebill(f, "none");

    const error: unknown = await scheduleCancellation(
      f.db.sql,
      { stripe: stripeSpy().port, tap: null },
      params(f),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).code).toBe("SUBSCRIPTION_NOT_LINKED_TO_PROVIDER");
  });
});
