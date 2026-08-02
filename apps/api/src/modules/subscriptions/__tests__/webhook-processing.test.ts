/**
 * End-to-end webhook processing against a real database (ST-132).
 *
 * Covers three of the four acceptance criteria — replayed events processed exactly once, out-of-order
 * sequences converging, every transition audited — plus the concurrent-redelivery race and the
 * illegal-transition parking behaviour. The fourth (signature failure returns 400 and alerts) needs
 * the HTTP stack and lives in webhook-signature.test.ts.
 *
 * These drive `handleStripeWebhook` directly rather than through Hono. The route is one `await` and
 * a `c.json`; what is worth exercising here is the transaction, the RLS-forced tables and the audit
 * writes, and going through HTTP would only add a token-minting step to every case.
 */

import { processBillingEvent } from "@studafy/billing";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { integrationEnabled } from "../../../../tests/harness";
import { withSystemTx } from "../../../db/tenant-tx";
import { publishEntitlementChange } from "../entitlements/entitlement-change-publisher";
import { handleStripeWebhook } from "../stripe/webhook-processor";

import {
  createBillingDatabase,
  createBillingFixture,
  createProviderStub,
  encodeEvent,
  readAuditRows,
  readBillingEvents,
  readAiSubscriptionStatuses,
  readSubscriptionStatus,
  resetBillingEvents,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture, StubEventInput } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";

const integrationTest = test.skipIf(!integrationEnabled);
const CONTEXT = { path: "/api/subscriptions/webhook/stripe", requestId: null };

// One migrated database for the whole file; a fresh school per test. Migrating 79 files per test
// costs seconds each and would make every case race Bun's default timeout — see webhook-fixture.ts.
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

function setup(): Promise<BillingFixture> {
  return createBillingFixture(database!);
}

function deliver(f: BillingFixture, event: StubEventInput) {
  return handleStripeWebhook(
    { database: f.db.sql, provider: createProviderStub(), logger: silentLogger },
    encodeEvent(event),
    "t=1,v1=stub",
    CONTEXT,
  );
}

/** A subscription event carrying the fixture's provider ids. */
function subscriptionEvent(
  f: BillingFixture,
  id: string,
  created: number,
  status: string,
): StubEventInput {
  return {
    id,
    type: "customer.subscription.updated",
    created,
    data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status },
  };
}

function invoiceEvent(
  f: BillingFixture,
  id: string,
  created: number,
  type: string,
): StubEventInput {
  return {
    id,
    type,
    created,
    data: { id: `in_${id}`, customer: f.stripeCustomerId, subscription: f.stripeSubscriptionId },
  };
}

describe("replay idempotency", () => {
  integrationTest("the same event delivered twice transitions state once", async () => {
    const f = await setup();
    const event = subscriptionEvent(f, "evt_replay", 1_700_000_100, "active");

    const first = await deliver(f, event);
    const second = await deliver(f, event);

    expect(first).toEqual({ received: true, outcome: "processed" });
    expect(second).toEqual({ received: true, outcome: "duplicate" });

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");

    const events = await readBillingEvents(f);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider_event_id: "evt_replay", status: "processed" });

    // The state transition happened exactly once, which is the assertion that would have failed
    // against the pre-ST-132 processor's SELECT-then-INSERT.
    const audits = await readAuditRows(f);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ old_values: { status: "trialing" } });
  });

  // The bug this ticket exists to fix: two distinct events describing one subscription. Keyed on the
  // object id (`sub_…`) they collide and the second is dropped; keyed on the event id they do not.
  integrationTest("two events about one subscription are not mistaken for a replay", async () => {
    const f = await setup();

    await deliver(f, subscriptionEvent(f, "evt_one", 1_700_000_100, "active"));
    await deliver(f, subscriptionEvent(f, "evt_two", 1_700_000_200, "past_due"));

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("past_due");
    expect(await readBillingEvents(f)).toHaveLength(2);
  });
});

describe("concurrent redelivery", () => {
  integrationTest("only one of two simultaneous deliveries wins", async () => {
    const f = await setup();
    const event = subscriptionEvent(f, "evt_race", 1_700_000_100, "active");

    const results = await Promise.all([deliver(f, event), deliver(f, event)]);
    const outcomes = results.map((r) => r.outcome).sort();

    // The loser blocks on uq_billing_events_provider_event_id until the winner commits, then its
    // ON CONFLICT DO NOTHING returns no row and it exits cleanly. No application-level mutex.
    expect(outcomes).toEqual(["duplicate", "processed"]);
    expect(await readBillingEvents(f)).toHaveLength(1);
    expect(await readAuditRows(f)).toHaveLength(1);
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");
  });
});

describe("out-of-order convergence", () => {
  // The end-to-end counterpart to packages/billing's exhaustive permutation test: the same property,
  // asserted through the real fold query and its ORDER BY rather than against an in-memory sort.
  const ARRIVAL_ORDERS = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
    [2, 0, 1],
    [1, 0, 2],
    [0, 2, 1],
  ] as const;

  for (const order of ARRIVAL_ORDERS) {
    integrationTest(`arrival order ${order.join(",")} converges to canceled`, async () => {
      const f = await setup();

      // Effective order: activate (T1), cancel (T2), then a renewal (T3) that cannot legally follow
      // a cancellation. Whatever order these arrive in, the fold must end canceled.
      const timeline: StubEventInput[] = [
        subscriptionEvent(f, "evt_a_activate", 1_700_000_100, "active"),
        subscriptionEvent(f, "evt_b_cancel", 1_700_000_200, "canceled"),
        invoiceEvent(f, "evt_c_renew", 1_700_000_300, "invoice.paid"),
      ];

      for (const index of order) {
        await deliver(f, timeline[index]!);
      }

      expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("canceled");
    });
  }

  integrationTest("a stale event arriving last does not regress state", async () => {
    const f = await setup();

    // Newest first, then an older activation. Applying by receipt time would leave it `active`.
    await deliver(f, subscriptionEvent(f, "evt_new_cancel", 1_700_000_900, "canceled"));
    await deliver(f, subscriptionEvent(f, "evt_old_active", 1_700_000_100, "active"));

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("canceled");
  });
});

describe("audit", () => {
  integrationTest("every transition writes an audit row with before and after", async () => {
    const f = await setup();

    await deliver(f, subscriptionEvent(f, "evt_1", 1_700_000_100, "active"));
    await deliver(f, subscriptionEvent(f, "evt_2", 1_700_000_200, "past_due"));

    const audits = await readAuditRows(f);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      target_table: "subscriptions",
      target_id: f.subscriptionId,
      old_values: { status: "trialing" },
      new_values: { status: "active" },
    });
    expect(audits[1]).toMatchObject({
      old_values: { status: "active" },
      new_values: { status: "past_due" },
    });

    // Machine-written: setTenantScope deliberately leaves app.user_id unset, so no person is
    // credited with a change no person made.
    expect(audits.every((row) => row.actor_id === null)).toBe(true);
  });

  integrationTest("a no-op transition writes no audit row", async () => {
    const f = await setup();

    await deliver(f, subscriptionEvent(f, "evt_1", 1_700_000_100, "active"));
    await deliver(f, subscriptionEvent(f, "evt_2", 1_700_000_200, "active"));

    expect(await readAuditRows(f)).toHaveLength(1);
  });

  // The coupling ST-132 requires: if the audit write fails, the transition must not survive it.
  //
  // Asserted against `processBillingEvent` with a throwing audit writer rather than against
  // `handleStripeWebhook` with a raising database trigger. The coupling *is* the shared core's
  // transaction, and injecting the failure at the audit port tests exactly that, with no dependence
  // on DDL or on how the API layer records a transient failure afterwards. It also states the
  // guarantee in the terms the port defines it — "must throw on failure" — rather than in terms of
  // one particular way the database might refuse a write.
  integrationTest("an audit write failure rolls the transition back", async () => {
    const f = await setup();

    // Its own single connection, closed before the assertions run. postgres.js destroys a pooled
    // connection whose transaction callback rejects, and a destroyed connection handed back to the
    // fixture's pool makes the *next* query fail for an unrelated reason — which would report as a
    // failure of whatever ran afterwards rather than of anything real.
    const isolated = postgres(f.db.url, { max: 1, ssl: false, prepare: false });

    try {
      await expect(
        withSystemTx(isolated, (tx) =>
          processBillingEvent(
            tx,
            {
              id: "evt_audit_fail",
              type: "customer.subscription.updated",
              effectiveAt: new Date(1_700_000_100 * 1000),
              data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "active" },
            },
            {
              emitAudit: () => Promise.reject(new Error("audit write refused")),
              publishEntitlementChange,
              logger: silentLogger,
            },
          ),
        ),
      ).rejects.toThrow("audit write refused");
    } finally {
      await isolated.end({ timeout: 5 });
    }

    // Both the status change and the claim rolled back, so the next delivery is a fresh attempt
    // rather than an event permanently marked seen but never applied.
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
    expect(await readBillingEvents(f)).toHaveLength(0);
  });
});

describe("parking", () => {
  integrationTest("an illegal transition is parked, not applied", async () => {
    const f = await setup();

    await deliver(f, subscriptionEvent(f, "evt_cancel", 1_700_000_100, "canceled"));
    const result = await deliver(f, subscriptionEvent(f, "evt_revive", 1_700_000_200, "active"));

    expect(result.outcome).toBe("parked");
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("canceled");

    const parked = (await readBillingEvents(f)).find((e) => e.provider_event_id === "evt_revive");
    expect(parked?.status).toBe("dlq");
    expect(parked?.last_error).toContain("Illegal transition");
  });

  integrationTest("an unmapped event type is parked with its payload intact", async () => {
    const f = await setup();

    const result = await deliver(f, {
      id: "evt_unknown",
      type: "billing.something.brand_new",
      created: 1_700_000_100,
      data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId },
    });

    expect(result.outcome).toBe("parked");
    const parked = (await readBillingEvents(f))[0];
    expect(parked?.status).toBe("dlq");
    expect(parked?.last_error).toContain("No handler mapping");
    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
  });

  integrationTest("an unattributable event is parked", async () => {
    const f = await setup();

    const result = await deliver(f, {
      id: "evt_orphan",
      type: "invoice.paid",
      created: 1_700_000_100,
      data: { id: "in_orphan", customer: "cus_nobody_knows_this_one" },
    });

    expect(result.outcome).toBe("parked");
    expect((await readBillingEvents(f))[0]?.last_error).toContain("attribute");
  });

  integrationTest("a known-but-uninteresting event is processed, not parked", async () => {
    const f = await setup();

    const result = await deliver(f, {
      id: "evt_charge",
      type: "charge.succeeded",
      created: 1_700_000_100,
      data: { id: "ch_1", customer: f.stripeCustomerId },
    });

    expect(result.outcome).toBe("processed");
    expect((await readBillingEvents(f))[0]?.status).toBe("processed");
    expect(await readAuditRows(f)).toHaveLength(0);
  });
});

describe("cross-entity cascade", () => {
  integrationTest("closing a school cancels its AI subscriptions, audited", async () => {
    const f = await setup();

    // Buy the AI add-on, then cancel the school subscription.
    await deliver(f, {
      id: "evt_ai_checkout",
      type: "checkout.session.completed",
      created: 1_700_000_100,
      data: {
        id: "cs_1",
        customer: f.stripeCustomerId,
        subscription: `sub_ai_${f.studentId.slice(0, 8)}`,
        mode: "subscription",
        metadata: { school_id: f.schoolId, student_id: f.studentId },
      },
    });

    await deliver(f, subscriptionEvent(f, "evt_school_cancel", 1_700_000_200, "canceled"));

    expect(await readAiSubscriptionStatuses(f)).toEqual(["canceled"]);

    // Two AI audit rows: the checkout activating the entitlement, then the cascade withdrawing it.
    // The cascade is audited per affected student because "why did this stop working" is answered
    // from app.audit_logs or not at all.
    const aiAudit = (await readAuditRows(f)).filter((r) => r.target_table === "ai_subscriptions");
    expect(aiAudit).toHaveLength(2);
    expect(aiAudit.at(-1)).toMatchObject({
      old_values: { status: "active" },
      new_values: { status: "canceled" },
    });
  });
});
