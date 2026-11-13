/**
 * The seat-reconciliation sweep (ST-136), against a real database.
 *
 * Seeds subscriptions directly (an `active` row with a Stripe subscription/item id and a cap) and
 * drives the sweep with an injected clock and an in-memory fake Stripe provider, so no network is
 * touched and every proration number is deterministic. The "proration matches Stripe invoice
 * preview" acceptance is proven by hand: the fixture's period dates and unit price make the
 * preview amount 99_999 minor units, and the test asserts both that the sweep reports exactly that
 * number and that the independent oracle (`computeSeatProration`) computes the same figure.
 *
 * The sweep is global -- it enumerates every school in the database -- so assertions are
 * per-school: our school's cap, outbox and the fake provider's recorded calls. Skipped (as
 * `skipIf` tests) unless TEST_DATABASE_URL is set.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runSeatReconciliation } from "../seat-reconciliation";
import { computeSeatProration } from "../seat-reconciliation-schedule";

import type { SeatSubscriptionProvider } from "../stripe-seat-provider";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const seatTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const DAY = 86_400_000;
const BASE = new Date("2026-01-01T00:00:00.000Z");
/** Thirty-day billing period: BASE (start, inclusive) through BASE + 30d (end, exclusive). */
const PERIOD_END = new Date(BASE.getTime() + 30 * DAY);
/** Twenty days in, ten days remaining — exactly one third of the period. */
const NOW = new Date(BASE.getTime() + 20 * DAY);
const PLAN_NAME = "Seat Reconciliation Test Plan";
const UNIT_AMOUNT_MINOR = 100_000;
/** 100000 / 3 rounded per seat = 33333, times three added seats. */
const PREVIEW_AMOUNT = 99_999;

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

interface ProviderCall {
  method: string;
  itemId: string;
  quantity: number;
  prorationBehavior?: "always_invoice" | "none";
}

class FakeSeatProvider implements SeatSubscriptionProvider {
  billedByItem = new Map<string, number>();
  calls: ProviderCall[] = [];
  failFor = new Set<string>();

  async fetchBilledSeats(subscriptionId: string, itemId: string) {
    this.throwIfFailed(itemId);
    return {
      quantity: this.billedByItem.get(itemId) ?? 1,
      unitAmountMinor: UNIT_AMOUNT_MINOR,
      currency: "usd",
    };
  }

  async previewUpgrade(_subscriptionId: string, itemId: string, _quantity: number) {
    this.throwIfFailed(itemId);
    return { prorationAmountMinor: PREVIEW_AMOUNT };
  }

  async setQuantity(
    _subscriptionId: string,
    itemId: string,
    quantity: number,
    prorationBehavior: "always_invoice" | "none",
  ): Promise<void> {
    this.throwIfFailed(itemId);
    this.calls.push({ method: "setQuantity", itemId, quantity, prorationBehavior });
    this.billedByItem.set(itemId, quantity);
  }

  private throwIfFailed(itemId: string): void {
    if (this.failFor.has(itemId)) throw new Error("stripe unavailable");
  }
}

interface SeedOptions {
  /** The school subscription's state. Status `active` means it is reconcile-eligible. */
  subscription?: {
    status: string;
    studentCap: number;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionItemId?: string | null;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
  };
  /** How many enrolled students to create. */
  enrolledStudents?: number;
  /** How many ORG_ADMIN users (with their roles) to create. */
  admins?: number;
}

interface Fixture {
  schoolId: string;
  subscriptionId: string | null;
  /**
   * The subscription's derived Stripe item id, unless the seed explicitly supplied null.
   * Null when the fixture has no Stripe integration at all.
   */
  stripeSubscriptionItemId: string | null;
  /** The ORG_ADMINs' normalized_email values, in seeding order. */
  adminEmails: string[];
}

async function seedFixture(options: SeedOptions): Promise<Fixture> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `seat-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (
        ${slug}, ${`Seat School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}
      )
      RETURNING id
    `;
    const schoolId = school!.id;

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES (${`plan_${slug.replaceAll("-", "_")}`}, ${PLAN_NAME}, true)
      RETURNING id
    `;

    let subscriptionId: string | null = null;
    let stripeSubscriptionItemId: string | null = null;
    if (options.subscription) {
      const sub = options.subscription;
      // Every fixture gets its own Stripe ids so the global unique constraints never collide across
      // fixtures. An explicit null opts out (the "skipped" case), an explicit value is honoured.
      const stripeSubscriptionId =
        sub.stripeSubscriptionId === undefined ? `sub_${slug}` : sub.stripeSubscriptionId;
      stripeSubscriptionItemId =
        sub.stripeSubscriptionItemId === undefined ? `si_${slug}` : sub.stripeSubscriptionItemId;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.subscriptions (
          school_id, plan_id, status, current_period_start, current_period_end,
          student_cap, stripe_subscription_id, stripe_subscription_item_id
        ) VALUES (
          ${schoolId}::uuid, ${plan!.id}::uuid, ${sub.status}::app.subscription_status,
          ${sub.currentPeriodStart ?? BASE.toISOString()}::timestamptz,
          ${sub.currentPeriodEnd ?? PERIOD_END.toISOString()}::timestamptz,
          ${sub.studentCap},
          ${stripeSubscriptionId},
          ${stripeSubscriptionItemId}
        )
        RETURNING id
      `;
      subscriptionId = row!.id;
    }

    for (let i = 0; i < (options.enrolledStudents ?? 0); i += 1) {
      const email = `student${i}-${slug}@local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${`Student ${i}`}, 'active')
        RETURNING id
      `;
      await tx`
        INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
        VALUES (
          ${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${slug}-${i}`}, 'Student', 'Seeded', 'enrolled'
        )
      `;
    }

    const adminEmails: string[] = [];
    for (let i = 0; i < (options.admins ?? 0); i += 1) {
      const email = `admin${i}-${slug}@local`;
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${`Admin ${i}`}, 'active')
        RETURNING id
      `;
      await tx`
        INSERT INTO app.user_roles (school_id, user_id, role)
        VALUES (${schoolId}::uuid, ${user!.id}::uuid, 'ORG_ADMIN'::app.user_role)
      `;
      adminEmails.push(email);
    }

    return { schoolId, subscriptionId, stripeSubscriptionItemId, adminEmails };
  });
}

const ACTIVE_STRIPE = {
  status: "active",
};

interface OutboxRow {
  eventName: string;
  payload: Record<string, unknown>;
}

async function readOutbox(schoolId: string): Promise<OutboxRow[]> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const rows = await tx<{ event_name: string; payload: unknown }[]>`
      SELECT event_name, payload FROM app.outbox_events WHERE school_id = ${schoolId}::uuid
    `;
    return rows.map((r) => ({
      eventName: r.event_name,
      payload: r.payload as Record<string, unknown>,
    }));
  });
}

async function readStudentCap(
  schoolId: string,
  subscriptionId: string,
): Promise<{ studentCap: number; status: string }> {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    const [row] = await tx<{ student_cap: number; status: string }[]>`
      SELECT student_cap, status::text AS status
      FROM app.subscriptions WHERE id = ${subscriptionId}::uuid
    `;
    return { studentCap: row!.student_cap, status: row!.status };
  });
}

/** The sweep is global, so provider-call assertions must be scoped to one fixture's item. */
function callsFor(provider: FakeSeatProvider, itemId: string): ProviderCall[] {
  return provider.calls.filter((call) => call.itemId === itemId);
}

describe("seat reconciliation sweep", () => {
  seatTest(
    "upgrade mid-period bills the extra seats now, raises the cap, and reports the prorated charge",
    async () => {
      const { schoolId, subscriptionId, adminEmails, stripeSubscriptionItemId } = await seedFixture(
        {
          subscription: { ...ACTIVE_STRIPE, studentCap: 50 },
          enrolledStudents: 53,
          admins: 2,
        },
      );
      const provider = new FakeSeatProvider();
      provider.billedByItem.set(stripeSubscriptionItemId!, 50);

      const result = await runSeatReconciliation(db!, provider, NOW, silentLogger);
      expect(result.upgrades).toBeGreaterThanOrEqual(1);

      // The proration the sweep reported must be both Stripe's preview amount and the independent
      // oracle's expectation -- the "proration matches Stripe invoice preview" acceptance.
      expect(
        computeSeatProration({
          unitAmountMinor: UNIT_AMOUNT_MINOR,
          periodStart: BASE,
          periodEnd: PERIOD_END,
          now: NOW,
          deltaSeats: 3,
        }),
      ).toBe(PREVIEW_AMOUNT);

      expect(callsFor(provider, stripeSubscriptionItemId!)).toContainEqual({
        method: "setQuantity",
        itemId: stripeSubscriptionItemId!,
        quantity: 53,
        prorationBehavior: "always_invoice",
      });

      const sub = await readStudentCap(schoolId, subscriptionId!);
      expect(sub.studentCap).toBe(53);

      const outbox = await readOutbox(schoolId);
      expect(outbox).toHaveLength(2);
      for (const row of outbox) {
        expect(row.eventName).toBe(DOMAIN_EVENTS.SUBSCRIPTION_SEAT_DRIFT_REPORTED);
        expect(row.payload).toMatchObject({
          schoolId,
          subscriptionId,
          planName: PLAN_NAME,
          activeSeatCount: 53,
          billedSeatCount: 50,
          delta: 3,
          direction: "upgrade",
          proratedAmountMinor: PREVIEW_AMOUNT,
          currency: "usd",
          effectivePeriodEnd: null,
        });
      }
      expect(new Set(outbox.map((r) => r.payload.email))).toEqual(new Set(adminEmails));

      // Idempotency: a re-run sees billed == enrolled == cap and touches nothing.
      await runSeatReconciliation(db!, provider, NOW, silentLogger);
      expect(await readOutbox(schoolId)).toHaveLength(2);
      expect(callsFor(provider, stripeSubscriptionItemId!)).toHaveLength(1);
    },
  );

  seatTest(
    "downgrade lowers the quantity with no proration, defers to the next renewal, and reports it",
    async () => {
      const { schoolId, subscriptionId, adminEmails, stripeSubscriptionItemId } = await seedFixture(
        {
          subscription: { ...ACTIVE_STRIPE, studentCap: 10 },
          enrolledStudents: 3,
          admins: 1,
        },
      );
      const provider = new FakeSeatProvider();
      provider.billedByItem.set(stripeSubscriptionItemId!, 10);

      const result = await runSeatReconciliation(db!, provider, NOW, silentLogger);
      expect(result.downgrades).toBeGreaterThanOrEqual(1);

      expect(callsFor(provider, stripeSubscriptionItemId!)).toContainEqual({
        method: "setQuantity",
        itemId: stripeSubscriptionItemId!,
        quantity: 3,
        prorationBehavior: "none",
      });

      const sub = await readStudentCap(schoolId, subscriptionId!);
      expect(sub.studentCap).toBe(3);

      const outbox = await readOutbox(schoolId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.payload).toMatchObject({
        activeSeatCount: 3,
        billedSeatCount: 10,
        delta: -7,
        direction: "downgrade",
        proratedAmountMinor: null,
        currency: null,
        effectivePeriodEnd: PERIOD_END.toISOString(),
      });
      expect(new Set(outbox.map((r) => r.payload.email))).toEqual(new Set(adminEmails));
    },
  );

  seatTest("no drift and an in-sync cap touch neither Stripe nor the outbox", async () => {
    const { schoolId, subscriptionId, stripeSubscriptionItemId } = await seedFixture({
      subscription: { ...ACTIVE_STRIPE, studentCap: 5 },
      enrolledStudents: 5,
      admins: 2,
    });
    const provider = new FakeSeatProvider();
    provider.billedByItem.set(stripeSubscriptionItemId!, 5);

    await runSeatReconciliation(db!, provider, NOW, silentLogger);

    expect(callsFor(provider, stripeSubscriptionItemId!)).toHaveLength(0);
    expect((await readStudentCap(schoolId, subscriptionId!)).studentCap).toBe(5);
    expect(await readOutbox(schoolId)).toHaveLength(0);
  });

  seatTest(
    "a stale cap with matching Stripe quantity is re-synced without billing or emailing again",
    async () => {
      const { schoolId, subscriptionId, stripeSubscriptionItemId } = await seedFixture({
        subscription: { ...ACTIVE_STRIPE, studentCap: 50 },
        enrolledStudents: 3,
        admins: 1,
      });
      const provider = new FakeSeatProvider();
      provider.billedByItem.set(stripeSubscriptionItemId!, 3);

      const result = await runSeatReconciliation(db!, provider, NOW, silentLogger);
      expect(result.capSyncs).toBeGreaterThanOrEqual(1);

      expect(callsFor(provider, stripeSubscriptionItemId!)).toHaveLength(0);
      expect((await readStudentCap(schoolId, subscriptionId!)).studentCap).toBe(3);
      expect(await readOutbox(schoolId)).toHaveLength(0);
    },
  );

  seatTest("a Stripe failure rolls the school back and the job moves on", async () => {
    const { schoolId, subscriptionId, stripeSubscriptionItemId } = await seedFixture({
      subscription: { ...ACTIVE_STRIPE, studentCap: 50 },
      enrolledStudents: 53,
      admins: 1,
    });
    const provider = new FakeSeatProvider();
    provider.billedByItem.set(stripeSubscriptionItemId!, 50);
    provider.failFor.add(stripeSubscriptionItemId!);

    const result = await runSeatReconciliation(db!, provider, NOW, silentLogger);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    expect(callsFor(provider, stripeSubscriptionItemId!)).toHaveLength(0);
    expect((await readStudentCap(schoolId, subscriptionId!)).studentCap).toBe(50);
    expect(await readOutbox(schoolId)).toHaveLength(0);
  });

  seatTest("a subscription without Stripe ids is skipped, not reconciled", async () => {
    const { schoolId, subscriptionId } = await seedFixture({
      subscription: {
        status: "active",
        studentCap: 50,
        stripeSubscriptionId: null,
        stripeSubscriptionItemId: null,
      },
      enrolledStudents: 53,
      admins: 1,
    });
    const provider = new FakeSeatProvider();

    const result = await runSeatReconciliation(db!, provider, NOW, silentLogger);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    expect((await readStudentCap(schoolId, subscriptionId!)).studentCap).toBe(50);
    expect(await readOutbox(schoolId)).toHaveLength(0);
  });

  seatTest("a non-active subscription is out of scope entirely", async () => {
    const { schoolId, subscriptionId } = await seedFixture({
      subscription: { ...ACTIVE_STRIPE, status: "trialing", studentCap: 50 },
      enrolledStudents: 53,
      admins: 1,
    });
    const provider = new FakeSeatProvider();

    await runSeatReconciliation(db!, provider, NOW, silentLogger);

    expect((await readStudentCap(schoolId, subscriptionId!)).studentCap).toBe(50);
    expect(await readOutbox(schoolId)).toHaveLength(0);
  });
});
