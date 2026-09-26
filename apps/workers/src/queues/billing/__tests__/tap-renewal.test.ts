/**
 * Tap renewals (ST-298), against a real database.
 *
 * Seeds a Tap-billed school the way a completed checkout leaves it -- a saved card on the
 * subscription and a processed `checkout.session.completed` in `app.billing_events` recording the
 * price -- and drives `runTapRenewals` with a fake Tap and an injected clock. What is under test is
 * the ledger discipline (one charge per period, retries spaced, unknown outcomes blocking) and the
 * two transitions the job owns (cancel at period end, dunning exhausted). Period advancement on a
 * paid renewal is the webhook's job and is covered in apps/api's tap-webhook-processing suite.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated database.
 */

import { TapApiError } from "@studafy/tap-payments";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { runTapRenewals, TAP_RENEWAL_MAX_ATTEMPTS, TAP_RENEWAL_RETRY_DAYS } from "../tap-renewal";

import type { TapRenewalCharger } from "../tap-renewal";
import type { CreateSavedCardChargeInput, TapCharge } from "@studafy/tap-payments";
import type { Sql } from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(databaseUrl);
const renewalTest = test.skipIf(!enabled);

let db: Sql | undefined;

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const DAY = 86_400_000;
const PERIOD_END = new Date("2030-01-15T09:00:00.000Z");
const WEBHOOK_URL = "https://api.studafy.test/api/subscriptions/webhook/tap";

beforeAll(() => {
  if (!enabled) return;
  db = postgres(databaseUrl!, { max: 4, ssl: false, prepare: false });
});

afterAll(async () => {
  await db?.end({ timeout: 5 });
});

/**
 * A Tap that answers each customer's Nth charge with the Nth scripted status, and records every
 * request. Per customer because a run renews every Tap school in the shared database, including
 * other tests' fixtures, and those must not consume this test's script.
 */
function fakeTap(...script: (string | Error)[]) {
  const charges: CreateSavedCardChargeInput[] = [];
  const perCustomer = new Map<string, number>();
  let sequence = 0;
  const charger: TapRenewalCharger = {
    async chargeSavedCard(input) {
      charges.push(input);
      const n = perCustomer.get(input.customerId) ?? 0;
      perCustomer.set(input.customerId, n + 1);
      const next = script[n] ?? "CAPTURED";
      if (next instanceof Error) throw next;
      sequence += 1;
      return { id: `chg_renew_${sequence}_${crypto.randomUUID().slice(0, 6)}`, status: next };
    },
    async retrieveCharge(chargeId): Promise<TapCharge> {
      return { id: chargeId, status: "CAPTURED" };
    },
  };
  return { charger, charges };
}

interface Fixture {
  schoolId: string;
  subscriptionId: string;
  priceId: string;
  tapCustomerId: string;
}

async function seed(options: { cancelAtPeriodEnd?: boolean; seatBilling?: boolean } = {}) {
  return db!.begin(async (tx): Promise<Fixture> => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
        (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
    `;

    const slug = `tap-${crypto.randomUUID().slice(0, 8)}`;
    const tapCustomerId = `cus_TS${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (
        slug, name, email, normalized_email, country_id, default_currency_id, tap_customer_id
      ) VALUES (
        ${slug}, ${`Tap School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}, ${tapCustomerId}
      )
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES (${`plan_${slug.replaceAll("-", "_")}`}, 'Tap Plan', true)
      RETURNING id
    `;
    const [price] = await tx<{ id: string }[]>`
      INSERT INTO app.plan_prices (plan_id, currency_id, billing_interval, amount_minor)
      VALUES (${plan!.id}::uuid, ${reference!.currency}::uuid, 'monthly', 15500)
      RETURNING id
    `;

    const [subscription] = await tx<{ id: string }[]>`
      INSERT INTO app.subscriptions (
        school_id, plan_id, status, current_period_start, current_period_end,
        cancel_at_period_end, tap_card_id, tap_payment_agreement_id
      ) VALUES (
        ${schoolId}::uuid, ${plan!.id}::uuid, 'active',
        ${new Date(PERIOD_END.getTime() - 31 * DAY)}, ${PERIOD_END},
        ${options.cancelAtPeriodEnd ?? false}, 'card_TS_saved', 'payment_agreement_TS_saved'
      )
      RETURNING id
    `;

    if (options.seatBilling) {
      for (let i = 0; i < 3; i += 1) {
        const email = `s${i}-${slug}@local`;
        const [user] = await tx<{ id: string }[]>`
          INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
          VALUES (${schoolId}::uuid, ${email}, ${email}, 'Student', 'active')
          RETURNING id
        `;
        await tx`
          INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
          VALUES (${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${i}-${slug}`}, 'S', 'T', 'enrolled')
        `;
      }
    }

    // The ledger row a processed Tap checkout leaves behind.
    await tx`
      INSERT INTO app.billing_events (
        provider, provider_event_id, event_type, effective_at, payload, status, attempt_count,
        processed_at, subscription_type, subscription_id
      ) VALUES (
        'tap', ${`chg_first_${slug}:CAPTURED`}, 'checkout.session.completed',
        ${new Date(PERIOD_END.getTime() - 31 * DAY)},
        ${tx.json({
          id: `chg_first_${slug}`,
          customer: tapCustomerId,
          metadata: {
            school_id: schoolId,
            billing_reason: "subscription_create",
            price_id: price!.id,
            billing_interval: "monthly",
            ...(options.seatBilling ? { seat_billing: "enrolled_students" } : {}),
          },
        })},
        'processed', 1, CURRENT_TIMESTAMP, 'school', ${subscription!.id}::uuid
      )
    `;

    return { schoolId, subscriptionId: subscription!.id, priceId: price!.id, tapCustomerId };
  });
}

async function readState(f: Fixture) {
  return db!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    const [sub] = await tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.subscriptions WHERE id = ${f.subscriptionId}::uuid
    `;
    const attempts = await tx<{ attempt: number; status: string; amount_minor: string }[]>`
      SELECT attempt, status::text AS status, amount_minor::text AS amount_minor
      FROM app.tap_renewal_attempts
      WHERE subscription_id = ${f.subscriptionId}::uuid
      ORDER BY attempt
    `;
    return { status: sub!.status, attempts: [...attempts] };
  });
}

const at = (daysAfterPeriodEnd: number) =>
  new Date(PERIOD_END.getTime() + daysAfterPeriodEnd * DAY);

/** Only this fixture's charges: other test files' schools share the database. */
function chargesFor(f: Fixture, charges: CreateSavedCardChargeInput[]) {
  return charges.filter((c) => c.customerId === f.tapCustomerId);
}

describe("runTapRenewals", () => {
  renewalTest("charges the saved card for the next period, exactly once", async () => {
    const f = await seed();
    const { charger, charges } = fakeTap("CAPTURED");

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.1), silentLogger);
    // A second run the same day, before the webhook has advanced the period, must not charge again.
    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.2), silentLogger);

    const mine = chargesFor(f, charges);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      amountMinor: 15_500,
      currency: "JOD",
      cardId: "card_TS_saved",
      paymentAgreementId: "payment_agreement_TS_saved",
      webhookUrl: WEBHOOK_URL,
      metadata: {
        school_id: f.schoolId,
        billing_reason: "subscription_cycle",
        price_id: f.priceId,
        period_start: String(PERIOD_END.getTime() / 1000),
        period_end: String(Date.UTC(2030, 1, 15, 9) / 1000),
      },
    });
    expect((await readState(f)).attempts).toEqual([
      { attempt: 1, status: "succeeded", amount_minor: "15500" },
    ]);
  });

  renewalTest("bills a seat-based school for its enrolled students today", async () => {
    const f = await seed({ seatBilling: true });
    const { charger, charges } = fakeTap("CAPTURED");

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.1), silentLogger);

    expect(chargesFor(f, charges)[0]!.amountMinor).toBe(15_500 * 3);
  });

  renewalTest("spaces retries and hands to grace after the last one fails", async () => {
    const f = await seed();
    const { charger, charges } = fakeTap("DECLINED", "DECLINED", "DECLINED");

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.1), silentLogger);
    // Too soon for a retry.
    await runTapRenewals(db!, charger, WEBHOOK_URL, at(1), silentLogger);
    expect(chargesFor(f, charges)).toHaveLength(1);

    for (let n = 1; n < TAP_RENEWAL_MAX_ATTEMPTS; n += 1) {
      await runTapRenewals(
        db!,
        charger,
        WEBHOOK_URL,
        at(n * TAP_RENEWAL_RETRY_DAYS + 0.1),
        silentLogger,
      );
    }
    expect(chargesFor(f, charges)).toHaveLength(TAP_RENEWAL_MAX_ATTEMPTS);
    expect((await readState(f)).status).toBe("active");

    await runTapRenewals(
      db!,
      charger,
      WEBHOOK_URL,
      at(TAP_RENEWAL_MAX_ATTEMPTS * TAP_RENEWAL_RETRY_DAYS + 0.1),
      silentLogger,
    );

    const state = await readState(f);
    expect(chargesFor(f, charges)).toHaveLength(TAP_RENEWAL_MAX_ATTEMPTS);
    expect(state.attempts.map((a) => a.status)).toEqual(["failed", "failed", "failed"]);
    expect(state.status).toBe("grace_period");
  });

  renewalTest("an outcome nobody knows blocks the period instead of charging again", async () => {
    const f = await seed();
    const { charger, charges } = fakeTap(new TapApiError(502, "Tap unreachable: timeout"));

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.1), silentLogger);
    const result = await runTapRenewals(
      db!,
      charger,
      WEBHOOK_URL,
      at(TAP_RENEWAL_RETRY_DAYS * 2),
      silentLogger,
    );

    expect(chargesFor(f, charges)).toHaveLength(1);
    expect((await readState(f)).attempts.map((a) => a.status)).toEqual(["unknown"]);
    expect(result.blocked).toBeGreaterThanOrEqual(1);
  });

  renewalTest("a request Tap refused is a failed attempt and may be retried", async () => {
    const f = await seed();
    const { charger, charges } = fakeTap(new TapApiError(400, "invalid card"), "CAPTURED");

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.1), silentLogger);
    await runTapRenewals(db!, charger, WEBHOOK_URL, at(TAP_RENEWAL_RETRY_DAYS + 0.1), silentLogger);

    expect(chargesFor(f, charges)).toHaveLength(2);
    expect((await readState(f)).attempts.map((a) => a.status)).toEqual(["failed", "succeeded"]);
  });

  renewalTest("a cancellation scheduled for period end ends it instead of charging", async () => {
    const f = await seed({ cancelAtPeriodEnd: true });
    const { charger, charges } = fakeTap();

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(0.1), silentLogger);

    expect(chargesFor(f, charges)).toHaveLength(0);
    expect((await readState(f)).status).toBe("canceled");
  });

  renewalTest("does nothing before the period ends", async () => {
    const f = await seed();
    const { charger, charges } = fakeTap();

    await runTapRenewals(db!, charger, WEBHOOK_URL, at(-1), silentLogger);

    expect(chargesFor(f, charges)).toHaveLength(0);
    expect((await readState(f)).attempts).toHaveLength(0);
  });
});
