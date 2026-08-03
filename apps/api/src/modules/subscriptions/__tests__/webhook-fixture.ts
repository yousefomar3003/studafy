/**
 * Shared setup for the Stripe webhook integration suite (ST-132).
 *
 * ## One database per file, one school per test
 *
 * Migrating a database costs a couple of seconds — there are 79 migrations — so doing it per test
 * blows Bun's default 5s timeout as soon as the server is under any load, and turns a correctness
 * suite into a flakiness generator. The database is therefore created and migrated once
 * (`createBillingDatabase`) and each test gets a fresh *school* instead (`createBillingFixture`).
 *
 * That is real isolation, not a shortcut: every subscription table is tenant-isolated, so two
 * schools cannot see each other's rows. The one table that is global is `app.billing_events`, which
 * `resetBillingEvents` truncates between tests — cheap, and explicit about the one thing schools do
 * not separate.
 *
 * ## The provider stub
 *
 * Not a shortcut around the thing under test. Signature verification is the one part of the pipeline
 * that genuinely cannot run without Stripe's signing secret, and `webhook-signature.test.ts`
 * exercises it through the stub's `shouldReject` switch — which produces exactly what
 * `constructEvent` produces on a bad signature, a throw. Everything downstream is real: real SQL,
 * real RLS, real transactions, real audit rows.
 */

import { createTestDatabase, migrateDatabase } from "../../../../tests/harness";

import type { TestDatabase } from "../../../../tests/harness";
import type { Logger } from "../../../logger";
import type { ParsedWebhookEvent, PaymentProviderPort } from "../ports/payment-provider";

export interface StubEventInput {
  id: string;
  type: string;
  /** Unix seconds, as Stripe sends. */
  created: number;
  data: Record<string, unknown>;
}

export interface ProviderStub extends PaymentProviderPort {
  /** Make `parseWebhook` throw, as a bad signature would. */
  shouldReject: boolean;
}

/**
 * A provider whose `parseWebhook` decodes the body it was handed.
 *
 * The route passes the raw request bytes straight through, so a test can send a JSON envelope and
 * get back the same envelope — which keeps the fixture honest about *which* fields the processor
 * actually reads (`id` and `created` off the envelope, not `data.id`).
 */
export function createProviderStub(): ProviderStub {
  const unsupported = () => {
    throw new Error("not used by the webhook path");
  };

  const stub: ProviderStub = {
    shouldReject: false,

    parseWebhook(payload: Buffer, signature: string): Promise<ParsedWebhookEvent> {
      if (!signature) return Promise.reject(new Error("no signature"));
      if (stub.shouldReject) return Promise.reject(new Error("signature verification failed"));

      const envelope = JSON.parse(payload.toString("utf8")) as StubEventInput;
      return Promise.resolve({
        id: envelope.id,
        type: envelope.type,
        effectiveAt: new Date(envelope.created * 1000),
        livemode: false,
        data: envelope.data,
      });
    },

    createCustomer: unsupported,
    createCheckoutSession: unsupported,
    createBillingPortalSession: unsupported,
    syncProduct: unsupported,
    syncPrice: unsupported,
    lookupProductById: unsupported,
    lookupPriceById: unsupported,
    pauseSubscription: unsupported,
    resumeSubscription: unsupported,
  } as ProviderStub;

  return stub;
}

/** Serialize an event the way Stripe would put it on the wire. */
export function encodeEvent(event: StubEventInput): Buffer {
  return Buffer.from(JSON.stringify(event), "utf8");
}

/** A logger that records nothing. Test output should be assertions, not log lines. */
export const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** Create and migrate the one database a whole test file shares. Call from `beforeAll`. */
export async function createBillingDatabase(): Promise<TestDatabase> {
  const db = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(db.url);
  return db;
}

export interface BillingFixture {
  db: TestDatabase;
  schoolId: string;
  studentId: string;
  subscriptionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
}

/**
 * One school with a Stripe customer id and a `trialing` subscription, in an already-migrated
 * database.
 *
 * Seeded as `studafy_admin` with the tenant GUC set, the way apps/api/tests/harness/factories.ts
 * does: `app.subscriptions` is RLS-forced, so a seed without the GUC would insert nothing and every
 * assertion downstream would fail for a reason unrelated to the code under test.
 */
export async function createBillingFixture(db: TestDatabase): Promise<BillingFixture> {
  const stripeCustomerId = `cus_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;
  const stripeSubscriptionId = `sub_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;

  const seeded = await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'US') AS country,
        (SELECT id FROM app.currencies WHERE code = 'USD') AS currency
    `;

    const slug = `billing-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id, stripe_customer_id)
      VALUES (
        ${slug}, ${`Billing School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
        ${reference!.country}, ${reference!.currency}, ${stripeCustomerId}
      )
      RETURNING id
    `;
    const schoolId = school!.id;

    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    // Plans are seeded by db/seeds, not by migrations, so a freshly migrated database has none.
    // Created per school rather than shared, so nothing here depends on what the seed set offers.
    const [plan] = await tx<{ id: string }[]>`
      INSERT INTO app.plans (code, display_name, is_active)
      VALUES (${`plan_${slug.replaceAll("-", "_")}`}, 'Billing Test Plan', true)
      RETURNING id
    `;

    const [subscription] = await tx<{ id: string }[]>`
      INSERT INTO app.subscriptions (
        school_id, plan_id, status, current_period_start, current_period_end, stripe_subscription_id
      ) VALUES (
        ${schoolId}::uuid, ${plan!.id}::uuid, 'trialing',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', ${stripeSubscriptionId}
      )
      RETURNING id
    `;

    const [user] = await tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (
        ${schoolId}::uuid, ${`student-${slug}@local`}, ${`student-${slug}@local`}, 'Test Student', 'active'
      )
      RETURNING id
    `;

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (
        ${schoolId}::uuid, ${user!.id}::uuid, ${`ADM-${slug.slice(-6)}`}, 'Test', 'Student', 'enrolled'
      )
      RETURNING id
    `;

    return { schoolId, subscriptionId: subscription!.id, studentId: student!.id };
  });

  return { db, ...seeded, stripeCustomerId, stripeSubscriptionId };
}

/**
 * Clear the one table schools do not separate.
 *
 * `app.billing_events` is global by design (see 000016), so without this a test's `readBillingEvents`
 * would see every earlier test's rows. TRUNCATE rather than DELETE because it is a whole-table reset
 * and there is nothing to preserve.
 */
export async function resetBillingEvents(db: TestDatabase): Promise<void> {
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx.unsafe("TRUNCATE app.billing_events");
  });
}

/** Read one subscription's current status, bypassing nothing: still as admin, still tenant-scoped. */
export async function readSubscriptionStatus(
  fixture: BillingFixture,
  subscriptionId: string,
): Promise<string> {
  const rows = await fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.subscriptions WHERE id = ${subscriptionId}::uuid
    `;
  });
  return rows[0]!.status;
}

export async function readAiSubscriptionStatuses(fixture: BillingFixture): Promise<string[]> {
  const rows = await fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.ai_subscriptions
      WHERE school_id = ${fixture.schoolId}::uuid
      ORDER BY created_at
    `;
  });
  return rows.map((r) => r.status);
}

export async function readBillingEvents(
  fixture: BillingFixture,
): Promise<{ provider_event_id: string; status: string; last_error: string | null }[]> {
  return fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    return tx<{ provider_event_id: string; status: string; last_error: string | null }[]>`
      SELECT provider_event_id, status::text AS status, last_error
      FROM app.billing_events
      ORDER BY effective_at, provider_event_id
    `;
  });
}

export interface AuditRow {
  target_table: string;
  target_id: string;
  actor_id: string | null;
  old_values: { status: string };
  new_values: { status: string };
}

/** This school's subscription audit trail. Tenant-scoped, so a sibling school's rows never appear. */
export async function readAuditRows(fixture: BillingFixture): Promise<AuditRow[]> {
  return fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<AuditRow[]>`
      SELECT target_table, target_id::text AS target_id, actor_id::text AS actor_id,
             old_values, new_values
      FROM app.audit_logs
      WHERE target_table IN ('subscriptions', 'ai_subscriptions')
      ORDER BY created_at
    `;
  });
}
