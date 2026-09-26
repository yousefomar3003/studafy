/**
 * Online fee collection (ST-298), against a real database.
 *
 * The provider and ERPNext are fakes that record what they were asked; everything between them is
 * real SQL under RLS. The properties under test are the ones money depends on: the amount comes
 * from the invoice and never the client, only a linked parent (or billing staff) can start a
 * payment, one payment per invoice is in flight at a time, and settlement records exactly one
 * ERPNext Payment Entry however many times the provider delivers the webhook.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestDatabase, integrationEnabled, migrateDatabase } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import {
  feePaymentResult,
  getOnlineFeePayment,
  settleOnlineFeePayment,
  startOnlineFeePayment,
} from "../online-payments/service";

import type { TestDatabase } from "../../../../tests/harness";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type {
  CreateCustomerInput,
  CreatePaymentSessionInput,
  ParsedWebhookEvent,
  PaymentProviderPort,
} from "../../subscriptions/ports/payment-provider";
import type { TenantErpNextFactory } from "../client/tenant-client";

const integrationTest = test.skipIf(!integrationEnabled);

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createTestDatabase({ maxConnections: 8 });
  await migrateDatabase(database.url);
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeTapProvider() {
  const customers: CreateCustomerInput[] = [];
  const sessions: CreatePaymentSessionInput[] = [];
  const port = {
    async createCustomer(input: CreateCustomerInput) {
      customers.push(input);
      return { providerCustomerId: `cus_TS_payer_${crypto.randomUUID().slice(0, 12)}` };
    },
    async createPaymentSession(input: CreatePaymentSessionInput) {
      sessions.push(input);
      const id = `chg_TS_fee_${crypto.randomUUID().slice(0, 8)}`;
      return { url: `https://checkout.tap.test/${id}`, sessionId: id };
    },
  } as unknown as PaymentProviderPort;
  return { port, customers, sessions };
}

function fakeErpNext() {
  const posted: unknown[] = [];
  const factory = {
    async forSchool() {
      return {
        async get() {
          throw new Error("not used: the party comes from the cached invoice");
        },
        async post(_path: string, body: unknown) {
          posted.push(body);
          return { data: { data: { name: `ACC-PAY-${posted.length}`, docstatus: 1 } } };
        },
      };
    },
  } as unknown as TenantErpNextFactory;
  return { factory, posted };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface Fixture {
  schoolId: string;
  studentId: string;
  parent: AuthContext;
  stranger: AuthContext;
  invoiceId: string;
}

function authFor(userId: string, schoolId: string, roles: string[]): AuthContext {
  return {
    userId,
    schoolId,
    roles,
    channel: "web",
    jti: crypto.randomUUID(),
    entitlementsVer: 0,
  } as unknown as AuthContext;
}

async function seed(): Promise<Fixture> {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");

    const [reference] = await tx<{ country: string; currency: string }[]>`
      SELECT
        (SELECT id FROM app.countries WHERE alpha2_code = 'JO') AS country,
        (SELECT id FROM app.currencies WHERE code = 'JOD') AS currency
    `;
    const slug = `fee-${crypto.randomUUID().slice(0, 8)}`;
    const [school] = await tx<{ id: string }[]>`
      INSERT INTO app.schools (slug, name, email, normalized_email, country_id, default_currency_id)
      VALUES (${slug}, ${`Fee School ${slug}`}, ${`${slug}@admin.local`}, ${`${slug}@admin.local`},
              ${reference!.country}, ${reference!.currency})
      RETURNING id
    `;
    const schoolId = school!.id;
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;

    const user = async (label: string) => {
      const email = `${label}-${slug}@local`;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
        VALUES (${schoolId}::uuid, ${email}, ${email}, ${label}, 'active')
        RETURNING id
      `;
      return row!.id;
    };

    const parentId = await user("parent");
    const strangerId = await user("stranger");
    const studentUserId = await user("student");

    const [student] = await tx<{ id: string }[]>`
      INSERT INTO app.students (school_id, user_id, admission_number, first_name, last_name, status)
      VALUES (${schoolId}::uuid, ${studentUserId}::uuid, ${`ADM-${slug}`}, 'Lina', 'H', 'enrolled')
      RETURNING id
    `;
    const [family] = await tx<{ id: string }[]>`
      INSERT INTO app.families (school_id, display_name, primary_parent_user_id)
      VALUES (${schoolId}::uuid, 'H family', ${parentId}::uuid)
      RETURNING id
    `;
    await tx`
      INSERT INTO app.parent_child_links (school_id, parent_user_id, student_id, relationship, family_id)
      VALUES (${schoolId}::uuid, ${parentId}::uuid, ${student!.id}::uuid, 'mother', ${family!.id}::uuid)
    `;

    const invoiceId = `ACC-SINV-${slug}`;
    await tx`
      INSERT INTO app.invoice_cache (
        school_id, student_id, currency_id, erpnext_docname, erpnext_status,
        total_amount_minor, outstanding_amount_minor, issued_date, erpnext_payload, last_synced_at
      ) VALUES (
        ${schoolId}::uuid, ${student!.id}::uuid, ${reference!.currency}::uuid, ${invoiceId}, 'Unpaid',
        150000, 120500, CURRENT_DATE, ${tx.json({ customer: "CUST-H" })}, CURRENT_TIMESTAMP
      )
    `;

    return {
      schoolId,
      studentId: student!.id,
      parent: authFor(parentId, schoolId, ["PARENT"]),
      stranger: authFor(strangerId, schoolId, ["PARENT"]),
      invoiceId,
    };
  });
}

const start = (
  f: Fixture,
  providers: { stripe: null; tap: PaymentProviderPort },
  auth = f.parent,
) =>
  startOnlineFeePayment(database!.sql, providers, auth, undefined, {
    student_id: f.studentId,
    invoice_id: f.invoiceId,
    success_url: "https://app.studafy.test/fees/return",
    cancel_url: "https://app.studafy.test/fees",
  });

/** The event the Tap normalizer would produce for this charge. */
function tapFeeEvent(
  f: Fixture,
  paymentId: string,
  chargeId: string,
  status: "CAPTURED" | "DECLINED",
  amount = 120.5,
): ParsedWebhookEvent {
  return {
    id: `${chargeId}:${status}`,
    type: status === "CAPTURED" ? "charge.succeeded" : "charge.failed",
    effectiveAt: new Date(),
    livemode: false,
    data: {
      id: chargeId,
      object: "charge",
      customer: "cus_TS_payer",
      metadata: { purpose: "fee_payment", online_payment_id: paymentId, school_id: f.schoolId },
      amount,
      currency: "JOD",
      status,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("feePaymentResult", () => {
  test("reads Tap and Stripe outcomes in minor units", () => {
    const tap = feePaymentResult("tap", {
      id: "x",
      type: "charge.succeeded",
      effectiveAt: new Date(),
      livemode: false,
      data: { amount: 120.5, currency: "JOD" },
    });
    expect(tap).toEqual({ kind: "succeeded", paidMinor: 120_500, currency: "JOD" });

    const stripePaid = feePaymentResult("stripe", {
      id: "evt",
      type: "checkout.session.completed",
      effectiveAt: new Date(),
      livemode: false,
      data: { payment_status: "paid", amount_total: 9_900, currency: "usd" },
    });
    expect(stripePaid).toEqual({ kind: "succeeded", paidMinor: 9_900, currency: "USD" });

    const stripeAsync = feePaymentResult("stripe", {
      id: "evt",
      type: "checkout.session.completed",
      effectiveAt: new Date(),
      livemode: false,
      data: { payment_status: "unpaid" },
    });
    expect(stripeAsync).toBeNull();
  });
});

describe("online fee payments", () => {
  integrationTest(
    "start charges the invoice's outstanding balance at the region's provider",
    async () => {
      const f = await seed();
      const tap = fakeTapProvider();

      const { payment, checkout_url } = await start(f, { stripe: null, tap: tap.port });

      expect(checkout_url).toStartWith("https://checkout.tap.test/");
      expect(payment).toMatchObject({
        provider: "tap",
        amount_minor: 120_500,
        currency: "JOD",
        status: "pending",
        invoice_id: f.invoiceId,
      });
      expect(tap.sessions[0]).toMatchObject({
        amountMinor: 120_500,
        currency: "JOD",
        metadata: { purpose: "fee_payment", online_payment_id: payment.id, school_id: f.schoolId },
      });
      expect(tap.sessions[0]!.metadata.billing_reason).toBeUndefined();
      expect(tap.customers).toHaveLength(1);
    },
  );

  integrationTest("only a linked parent or billing staff may start a payment", async () => {
    const f = await seed();
    const tap = fakeTapProvider();

    const error: unknown = await start(f, { stripe: null, tap: tap.port }, f.stranger).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CodedHttpException);
    expect((error as CodedHttpException).status).toBe(404);
    expect(tap.sessions).toHaveLength(0);

    const staff = authFor(f.stranger.userId, f.schoolId, ["FINANCE"]);
    const staffStart = await start(f, { stripe: null, tap: tap.port }, staff);
    expect(staffStart.payment.status).toBe("pending");
  });

  integrationTest(
    "a second payment for the same invoice is refused while one is in flight",
    async () => {
      const f = await seed();
      const tap = fakeTapProvider();

      await start(f, { stripe: null, tap: tap.port });
      const error: unknown = await start(f, { stripe: null, tap: tap.port }).catch(
        (e: unknown) => e,
      );

      expect((error as CodedHttpException).status).toBe(409);
      expect(tap.sessions).toHaveLength(1);
    },
  );

  integrationTest("a Tap-region school with no Tap adapter gets 503, not Stripe", async () => {
    const f = await seed();
    const error: unknown = await startOnlineFeePayment(
      database!.sql,
      { stripe: fakeTapProvider().port, tap: null },
      f.parent,
      undefined,
      {
        student_id: f.studentId,
        invoice_id: f.invoiceId,
        success_url: "https://x.test/ok",
        cancel_url: "https://x.test/no",
      },
    ).catch((e: unknown) => e);

    expect((error as CodedHttpException).status).toBe(503);
    expect((error as CodedHttpException).code).toBe("TAP_NOT_CONFIGURED");
  });

  integrationTest("a captured payment is recorded in ERPNext exactly once", async () => {
    const f = await seed();
    const tap = fakeTapProvider();
    const erp = fakeErpNext();
    const { payment } = await start(f, { stripe: null, tap: tap.port });
    const sessionId = await sessionIdOf(f, payment.id);

    const event = tapFeeEvent(f, payment.id, sessionId, "CAPTURED");
    const first = await settleOnlineFeePayment(
      database!.sql,
      erp.factory,
      silentLogger,
      "tap",
      event,
    );
    const second = await settleOnlineFeePayment(
      database!.sql,
      erp.factory,
      silentLogger,
      "tap",
      event,
    );

    expect([first, second]).toEqual(["processed", "duplicate"]);
    expect(erp.posted).toHaveLength(1);
    expect(erp.posted[0]).toMatchObject({ paid_amount: 120.5, reference_no: sessionId });

    const settled = await getOnlineFeePayment(database!.sql, f.parent, undefined, payment.id);
    expect(settled).toMatchObject({ status: "succeeded", erpnext_payment_entry_id: "ACC-PAY-1" });
  });

  integrationTest("an amount that differs from the invoice's is parked, not recorded", async () => {
    const f = await seed();
    const tap = fakeTapProvider();
    const erp = fakeErpNext();
    const { payment } = await start(f, { stripe: null, tap: tap.port });

    const event = tapFeeEvent(f, payment.id, await sessionIdOf(f, payment.id), "CAPTURED", 1.0);
    const outcome = await settleOnlineFeePayment(
      database!.sql,
      erp.factory,
      silentLogger,
      "tap",
      event,
    );

    expect(outcome).toBe("parked");
    expect(erp.posted).toHaveLength(0);
    expect((await getOnlineFeePayment(database!.sql, f.parent, undefined, payment.id)).status).toBe(
      "pending",
    );
  });

  integrationTest("an event for another charge cannot settle this payment", async () => {
    const f = await seed();
    const tap = fakeTapProvider();
    const erp = fakeErpNext();
    const { payment } = await start(f, { stripe: null, tap: tap.port });

    const event = tapFeeEvent(f, payment.id, "chg_someone_else", "CAPTURED");
    const outcome = await settleOnlineFeePayment(
      database!.sql,
      erp.factory,
      silentLogger,
      "tap",
      event,
    );

    expect(outcome).toBe("parked");
    expect(erp.posted).toHaveLength(0);
  });

  integrationTest("a declined payment is marked failed and frees the invoice", async () => {
    const f = await seed();
    const tap = fakeTapProvider();
    const erp = fakeErpNext();
    const { payment } = await start(f, { stripe: null, tap: tap.port });

    await settleOnlineFeePayment(
      database!.sql,
      erp.factory,
      silentLogger,
      "tap",
      tapFeeEvent(f, payment.id, await sessionIdOf(f, payment.id), "DECLINED"),
    );

    expect((await getOnlineFeePayment(database!.sql, f.parent, undefined, payment.id)).status).toBe(
      "failed",
    );
    expect(erp.posted).toHaveLength(0);
    // The payer can try again, and their provider customer is reused rather than duplicated.
    const again = await start(f, { stripe: null, tap: tap.port });
    expect(again.payment.status).toBe("pending");
    expect(tap.customers).toHaveLength(1);
  });

  integrationTest("another parent cannot read someone else's payment", async () => {
    const f = await seed();
    const { payment } = await start(f, { stripe: null, tap: fakeTapProvider().port });

    const error: unknown = await getOnlineFeePayment(
      database!.sql,
      f.stranger,
      undefined,
      payment.id,
    ).catch((e: unknown) => e);
    expect((error as CodedHttpException).status).toBe(404);
  });
});

async function sessionIdOf(f: Fixture, paymentId: string): Promise<string> {
  return database!.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${f.schoolId}, true)`;
    const [row] = await tx<{ provider_session_id: string }[]>`
      SELECT provider_session_id FROM app.online_fee_payments WHERE id = ${paymentId}::uuid
    `;
    return row!.provider_session_id;
  });
}
