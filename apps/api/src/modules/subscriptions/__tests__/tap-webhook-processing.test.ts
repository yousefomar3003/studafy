/**
 * Tap webhooks through the shared billing pipeline, against a real database (ST-298).
 *
 * Nothing here is stubbed below the HTTP client: a real `TapAdapter` verifies a real `hashstring`,
 * re-reads the charge from a fake Tap API, normalizes it, and `handleBillingWebhook` applies it
 * with real SQL, RLS and audit rows -- the same processor the Stripe suite drives. What is under
 * test is that a Tap charge lands in the same state machine with the same idempotency guarantees.
 */

import { computeTapHashString } from "@studafy/tap-payments";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { TapAdapter } from "../tap/adapter";
import { handleBillingWebhook } from "../webhooks/webhook-processor";

import {
  createBillingDatabase,
  createBillingFixture,
  readAuditRows,
  readSubscriptionStatus,
  resetBillingEvents,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { BillingEventRetryEnqueuer, FeePaymentSettler } from "../webhooks/webhook-processor";
import type { TapCharge } from "@studafy/tap-payments";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);
const SECRET = "sk_test_tap_pipeline";
const CONTEXT = { path: "/api/subscriptions/webhook/tap", requestId: null };

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

afterEach(async () => {
  if (database) await resetBillingEvents(database);
});

let chargeSequence = 0;

function tapCharge(f: BillingFixture, overrides: Partial<TapCharge> = {}): TapCharge {
  chargeSequence += 1;
  return {
    id: `chg_TS${chargeSequence.toString().padStart(6, "0")}`,
    object: "charge",
    live_mode: false,
    status: "CAPTURED",
    amount: 15.5,
    currency: "JOD",
    customer: { id: f.tapCustomerId },
    metadata: { billing_reason: "subscription_create" },
    reference: { gateway: "g", payment: "p" },
    transaction: { created: String(1_727_251_200_000 + chargeSequence * 1000) },
    ...overrides,
  };
}

/** A real adapter whose Tap API holds exactly the given charges. */
function tapAdapterServing(...charges: TapCharge[]): TapAdapter {
  const byPath = new Map(charges.map((c) => [`/v2/charges/${c.id}`, c]));
  return new TapAdapter({
    secretKey: SECRET,
    webhookUrl: "https://api.studafy.test/api/subscriptions/webhook/tap",
    baseUrl: "https://tap.test/v2",
    fetch: (async (input: string | URL | Request) => {
      const charge = byPath.get(new URL(String(input)).pathname);
      return charge
        ? new Response(JSON.stringify(charge), { status: 200 })
        : new Response("{}", { status: 404 });
    }) as typeof fetch,
  });
}

function deliver(
  f: BillingFixture,
  charge: TapCharge,
  options: {
    signature?: string;
    enqueueRetry?: BillingEventRetryEnqueuer;
    settleFeePayment?: FeePaymentSettler;
  } = {},
) {
  return handleBillingWebhook(
    {
      database: f.db.sql,
      providerName: "tap",
      provider: tapAdapterServing(charge),
      logger: silentLogger,
      enqueueRetry: options.enqueueRetry,
      settleFeePayment: options.settleFeePayment,
    },
    Buffer.from(JSON.stringify(charge)),
    options.signature ?? computeTapHashString(charge, SECRET),
    CONTEXT,
  );
}

async function readTapLedger(f: BillingFixture) {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const rows = await tx<
      { provider: string; provider_event_id: string; event_type: string; status: string }[]
    >`
      SELECT provider, provider_event_id, event_type, status::text AS status
      FROM app.billing_events
      ORDER BY effective_at, provider_event_id
    `;
    return [...rows];
  });
}

describe("Tap webhook -> shared billing pipeline", () => {
  integrationTest("a captured checkout charge activates the school subscription", async () => {
    const f = await createBillingFixture(database!);
    const charge = tapCharge(f);

    const result = await deliver(f, charge);

    expect(result).toEqual({ received: true, outcome: "processed" });
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");
    expect(await readTapLedger(f)).toEqual([
      {
        provider: "tap",
        provider_event_id: `${charge.id}:CAPTURED`,
        event_type: "checkout.session.completed",
        status: "processed",
      },
    ]);
    const audit = await readAuditRows(f);
    expect(audit.map((row) => [row.old_values.status, row.new_values.status])).toEqual([
      ["trialing", "active"],
    ]);
  });

  integrationTest("a redelivered charge is a duplicate and changes nothing", async () => {
    const f = await createBillingFixture(database!);
    const charge = tapCharge(f);

    await deliver(f, charge);
    const second = await deliver(f, charge);

    expect(second.outcome).toBe("duplicate");
    expect(await readTapLedger(f)).toHaveLength(1);
    expect(await readAuditRows(f)).toHaveLength(1);
  });

  integrationTest("concurrent redeliveries apply exactly once", async () => {
    const f = await createBillingFixture(database!);
    const charge = tapCharge(f);

    const outcomes = await Promise.all([
      deliver(f, charge),
      deliver(f, charge),
      deliver(f, charge),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["duplicate", "duplicate", "processed"]);
    expect(await readAuditRows(f)).toHaveLength(1);
  });

  integrationTest(
    "INITIATED then CAPTURED on one charge are two events, not a replay",
    async () => {
      const f = await createBillingFixture(database!);
      const captured = tapCharge(f);
      const initiated = { ...captured, status: "INITIATED" };

      expect((await deliver(f, initiated)).outcome).toBe("processed");
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");

      expect((await deliver(f, captured)).outcome).toBe("processed");
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");
      expect((await readTapLedger(f)).map((row) => row.provider_event_id).sort()).toEqual(
        [`${captured.id}:CAPTURED`, `${captured.id}:INITIATED`].sort(),
      );
    },
  );

  integrationTest("a declined renewal moves an active subscription to past_due", async () => {
    const f = await createBillingFixture(database!);
    await deliver(f, tapCharge(f));

    await deliver(
      f,
      tapCharge(f, { status: "DECLINED", metadata: { billing_reason: "subscription_cycle" } }),
    );

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("past_due");
  });

  integrationTest("a fee charge is recorded but never touches the subscription", async () => {
    const f = await createBillingFixture(database!);

    const result = await deliver(f, tapCharge(f, { metadata: { purpose: "tuition_fee" } }));

    expect(result.outcome).toBe("processed");
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
    expect(await readAuditRows(f)).toHaveLength(0);
  });

  integrationTest(
    "attribution uses tap_customer_id, never the school's Stripe customer id",
    async () => {
      const f = await createBillingFixture(database!);

      // Tap and Stripe both mint `cus_` ids. A Tap event naming this school's *Stripe* customer,
      // with no metadata to fall back on, must not be attributed to it.
      const result = await deliver(f, tapCharge(f, { customer: { id: f.stripeCustomerId } }));

      expect(result.outcome).toBe("parked");
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
    },
  );

  integrationTest("a bad hashstring is a 400 and leaves no ledger row", async () => {
    const f = await createBillingFixture(database!);

    const error: unknown = await deliver(f, tapCharge(f), { signature: "0".repeat(64) }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).status).toBe(400);
    expect((error as CodedHttpException).code).toBe("TAP_WEBHOOK_INVALID");
    expect(await readTapLedger(f)).toHaveLength(0);
  });

  integrationTest(
    "a transient failure rolls back, enqueues a Tap retry, and the redelivery applies once",
    async () => {
      const f = await createBillingFixture(database!);
      const charge = tapCharge(f);
      const enqueued: { provider: string; providerEventId: string }[] = [];
      const enqueueRetry: BillingEventRetryEnqueuer = async (job) => {
        enqueued.push(job);
      };

      // A trigger that refuses this school's subscription update stands in for a lock timeout:
      // the failure happens mid-transaction, after the claim, which is the case that matters.
      await withAdmin(f, async (tx) => {
        await tx.unsafe(`
          CREATE OR REPLACE FUNCTION app.test_refuse_subscription_update() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated transient failure'; END $$;
        `);
        await tx.unsafe(`
          CREATE TRIGGER test_refuse_subscription_update BEFORE UPDATE ON app.subscriptions
          FOR EACH ROW WHEN (OLD.id = '${f.subscriptionId}'::uuid)
          EXECUTE FUNCTION app.test_refuse_subscription_update();
        `);
      });

      try {
        await expect(deliver(f, charge, { enqueueRetry })).rejects.toThrow(
          "simulated transient failure",
        );
      } finally {
        await withAdmin(f, async (tx) => {
          await tx.unsafe("DROP TRIGGER test_refuse_subscription_update ON app.subscriptions");
          await tx.unsafe("DROP FUNCTION app.test_refuse_subscription_update()");
        });
      }

      // The claim rolled back with the failure: no half-applied row, and a retry keyed on Tap.
      expect(await readTapLedger(f)).toHaveLength(0);
      expect(enqueued).toEqual([{ provider: "tap", providerEventId: `${charge.id}:CAPTURED` }]);
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");

      // Tap redelivers; this time it applies, exactly once.
      expect((await deliver(f, charge)).outcome).toBe("processed");
      expect((await deliver(f, charge)).outcome).toBe("duplicate");
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");
      expect(await readAuditRows(f)).toHaveLength(1);
    },
  );
});

async function withAdmin(
  f: BillingFixture,
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  await f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await fn(tx);
  });
}

async function readSubscriptionBilling(f: BillingFixture) {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    const [row] = await tx<
      { tap_card_id: string | null; tap_payment_agreement_id: string | null; period_end: Date }[]
    >`
      SELECT tap_card_id, tap_payment_agreement_id, current_period_end AS period_end
      FROM app.subscriptions WHERE id = ${f.subscriptionId}::uuid
    `;
    return row!;
  });
}

describe("Tap webhook -> renewal prerequisites and fee routing", () => {
  integrationTest(
    "a captured first charge stores the saved card and opens the period",
    async () => {
      const f = await createBillingFixture(database!);
      const charge = tapCharge(f, {
        metadata: { billing_reason: "subscription_create", billing_interval: "monthly" },
        card: { id: "card_TS_first" },
        payment_agreement: { id: "payment_agreement_TS_first" },
      });

      await deliver(f, charge);

      const row = await readSubscriptionBilling(f);
      expect(row.tap_card_id).toBe("card_TS_first");
      expect(row.tap_payment_agreement_id).toBe("payment_agreement_TS_first");
      const created = Number(charge.transaction!.created);
      const expectedEnd = new Date(created);
      expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1);
      expect(row.period_end.getTime()).toBe(Math.floor(expectedEnd.getTime() / 1000) * 1000);
    },
  );

  integrationTest("a paid renewal advances the period to the one it paid for", async () => {
    const f = await createBillingFixture(database!);
    await deliver(f, tapCharge(f));

    await deliver(
      f,
      tapCharge(f, {
        metadata: {
          billing_reason: "subscription_cycle",
          period_start: "1893456000",
          period_end: "1896134400",
        },
      }),
    );

    expect((await readSubscriptionBilling(f)).period_end.toISOString()).toBe(
      "2030-02-01T00:00:00.000Z",
    );
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");
  });

  integrationTest(
    "a fee payment is handed to the settler and never reaches the state machine",
    async () => {
      const f = await createBillingFixture(database!);
      const seen: string[] = [];
      const settleFeePayment: FeePaymentSettler = async (provider, event) => {
        seen.push(`${provider}:${event.type}`);
        return "processed";
      };

      const result = await deliver(
        f,
        tapCharge(f, { metadata: { purpose: "fee_payment", school_id: f.schoolId } }),
        { settleFeePayment },
      );

      expect(result.outcome).toBe("processed");
      expect(seen).toEqual(["tap:charge.succeeded"]);
      expect(await readTapLedger(f)).toHaveLength(0);
      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
    },
  );

  integrationTest("a fee payment with no settler wired answers 503 for redelivery", async () => {
    const f = await createBillingFixture(database!);
    const error: unknown = await deliver(
      f,
      tapCharge(f, { metadata: { purpose: "fee_payment", school_id: f.schoolId } }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).status).toBe(503);
    expect(await readTapLedger(f)).toHaveLength(0);
  });
});
