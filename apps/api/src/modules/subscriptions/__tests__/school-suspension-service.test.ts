/**
 * Integration coverage for pausing/resuming a school's AI subscriptions on suspension (real
 * Postgres, real RLS, real transactions -- only the provider is stubbed, the same convention
 * webhook-fixture.ts documents for the Stripe boundary).
 */

import { DOMAIN_EVENTS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../../../packages/db/tests/helpers";
import {
  pauseAiSubscriptionsForSchoolSuspension,
  resumeAiSubscriptionsForSchoolReactivation,
} from "../services/school-suspension-service";

import {
  createBillingDatabase,
  createBillingFixture,
  readAuditRows,
  silentLogger,
} from "./webhook-fixture";

import type { BillingFixture } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let db: TestDatabase | undefined;

beforeAll(async () => {
  if (!integrationEnabled) return;
  db = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  if (!db) return;
  await db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx.unsafe("TRUNCATE app.outbox_events, app.audit_logs");
  });
});

/** Records every pause/resume call it receives; every other port method is unused by this path. */
function createProviderSpy(): PaymentProviderPort & {
  paused: string[];
  resumed: string[];
} {
  const unsupported = (): never => {
    throw new Error("not used by the school-suspension path");
  };
  const paused: string[] = [];
  const resumed: string[] = [];

  return {
    paused,
    resumed,
    createCustomer: unsupported,
    createCheckoutSession: unsupported,
    createBillingPortalSession: unsupported,
    syncProduct: unsupported,
    syncPrice: unsupported,
    parseWebhook: unsupported,
    lookupProductById: unsupported,
    lookupPriceById: unsupported,
    async pauseSubscription(input: { providerSubscriptionId: string }) {
      paused.push(input.providerSubscriptionId);
    },
    async resumeSubscription(input: { providerSubscriptionId: string }) {
      resumed.push(input.providerSubscriptionId);
    },
  };
}

interface SeededAiSubscription {
  id: string;
  studentEmail: string;
  stripeSubscriptionId: string;
}

/** Seed one AI subscription for the fixture's student, at a given status. */
async function seedAiSubscription(
  fixture: BillingFixture,
  status: string,
): Promise<SeededAiSubscription> {
  const stripeSubscriptionId = `sub_ai_${crypto.randomUUID().replaceAll("-", "").slice(0, 14)}`;

  return fixture.db.sql.begin(async (tx: TransactionSql) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;

    const [ai] = await tx<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions (
        school_id, student_id, status, current_period_start, current_period_end, stripe_subscription_id
      ) VALUES (
        ${fixture.schoolId}::uuid, ${fixture.studentId}::uuid, ${status}::app.subscription_status,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days', ${stripeSubscriptionId}
      )
      RETURNING id
    `;

    // createBillingFixture seeds the student's user with a single-label "@local" address, which is
    // fine for the tests that never validate it against a real email schema. This one does (the
    // notification payload is `z.string().email()`), so it needs a domain with a real TLD.
    const realisticEmail = `student-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const [row] = await tx<{ email: string }[]>`
      UPDATE app.users
      SET normalized_email = ${realisticEmail}, email = ${realisticEmail}
      WHERE id = (SELECT user_id FROM app.students WHERE id = ${fixture.studentId}::uuid)
      RETURNING normalized_email AS email
    `;

    return { id: ai!.id, studentEmail: row!.email, stripeSubscriptionId };
  });
}

async function readAiStatus(fixture: BillingFixture, aiSubscriptionId: string): Promise<string> {
  const rows = await fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ status: string }[]>`
      SELECT status::text AS status FROM app.ai_subscriptions WHERE id = ${aiSubscriptionId}::uuid
    `;
  });
  return rows[0]!.status;
}

async function readOutboxEvents(
  fixture: BillingFixture,
): Promise<{ event_name: string; payload: Record<string, unknown> }[]> {
  return fixture.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${fixture.schoolId}, true)`;
    return tx<{ event_name: string; payload: Record<string, unknown> }[]>`
      SELECT event_name, payload
      FROM app.outbox_events
      WHERE school_id = ${fixture.schoolId}::uuid
      ORDER BY created_at
    `;
  });
}

describe("pauseAiSubscriptionsForSchoolSuspension", () => {
  integrationTest(
    "pauses an active AI subscription, calls the provider, notifies the student",
    async () => {
      const fixture = await createBillingFixture(db!);
      const ai = await seedAiSubscription(fixture, "active");
      const provider = createProviderSpy();

      const result = await pauseAiSubscriptionsForSchoolSuspension(
        fixture.db.sql,
        provider,
        fixture.schoolId,
        silentLogger,
      );

      expect(result.affected).toBe(1);
      expect(await readAiStatus(fixture, ai.id)).toBe("paused");
      expect(provider.paused).toEqual([ai.stripeSubscriptionId]);
      expect(provider.resumed).toEqual([]);

      const events = await readOutboxEvents(fixture);
      const paused = events.find((e) => e.event_name === DOMAIN_EVENTS.AI_SUBSCRIPTION_PAUSED);
      expect(paused).toBeDefined();
      expect(paused!.payload).toMatchObject({
        schoolId: fixture.schoolId,
        aiSubscriptionId: ai.id,
        studentId: fixture.studentId,
        email: ai.studentEmail,
      });

      const audit = await readAuditRows(fixture);
      const auditRow = audit.find((r) => r.target_id === ai.id);
      expect(auditRow).toBeDefined();
      expect(auditRow!.old_values.status).toBe("active");
      expect(auditRow!.new_values.status).toBe("paused");
    },
  );

  integrationTest("pausing twice is a no-op the second time — no double Stripe call", async () => {
    const fixture = await createBillingFixture(db!);
    const ai = await seedAiSubscription(fixture, "active");
    const provider = createProviderSpy();

    await pauseAiSubscriptionsForSchoolSuspension(
      fixture.db.sql,
      provider,
      fixture.schoolId,
      silentLogger,
    );
    const second = await pauseAiSubscriptionsForSchoolSuspension(
      fixture.db.sql,
      provider,
      fixture.schoolId,
      silentLogger,
    );

    expect(second.affected).toBe(0);
    expect(provider.paused).toEqual([ai.stripeSubscriptionId]);
    expect(await readAiStatus(fixture, ai.id)).toBe("paused");
  });

  integrationTest("leaves a canceled AI subscription untouched", async () => {
    const fixture = await createBillingFixture(db!);
    const ai = await seedAiSubscription(fixture, "canceled");
    const provider = createProviderSpy();

    const result = await pauseAiSubscriptionsForSchoolSuspension(
      fixture.db.sql,
      provider,
      fixture.schoolId,
      silentLogger,
    );

    expect(result.affected).toBe(0);
    expect(provider.paused).toEqual([]);
    expect(await readAiStatus(fixture, ai.id)).toBe("canceled");
  });
});

describe("resumeAiSubscriptionsForSchoolReactivation", () => {
  integrationTest(
    "resumes a paused AI subscription to active, calls the provider, notifies the student",
    async () => {
      const fixture = await createBillingFixture(db!);
      const ai = await seedAiSubscription(fixture, "paused");
      const provider = createProviderSpy();

      const result = await resumeAiSubscriptionsForSchoolReactivation(
        fixture.db.sql,
        provider,
        fixture.schoolId,
        silentLogger,
      );

      expect(result.affected).toBe(1);
      expect(await readAiStatus(fixture, ai.id)).toBe("active");
      expect(provider.resumed).toEqual([ai.stripeSubscriptionId]);
      expect(provider.paused).toEqual([]);

      const events = await readOutboxEvents(fixture);
      const resumed = events.find((e) => e.event_name === DOMAIN_EVENTS.AI_SUBSCRIPTION_RESUMED);
      expect(resumed).toBeDefined();
      expect(resumed!.payload).toMatchObject({
        schoolId: fixture.schoolId,
        aiSubscriptionId: ai.id,
        studentId: fixture.studentId,
        email: ai.studentEmail,
      });
    },
  );

  integrationTest("resuming an active (never-paused) AI subscription is a no-op", async () => {
    const fixture = await createBillingFixture(db!);
    const ai = await seedAiSubscription(fixture, "active");
    const provider = createProviderSpy();

    const result = await resumeAiSubscriptionsForSchoolReactivation(
      fixture.db.sql,
      provider,
      fixture.schoolId,
      silentLogger,
    );

    expect(result.affected).toBe(0);
    expect(provider.resumed).toEqual([]);
    expect(await readAiStatus(fixture, ai.id)).toBe("active");
  });
});
