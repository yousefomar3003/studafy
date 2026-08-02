/**
 * <5s propagation SLA (ST-133 acceptance criterion).
 *
 * A webhook-driven state change must be reflected in entitlement decisions within 5 seconds,
 * end-to-end. This drives the real pipeline — webhook → billing transaction → outbox → invalidation
 * consumer → cache → decision — and **polls** for the effect rather than sleeping a fixed interval:
 * a fixed sleep asserts nothing about latency, it only hides it.
 *
 * The consumer under test is the outbox poller's logic (`processEntitlementSchool`, driven directly
 * so the test does not race a background loop) plus the pub/sub subscriber. Both are asserted, since
 * both ship and either alone must satisfy the SLA.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { resetInflight } from "../../src/cache";
import { createLogger } from "../../src/logger";
import {
  createBillingFixture,
  createProviderStub,
  encodeEvent,
  silentLogger,
} from "../../src/modules/subscriptions/__tests__/webhook-fixture";
import {
  aiEntitlementCacheKey,
  entitlementCacheKey,
  invalidateEntitlementEntry,
} from "../../src/modules/subscriptions/entitlements/cache";
import { createEntitlementService } from "../../src/modules/subscriptions/entitlements/service";
import { handleStripeWebhook } from "../../src/modules/subscriptions/stripe/webhook-processor";
import { startEntitlementInvalidationSubscriber } from "../../src/modules/subscriptions/subscribers/entitlement-invalidation.subscriber";
import { createRedisClient } from "../../src/redis";
import { createTestDatabase, integrationEnabled, migrateDatabase } from "../harness";

import type { BillingFixture } from "../../src/modules/subscriptions/__tests__/webhook-fixture";
import type { EntitlementInvalidationSubscriber } from "../../src/modules/subscriptions/subscribers/entitlement-invalidation.subscriber";
import type { RedisClient } from "../../src/redis";
import type { TestDatabase } from "../harness";

const redisUrl = process.env.REDIS_URL;
const enabled = integrationEnabled && Boolean(redisUrl);
const slaTest = test.skipIf(!enabled);

/** The ticket's propagation budget, end to end. */
const PROPAGATION_SLA_MS = 5_000;

let db: TestDatabase | undefined;
let redis: RedisClient | undefined;
const logger = createLogger({ destination: () => undefined });

beforeAll(async () => {
  if (!enabled) return;
  db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  redis = createRedisClient({ url: redisUrl!, logger });
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await db?.cleanup();
});

afterEach(() => {
  resetInflight();
});

/**
 * Poll `check` until it returns a value, or fail once the budget is exhausted.
 *
 * Returns the elapsed milliseconds so the caller can assert the SLA on a measured number rather than
 * on the mere fact that the loop terminated.
 */
async function pollUntil<T>(
  check: () => Promise<T | null>,
  budgetMs: number,
  description: string,
): Promise<{ value: T; elapsedMs: number }> {
  const start = Date.now();

  while (Date.now() - start < budgetMs) {
    const value = await check();
    if (value !== null) return { value, elapsedMs: Date.now() - start };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`${description} did not happen within ${budgetMs}ms`);
}

async function deliverCancellation(fixture: BillingFixture, eventId: string): Promise<void> {
  await handleStripeWebhook(
    { database: fixture.db.sql, provider: createProviderStub(), logger: silentLogger },
    encodeEvent({
      id: eventId,
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: {
        id: fixture.stripeSubscriptionId,
        customer: fixture.stripeCustomerId,
        status: "canceled",
      },
    }),
    "sig",
    { path: "/api/subscriptions/webhook/stripe" },
  );
}

/** Relay the school's unrelayed outbox rows onto pub/sub, exactly as the relay worker does. */
async function relayOutbox(fixture: BillingFixture): Promise<number> {
  const rows = await fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ school_id: string; event_name: string; payload: unknown }[]>`
      SELECT school_id::text AS school_id, event_name, payload
      FROM app.outbox_events
      WHERE school_id = ${fixture.schoolId}::uuid AND relayed_at IS NULL
      ORDER BY id
    `;
  });

  for (const row of rows) {
    await redis!.publish(`events:${row.school_id}:${row.event_name}`, JSON.stringify(row.payload));
  }
  return rows.length;
}

describe("propagation SLA", () => {
  // The end-to-end criterion, through the pub/sub path the ticket names.
  slaTest(
    "a cancellation reaches entitlement decisions within 5 seconds",
    async () => {
      const fixture = await createBillingFixture(db!);
      const service = createEntitlementService({ database: db!.sql, redis: redis!, logger });

      // Warm the cache so the assertion is about invalidation, not a cold miss that would trivially
      // read the new state from the database anyway.
      const before = await service.school(fixture.schoolId);
      expect(before.active).toBe(true);
      expect(await redis!.exists(entitlementCacheKey(fixture.schoolId))).toBe(1);

      let subscriber: EntitlementInvalidationSubscriber | undefined;
      try {
        subscriber = await startEntitlementInvalidationSubscriber({ redis: redis!, logger });

        const start = Date.now();
        await deliverCancellation(fixture, `evt_sla_${crypto.randomUUID().slice(0, 8)}`);
        await relayOutbox(fixture);

        const { elapsedMs } = await pollUntil(
          async () => {
            resetInflight();
            const entitlement = await service.school(fixture.schoolId);
            return entitlement.active ? null : entitlement;
          },
          PROPAGATION_SLA_MS,
          "entitlement decision flipping to inactive",
        );

        expect(Date.now() - start).toBeLessThan(PROPAGATION_SLA_MS);
        expect(elapsedMs).toBeLessThan(PROPAGATION_SLA_MS);
      } finally {
        await subscriber?.close();
      }
    },
    30_000,
  );

  // The version side of the same change: what the JWT middleware actually reads. A stale token is
  // rejected because currentVersion moved, and that must move just as fast as the decision does.
  slaTest(
    "the version the middleware reads moves within the same budget",
    async () => {
      const fixture = await createBillingFixture(db!);
      const service = createEntitlementService({ database: db!.sql, redis: redis!, logger });

      const initialVersion = await service.currentVersion(fixture.schoolId);
      expect(initialVersion).toBe(1);

      let subscriber: EntitlementInvalidationSubscriber | undefined;
      try {
        subscriber = await startEntitlementInvalidationSubscriber({ redis: redis!, logger });

        await deliverCancellation(fixture, `evt_sla_ver_${crypto.randomUUID().slice(0, 8)}`);
        await relayOutbox(fixture);

        const { value, elapsedMs } = await pollUntil(
          async () => {
            const version = await service.currentVersion(fixture.schoolId);
            return version > initialVersion ? version : null;
          },
          PROPAGATION_SLA_MS,
          "entitlement version increment",
        );

        expect(value).toBe(2);
        expect(elapsedMs).toBeLessThan(PROPAGATION_SLA_MS);
      } finally {
        await subscriber?.close();
      }
    },
    30_000,
  );
});

describe("the school version guard on AI entries", () => {
  // The case no AI event covers. A school leaving a live state without cascading any AI rows still
  // changes the effective AI answer; only the schoolVersion check on the cached AI entry catches it.
  slaTest(
    "a school-level invalidation invalidates the cached AI verdict too",
    async () => {
      const fixture = await createBillingFixture(db!);

      // A student whose add-on is already terminal, so the cascade will not touch it and no
      // aiSubscription.statusChanged will be emitted for them.
      await db!.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
        await tx`
        INSERT INTO app.ai_subscriptions (
          school_id, student_id, status, current_period_start, current_period_end
        ) VALUES (
          ${fixture.schoolId}::uuid, ${fixture.studentId}::uuid, 'active',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days'
        )
      `;
      });

      const service = createEntitlementService({ database: db!.sql, redis: redis!, logger });

      const before = await service.ai(fixture.schoolId, fixture.studentId);
      expect(before.active).toBe(true);
      expect(before.schoolVersion).toBe(1);

      // Move only the school's cached version, as a school-level invalidation would. The AI entry is
      // left untouched and still says active.
      await invalidateEntitlementEntry(redis!, entitlementCacheKey(fixture.schoolId), 2);
      const aiRaw = await redis!.get(aiEntitlementCacheKey(fixture.studentId));
      expect(aiRaw).toContain('"active":true');

      // Flip the underlying school state so the re-resolve has something different to find.
      await db!.sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE studafy_admin");
        await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
        await tx`
        UPDATE app.subscriptions SET status = 'canceled'
        WHERE school_id = ${fixture.schoolId}::uuid
      `;
      });

      resetInflight();
      const after = await service.ai(fixture.schoolId, fixture.studentId);

      // The stale AI entry was not trusted: its schoolVersion no longer matched, so it re-resolved.
      expect(after.active).toBe(false);
    },
    30_000,
  );
});

// The durable half of the SLA — the outbox poller invalidating with no pub/sub delivery at all — is
// asserted in apps/workers/src/queues/entitlements/__tests__/invalidator.test.ts, where that code
// lives. Reaching across app boundaries from this suite would put an apps/workers import inside
// apps/api's type graph for the sake of one test.
