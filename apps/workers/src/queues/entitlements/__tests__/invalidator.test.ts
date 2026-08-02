/**
 * The durable entitlement invalidator (ST-133).
 *
 * This consumer is what the <5s propagation SLA actually rests on: Redis pub/sub is fire-and-forget,
 * so the API-side subscriber can lose a message when a pod restarts mid-deploy, whereas these rows
 * are claimed through a cursor and cannot be lost. The properties worth holding are therefore about
 * *durability*, not speed — nothing is marked consumed unless its invalidation landed, and a
 * consumed row is never re-claimed.
 *
 * Seeds outbox rows directly rather than driving a Stripe webhook: the producer side is covered by
 * apps/api's entitlement-events suite, and this file is about what the consumer does with a row that
 * already exists.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import IORedis from "ioredis";
import postgres from "postgres";

import { processEntitlementSchool } from "../invalidator";

import type { EntitlementInvalidatorContext } from "../invalidator";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const enabled = Boolean(databaseUrl) && Boolean(redisUrl);
const invalidatorTest = test.skipIf(!enabled);

let db: Sql | undefined;
let redis: IORedis | undefined;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
  redis = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  redis?.disconnect();
  await db?.end({ timeout: 5 });
});

function context(overrides: Partial<EntitlementInvalidatorContext> = {}) {
  return {
    db: db!,
    redis: redis!,
    config: { batchSize: 100, pollIntervalMs: 500, concurrency: 4 },
    logger: silentLogger,
    ...overrides,
  } as EntitlementInvalidatorContext;
}

/** A school with nothing but its identity — this consumer never reads subscription rows. */
async function seedSchool(): Promise<string> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;
    const slug = `inv-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Invalidator ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    return school!.id;
  });
}

async function seedOutboxRow(
  schoolId: string,
  eventName: string,
  payload: Record<string, string | number>,
): Promise<string> {
  const rows = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ id: string }[]>`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (${schoolId}::uuid, ${eventName}, ${tx.json(payload)})
      RETURNING id::text AS id
    `;
  });
  return rows[0]!.id;
}

async function readCursor(schoolId: string, id: string): Promise<string | null> {
  const rows = await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return tx<{ applied: string | null }[]>`
      SELECT entitlement_applied_at::text AS applied
      FROM app.outbox_events WHERE id = ${id}::bigint
    `;
  });
  return rows[0]?.applied ?? null;
}

describe("entitlement invalidator", () => {
  invalidatorTest("invalidates a school entry and advances the cursor", async () => {
    const schoolId = await seedSchool();
    const key = `ent:${schoolId}`;
    await redis!.set(key, `1|{"active":true}`, "EX", 300);

    const id = await seedOutboxRow(schoolId, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId,
      subscriptionId: crypto.randomUUID(),
      previousStatus: "active",
      status: "canceled",
      entitlementsVersion: 2,
    });

    expect(await processEntitlementSchool(context(), schoolId)).toBe(1);

    // A version floor: the entry stays present so the JWT middleware sees the new version at once,
    // but its body is gone so a reader re-resolves.
    expect(await redis!.get(key)).toBe("2|");
    expect(await readCursor(schoolId, id)).not.toBeNull();
    expect(await redis!.ttl(key)).toBeGreaterThan(0);
  });

  invalidatorTest("invalidates an AI entry on its own key", async () => {
    const schoolId = await seedSchool();
    const studentId = crypto.randomUUID();
    const key = `ent:ai:${studentId}`;
    await redis!.set(key, `1|{"active":true}`, "EX", 300);

    await seedOutboxRow(schoolId, DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED, {
      schoolId,
      studentId,
      aiSubscriptionId: crypto.randomUUID(),
      previousStatus: "active",
      status: "canceled",
      entitlementsVersion: 3,
    });

    expect(await processEntitlementSchool(context(), schoolId)).toBe(1);
    expect(await redis!.get(key)).toBe("3|");
  });

  // The at-least-once guarantee. The mark and the invalidation share one transaction, so a Redis
  // failure must leave the row claimable rather than silently consumed.
  invalidatorTest(
    "a Redis failure leaves the cursor unset and the next cycle succeeds",
    async () => {
      const schoolId = await seedSchool();
      const key = `ent:${schoolId}`;

      const id = await seedOutboxRow(schoolId, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
        schoolId,
        subscriptionId: crypto.randomUUID(),
        previousStatus: "active",
        status: "canceled",
        entitlementsVersion: 4,
      });

      const failing = {
        eval: () => Promise.reject(new Error("redis down")),
      } as unknown as IORedis;

      // Its own single connection, closed before the assertions run. postgres.js destroys a pooled
      // connection whose transaction callback rejects, and handing that back to the shared pool makes
      // the *next* query fail as CONNECTION_DESTROYED — reporting as a failure of whatever ran
      // afterwards rather than of anything real. Same isolation the billing suite uses.
      const isolated = postgres(databaseUrl!, { max: 1, ssl: false, prepare: false });
      try {
        await expect(
          processEntitlementSchool(context({ db: isolated, redis: failing }), schoolId),
        ).rejects.toThrow("redis down");
      } finally {
        await isolated.end({ timeout: 5 });
      }

      // Rolled back with the transaction — the row is still owed.
      expect(await readCursor(schoolId, id)).toBeNull();

      expect(await processEntitlementSchool(context(), schoolId)).toBe(1);
      expect(await redis!.get(key)).toBe("4|");
      expect(await readCursor(schoolId, id)).not.toBeNull();
    },
  );

  invalidatorTest("an applied row is not claimed again", async () => {
    const schoolId = await seedSchool();

    await seedOutboxRow(schoolId, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId,
      subscriptionId: crypto.randomUUID(),
      previousStatus: "active",
      status: "canceled",
      entitlementsVersion: 2,
    });

    expect(await processEntitlementSchool(context(), schoolId)).toBe(1);
    expect(await processEntitlementSchool(context(), schoolId)).toBe(0);
  });

  // Why running this alongside the API's pub/sub subscriber is safe rather than racy.
  invalidatorTest("re-applying an older version does not move the floor backwards", async () => {
    const schoolId = await seedSchool();
    const key = `ent:${schoolId}`;
    await redis!.set(key, "9|", "EX", 300);

    await seedOutboxRow(schoolId, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId,
      subscriptionId: crypto.randomUUID(),
      previousStatus: "active",
      status: "canceled",
      entitlementsVersion: 5,
    });

    await processEntitlementSchool(context(), schoolId);
    expect(await redis!.get(key)).toBe("9|");
  });

  // A malformed payload is permanent. Throwing would re-claim the same unusable row forever, so it is
  // logged and marked applied instead — the one case where consuming without invalidating is right.
  invalidatorTest("an unusable payload is marked applied rather than retried forever", async () => {
    const schoolId = await seedSchool();

    const id = await seedOutboxRow(schoolId, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId,
      // No entitlementsVersion.
      previousStatus: "active",
      status: "canceled",
    });

    expect(await processEntitlementSchool(context(), schoolId)).toBe(1);
    expect(await readCursor(schoolId, id)).not.toBeNull();
    expect(await processEntitlementSchool(context(), schoolId)).toBe(0);
  });

  // Tenant isolation on app.outbox_events is what scopes the claim; the consumer passes no school_id
  // predicate of its own. A leak here would be a cross-tenant cache invalidation.
  invalidatorTest("never claims another school's rows", async () => {
    const schoolA = await seedSchool();
    const schoolB = await seedSchool();

    await seedOutboxRow(schoolB, DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED, {
      schoolId: schoolB,
      subscriptionId: crypto.randomUUID(),
      previousStatus: "active",
      status: "canceled",
      entitlementsVersion: 2,
    });

    expect(await processEntitlementSchool(context(), schoolA)).toBe(0);
    expect(await processEntitlementSchool(context(), schoolB)).toBe(1);
  });
});
