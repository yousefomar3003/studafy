/**
 * The duplicate storage subscription resolver (db/migrations/000219): a school charged for a second
 * storage add-on gets the replaced one canceled in Stripe and the unused part of its period refunded
 * -- once, however many times the job runs -- and a row that keeps failing is handed to a person.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import {
  MAX_ATTEMPTS,
  retryDelayMinutes,
  runStorageDuplicateResolver,
  unusedRefund,
} from "../storage-duplicate-resolver";

import type {
  DuplicateSubscriptionInfo,
  StorageDuplicateStripe,
} from "../storage-duplicate-resolver";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbTest = test.skipIf(!databaseUrl);

let db: Sql | undefined;
const silentLogger = { info: () => undefined, warn: () => undefined };
const DAY = 86_400_000;

beforeAll(() => {
  if (!databaseUrl) return;
  db = postgres(databaseUrl, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

function info(overrides: Partial<DuplicateSubscriptionInfo> = {}): DuplicateSubscriptionInfo {
  const now = Date.now();
  return {
    status: "active",
    periodStart: new Date(now - 10 * DAY),
    periodEnd: new Date(now + 20 * DAY),
    unitAmountMinor: 1000,
    currency: "USD",
    paidInvoice: { id: "in_old", amountPaidMinor: 1000 },
    ...overrides,
  };
}

describe("the refund for the unused part of the period", () => {
  test("is the unused share of the full price", () => {
    const at = new Date("2026-11-11T00:00:00Z");
    const refund = unusedRefund(
      info({
        periodStart: new Date("2026-11-01T00:00:00Z"),
        periodEnd: new Date("2026-12-01T00:00:00Z"),
      }),
      at,
    );
    expect(refund).toEqual({ amountMinor: 667, unrefundedMinor: 0 });
  });

  test("is everything when the duplicate was bought a moment ago", () => {
    const now = new Date();
    const refund = unusedRefund(
      info({ periodStart: now, periodEnd: new Date(now.getTime() + 30 * DAY) }),
      now,
    );
    expect(refund.amountMinor).toBe(1000);
  });

  test("never exceeds what the latest invoice took, and says what it held back", () => {
    const at = new Date("2026-11-11T00:00:00Z");
    const refund = unusedRefund(
      info({
        periodStart: new Date("2026-11-01T00:00:00Z"),
        periodEnd: new Date("2026-12-01T00:00:00Z"),
        unitAmountMinor: 4900,
        paidInvoice: { id: "in_proration", amountPaidMinor: 2000 },
      }),
      at,
    );
    expect(refund).toEqual({ amountMinor: 2000, unrefundedMinor: 1267 });
  });

  test("is nothing when nothing was paid", () => {
    expect(unusedRefund(info({ paidInvoice: null }), new Date())).toEqual({
      amountMinor: 0,
      unrefundedMinor: 0,
    });
  });

  test("retries back off and are capped", () => {
    expect(retryDelayMinutes(1)).toBe(10);
    expect(retryDelayMinutes(2)).toBe(20);
    expect(retryDelayMinutes(20)).toBe(360);
  });
});

interface FakeStripe extends StorageDuplicateStripe {
  cancels: string[];
  refunds: { invoiceId: string; amountMinor: number; idempotencyKey: string }[];
  failNext: number;
  subscriptions: Map<string, DuplicateSubscriptionInfo>;
}

function fakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    cancels: [],
    refunds: [],
    failNext: 0,
    subscriptions: new Map(),
    retrieveSubscription: (id) => {
      if (fake.failNext > 0) {
        fake.failNext -= 1;
        return Promise.reject(new Error("Stripe is unavailable"));
      }
      return Promise.resolve(fake.subscriptions.get(id) ?? info());
    },
    cancelSubscription: (id) => {
      fake.cancels.push(id);
      const current = fake.subscriptions.get(id) ?? info();
      fake.subscriptions.set(id, { ...current, status: "canceled" });
      return Promise.resolve();
    },
    refundInvoice: (input) => {
      fake.refunds.push(input);
      return Promise.resolve(`re_${fake.refunds.length}`);
    },
  };
  return fake;
}

async function seedDuplicate(): Promise<{ schoolId: string; id: string; subscription: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    const slug = `st-dup-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (
        slug, name, email, normalized_email, country_id, default_currency_id, stripe_customer_id
      )
      SELECT ${slug}, ${`Duplicate School ${slug}`}, ${`${slug}@admin.local`},
             ${`${slug}@admin.local`},
             (SELECT id FROM app.countries WHERE alpha2_code = 'US'),
             (SELECT id FROM app.currencies WHERE code = 'USD'),
             ${`cus_${slug}`}
      RETURNING id
    `;
    await tx`SELECT set_config('app.school_id', ${school!.id}, true)`;
    const [storage] = await tx<{ id: string }[]>`
      INSERT INTO app.storage_subscriptions (
        school_id, cap_bytes, status, current_period_start, current_period_end,
        stripe_subscription_id
      ) VALUES (
        ${school!.id}::uuid, ${1024 ** 4}, 'active', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + interval '30 days', ${`sub_new_${slug}`}
      )
      RETURNING id
    `;
    const subscription = `sub_old_${slug}`;
    const [duplicate] = await tx<{ id: string }[]>`
      INSERT INTO app.storage_duplicate_subscriptions (
        school_id, storage_subscription_id, stripe_subscription_id, kept_stripe_subscription_id
      ) VALUES (${school!.id}::uuid, ${storage!.id}::uuid, ${subscription}, ${`sub_new_${slug}`})
      RETURNING id
    `;
    return { schoolId: school!.id, id: duplicate!.id, subscription };
  });
}

async function duplicateRow(schoolId: string, id: string) {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<
      {
        status: string;
        attempts: number;
        canceled_at: Date | null;
        refund_amount_minor: string | null;
        stripe_refund_id: string | null;
        last_error: string | null;
        next_attempt_at: Date;
      }[]
    >`
      SELECT status, attempts, canceled_at, refund_amount_minor::text AS refund_amount_minor,
             stripe_refund_id, last_error, next_attempt_at
      FROM app.storage_duplicate_subscriptions WHERE id = ${id}::uuid
    `;
    return row!;
  });
}

async function forceDue(schoolId: string, id: string): Promise<void> {
  await db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    await tx`
      UPDATE app.storage_duplicate_subscriptions
      SET next_attempt_at = CURRENT_TIMESTAMP - interval '1 minute'
      WHERE id = ${id}::uuid
    `;
  });
}

describe("resolving a duplicate storage subscription", () => {
  dbTest("cancels it and refunds it once, however often the job runs", async () => {
    const seeded = await seedDuplicate();
    const stripe = fakeStripe();
    stripe.subscriptions.set(seeded.subscription, info());

    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);
    await forceDue(seeded.schoolId, seeded.id);
    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);

    expect(stripe.cancels).toEqual([seeded.subscription]);
    expect(stripe.refunds).toHaveLength(1);
    expect(stripe.refunds[0]).toMatchObject({
      invoiceId: "in_old",
      idempotencyKey: `storage-duplicate-refund:${seeded.id}`,
    });
    const row = await duplicateRow(seeded.schoolId, seeded.id);
    expect(row.status).toBe("resolved");
    expect(row.canceled_at).not.toBeNull();
    expect(row.stripe_refund_id).toBe("re_1");
    expect(Number(row.refund_amount_minor)).toBe(stripe.refunds[0]!.amountMinor);
  });

  dbTest("a failure is retried later, then succeeds with the same refund", async () => {
    const seeded = await seedDuplicate();
    const stripe = fakeStripe();
    stripe.failNext = 1;

    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);
    const failed = await duplicateRow(seeded.schoolId, seeded.id);
    expect(failed).toMatchObject({ status: "pending", attempts: 1 });
    expect(failed.last_error).toContain("Stripe is unavailable");
    expect(failed.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    expect(stripe.cancels).toHaveLength(0);

    // Not due yet: nothing happens.
    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);
    expect(stripe.cancels).toHaveLength(0);

    await forceDue(seeded.schoolId, seeded.id);
    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);
    expect(stripe.cancels).toEqual([seeded.subscription]);
    expect(stripe.refunds).toHaveLength(1);
    expect((await duplicateRow(seeded.schoolId, seeded.id)).status).toBe("resolved");
  });

  dbTest("after its last attempt it waits for a person", async () => {
    const seeded = await seedDuplicate();
    await db!.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE studafy_admin");
      await tx`SELECT set_config('app.school_id', ${seeded.schoolId}, true)`;
      await tx`
        UPDATE app.storage_duplicate_subscriptions SET attempts = ${MAX_ATTEMPTS - 1}
        WHERE id = ${seeded.id}::uuid
      `;
    });
    const stripe = fakeStripe();
    stripe.failNext = 1;

    const result = await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);

    expect(result.needsReview).toBeGreaterThanOrEqual(1);
    expect((await duplicateRow(seeded.schoolId, seeded.id)).status).toBe("needs_review");

    // A row waiting for a person is never picked up again.
    await forceDue(seeded.schoolId, seeded.id);
    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);
    expect(stripe.cancels).toHaveLength(0);
  });

  dbTest("one Stripe already ended is only refunded", async () => {
    const seeded = await seedDuplicate();
    const stripe = fakeStripe();
    stripe.subscriptions.set(seeded.subscription, info({ status: "canceled" }));

    await runStorageDuplicateResolver(db!, stripe, new Date(), silentLogger);

    expect(stripe.cancels).toHaveLength(0);
    expect(stripe.refunds).toHaveLength(1);
    expect((await duplicateRow(seeded.schoolId, seeded.id)).status).toBe("resolved");
  });
});
