/**
 * The entitlement write path (ST-133).
 *
 * Asserts what the billing transaction *publishes*, not what any cache later does with it: the outbox
 * rows, the version counters, and the atomicity that ties both to the status change. The consumer
 * side is covered by tests/entitlements/propagation.test.ts and the workers invalidator suite.
 *
 * Driven through `handleStripeWebhook` with the shared provider stub, so the whole real pipeline runs
 * — claim, attribute, fold, apply, audit, bump, emit — inside one real transaction under real RLS.
 */

import { processBillingEvent } from "@studafy/billing";
import { DOMAIN_EVENTS } from "@studafy/constants";
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
  readSubscriptionStatus,
  resetBillingEvents,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture, StubEventInput } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";

const integrationTest = test.skipIf(!integrationEnabled);

let db: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createBillingDatabase();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  if (db) await resetBillingEvents(db);
});

async function setup(): Promise<BillingFixture> {
  return createBillingFixture(db!);
}

async function deliver(fixture: BillingFixture, event: StubEventInput): Promise<void> {
  const provider = createProviderStub();
  await handleStripeWebhook(
    { database: fixture.db.sql, provider, logger: silentLogger },
    encodeEvent(event),
    "sig",
    { path: "/api/subscriptions/webhook/stripe" },
  );
}

interface OutboxRow {
  event_name: string;
  payload: {
    schoolId: string;
    studentId?: string;
    subscriptionId?: string;
    aiSubscriptionId?: string;
    previousStatus: string;
    status: string;
    entitlementsVersion: number;
  };
}

async function readOutbox(fixture: BillingFixture): Promise<OutboxRow[]> {
  return fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<OutboxRow[]>`
      SELECT event_name, payload
      FROM app.outbox_events
      WHERE school_id = ${fixture.schoolId}::uuid
      ORDER BY id
    `;
  });
}

async function readVersions(
  fixture: BillingFixture,
): Promise<{ subject_type: string; subject_id: string; version: number }[]> {
  const rows = await fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ subject_type: string; subject_id: string; version: string }[]>`
      SELECT subject_type::text AS subject_type, subject_id::text AS subject_id, version::text AS version
      FROM app.entitlement_versions
      WHERE school_id = ${fixture.schoolId}::uuid
      ORDER BY subject_type, subject_id
    `;
  });
  return rows.map((r) => ({ ...r, version: Number(r.version) }));
}

/** Seed a live AI add-on for a second student, so a cascade has more than one row to move. */
async function seedAiSubscription(fixture: BillingFixture, studentId: string): Promise<string> {
  const rows = await fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions (
        school_id, student_id, status, current_period_start, current_period_end
      ) VALUES (
        ${fixture.schoolId}::uuid, ${studentId}::uuid, 'active',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days'
      )
      RETURNING id
    `;
  });
  return rows[0]!.id;
}

describe("entitlement events", () => {
  integrationTest("a school transition emits one event and bumps the school version", async () => {
    const f = await setup();

    await deliver(f, {
      id: "evt_ent_school_activate",
      type: "customer.subscription.updated",
      created: 1_700_000_100,
      data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "active" },
    });

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("active");

    const outbox = await readOutbox(f);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.event_name).toBe(DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED);
    expect(outbox[0]!.payload).toMatchObject({
      schoolId: f.schoolId,
      subscriptionId: f.subscriptionId,
      previousStatus: "trialing",
      status: "active",
      // First bump writes 2 — an absent row is the genesis version 1.
      entitlementsVersion: 2,
    });

    expect(await readVersions(f)).toEqual([
      { subject_type: "school", subject_id: f.schoolId, version: 2 },
    ]);
  });

  // The cross-entity half of the state machine. A school leaving a live state drags its AI add-ons
  // with it, and each cascaded student is an entitlement change in its own right — one event and one
  // counter each, so a student's cache can be invalidated without touching the whole school's.
  integrationTest("a school cancellation emits one event per cascaded AI row", async () => {
    const f = await setup();
    const aiId = await seedAiSubscription(f, f.studentId);

    await deliver(f, {
      id: "evt_ent_school_cancel",
      type: "customer.subscription.deleted",
      created: 1_700_000_200,
      data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "canceled" },
    });

    const outbox = await readOutbox(f);
    expect(outbox.map((row) => row.event_name)).toEqual([
      DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED,
      DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED,
    ]);

    expect(outbox[1]!.payload).toMatchObject({
      schoolId: f.schoolId,
      studentId: f.studentId,
      aiSubscriptionId: aiId,
      previousStatus: "active",
      entitlementsVersion: 2,
    });

    // Two independent counters, each at its own first bump. The school's change did NOT bump the
    // student's counter beyond the one the cascade caused, and vice versa.
    expect(await readVersions(f)).toEqual([
      { subject_type: "ai", subject_id: f.studentId, version: 2 },
      { subject_type: "school", subject_id: f.schoolId, version: 2 },
    ]);
  });

  // The guard at the top of applyTransition is load-bearing: a redelivery that folds to the status
  // already stored must not churn the cache or invalidate anyone's token.
  integrationTest("a no-op transition emits nothing and bumps nothing", async () => {
    const f = await setup();

    await deliver(f, {
      id: "evt_ent_noop",
      type: "customer.subscription.updated",
      created: 1_700_000_300,
      // Already 'trialing' — folds to the status it is in.
      data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "trialing" },
    });

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
    expect(await readOutbox(f)).toHaveLength(0);
    expect(await readVersions(f)).toHaveLength(0);
  });

  // Redelivery of the same provider event is dropped by the claim on
  // uq_billing_events_provider_event_id before applyTransition is ever reached, so the version moves
  // exactly once no matter how many times Stripe sends it.
  integrationTest("redelivery of the same event bumps the version only once", async () => {
    const f = await setup();

    const event: StubEventInput = {
      id: "evt_ent_redelivery",
      type: "customer.subscription.updated",
      created: 1_700_000_400,
      data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "active" },
    };

    await deliver(f, event);
    await deliver(f, event);
    await deliver(f, event);

    expect(await readOutbox(f)).toHaveLength(1);
    expect(await readVersions(f)).toEqual([
      { subject_type: "school", subject_id: f.schoolId, version: 2 },
    ]);
  });

  // The mirror of webhook-processing.test.ts's audit-writer assertion, at the other injected port.
  // An entitlement change that could not be published must take the status change down with it:
  // committing one without the other would leave every cache and every outstanding token believing
  // the old state, with nothing left to correct them.
  integrationTest("a publisher failure rolls the transition back", async () => {
    const f = await setup();

    // Its own single connection, closed before the assertions run — postgres.js destroys a pooled
    // connection whose transaction callback rejects, and handing that back to the fixture's pool
    // makes the *next* query fail for an unrelated reason.
    const isolated = postgres(f.db.url, { max: 1, ssl: false, prepare: false });

    try {
      await expect(
        withSystemTx(isolated, (tx) =>
          processBillingEvent(
            tx,
            {
              id: "evt_ent_publish_fail",
              type: "customer.subscription.updated",
              effectiveAt: new Date(1_700_000_500 * 1000),
              data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "active" },
            },
            {
              emitAudit: () => Promise.resolve(),
              publishEntitlementChange: () =>
                Promise.reject(new Error("entitlement publish refused")),
              logger: silentLogger,
            },
          ),
        ),
      ).rejects.toThrow("entitlement publish refused");
    } finally {
      await isolated.end({ timeout: 5 });
    }

    expect(await readSubscriptionStatus(f, f.subscriptionId)).toBe("trialing");
    expect(await readOutbox(f)).toHaveLength(0);
    expect(await readVersions(f)).toHaveLength(0);
  });

  // Race safety under concurrent redelivery. Two *different* provider events for the same school
  // race on one counter row: INSERT ... ON CONFLICT DO UPDATE takes the row lock within the
  // statement, so the second transaction re-evaluates against the newly committed tuple rather than
  // losing an update or raising a duplicate-key error.
  integrationTest("concurrent transitions leave the version monotonic", async () => {
    const f = await setup();

    await Promise.all([
      deliver(f, {
        id: "evt_ent_race_a",
        type: "customer.subscription.updated",
        created: 1_700_000_600,
        data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "active" },
      }),
      deliver(f, {
        id: "evt_ent_race_b",
        type: "customer.subscription.updated",
        created: 1_700_000_700,
        data: { id: f.stripeSubscriptionId, customer: f.stripeCustomerId, status: "past_due" },
      }),
    ]);

    const versions = await readVersions(f);
    expect(versions).toHaveLength(1);
    // Both events changed the status, so both bumped: 1 (genesis) + 2. The exact value is not the
    // guarantee — monotonicity is — but a lost update would show up here as 2.
    expect(versions[0]!.version).toBe(3);
    expect(await readOutbox(f)).toHaveLength(2);
  });
});
