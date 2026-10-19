/**
 * Subscription refund requests, against a real database: filing (school plan and AI add-on), the
 * one-open-request rule, and the console's approve/reject workflow with its provider call and audit
 * rows.
 *
 * The fixture school has customers at both providers, so by the Tap-first rule its refunds go to
 * Tap; the provider is a spy that lists one paid and one unpaid payment.
 *
 * Skipped unless TEST_DATABASE_URL is set.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { integrationEnabled } from "../../../../tests/harness";
import { CodedHttpException } from "../../../coded-http-exception";
import { PaymentProviderError } from "../ports/payment-provider";
import {
  approveRefundRequest,
  createAiRefundRequest,
  createSchoolRefundRequest,
  listMyAiRefundRequests,
  listPlatformRefundRequests,
  listSchoolRefundRequests,
  rejectRefundRequest,
} from "../services/refund-service";

import { createBillingDatabase, createBillingFixture } from "./webhook-fixture";

import type { BillingFixture } from "./webhook-fixture";
import type { TestDatabase } from "../../../../tests/harness";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { InvoiceSummary, PaymentProviderPort, RefundInput } from "../ports/payment-provider";
import type { PlatformActor } from "../services/refund-service";
import type { TransactionSql } from "postgres";

const integrationTest = test.skipIf(!integrationEnabled);

let database: TestDatabase | null = null;

beforeAll(async () => {
  if (!integrationEnabled) return;
  database = await createBillingDatabase();
}, 60_000);

afterAll(async () => {
  await database?.cleanup();
  database = null;
});

function invoice(id: string, status: string, amountPaid: number): InvoiceSummary {
  const created = new Date("2026-09-01T00:00:00Z");
  return {
    id,
    status,
    amountDue: 15_000,
    amountPaid,
    currency: "USD",
    created,
    periodStart: created,
    periodEnd: new Date("2026-10-01T00:00:00Z"),
    hostedInvoiceUrl: null,
    invoicePdf: null,
  };
}

function providerSpy(options: { failRefund?: boolean } = {}) {
  const refunds: RefundInput[] = [];
  const cancellations: string[] = [];
  const state = { failRefund: options.failRefund ?? false };
  const port = {
    async listInvoices() {
      return {
        invoices: [invoice("chg_paid", "paid", 15_000), invoice("chg_open", "open", 0)],
        hasMore: false,
      };
    },
    async refund(input: RefundInput) {
      refunds.push(input);
      if (state.failRefund) {
        throw new PaymentProviderError(502, "TAP_API_ERROR", "Tap refused the refund");
      }
      return { providerRefundId: `re_${refunds.length}`, status: "succeeded" as const };
    },
    async scheduleCancellation(input: { providerSubscriptionId: string }) {
      cancellations.push(input.providerSubscriptionId);
    },
  } as unknown as PaymentProviderPort;
  const providers: PaymentProviderRegistry = { stripe: port, tap: port };
  return { providers, refunds, cancellations, state };
}

async function asAdmin<T>(
  f: BillingFixture,
  schoolId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return f.db.sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_admin");
    await tx`SELECT set_config('app.school_id', ${schoolId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** The fixture's one user (the student's account). */
async function studentUserId(f: BillingFixture): Promise<string> {
  const [row] = await asAdmin(
    f,
    f.schoolId,
    (tx) => tx<{ user_id: string }[]>`
      SELECT user_id FROM app.students WHERE id = ${f.studentId}::uuid
    `,
  );
  return row!.user_id;
}

async function addUser(f: BillingFixture, label: string): Promise<string> {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@local`;
  const [row] = await asAdmin(
    f,
    f.schoolId,
    (tx) => tx<{ id: string }[]>`
      INSERT INTO app.users (school_id, email, normalized_email, display_name, status)
      VALUES (${f.schoolId}::uuid, ${email}, ${email}, ${label}, 'active')
      RETURNING id
    `,
  );
  return row!.id;
}

async function addAiSubscription(f: BillingFixture): Promise<string> {
  const [row] = await asAdmin(
    f,
    f.schoolId,
    (tx) => tx<{ id: string }[]>`
      INSERT INTO app.ai_subscriptions (
        school_id, student_id, status, current_period_start, current_period_end
      ) VALUES (
        ${f.schoolId}::uuid, ${f.studentId}::uuid, 'active',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '30 days'
      )
      RETURNING id
    `,
  );
  return row!.id;
}

async function auditStatuses(f: BillingFixture, schoolId: string, requestId: string) {
  const rows = await asAdmin(
    f,
    schoolId,
    (tx) => tx<{ actor_id: string | null; new_values: { status?: string } }[]>`
      SELECT actor_id::text AS actor_id, new_values FROM app.audit_logs
      WHERE target_table = 'subscription_refund_requests' AND target_id = ${requestId}::uuid
      ORDER BY created_at, id
    `,
  );
  return rows.map((r) => ({ actor: r.actor_id, status: r.new_values.status ?? "filed" }));
}

/** A platform operator: a user of another school. */
async function operator(): Promise<PlatformActor> {
  const home = await createBillingFixture(database!);
  return {
    userId: await studentUserId(home),
    schoolId: home.schoolId,
    requestId: crypto.randomUUID(),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  const error: unknown = await promise.catch((e: unknown) => e);
  if (error instanceof CodedHttpException) return error.code;
  return undefined;
}

const ctx = (f: BillingFixture, userId: string) => ({
  schoolId: f.schoolId,
  userId,
  requestId: crypto.randomUUID(),
});

describe("filing a refund request", () => {
  integrationTest(
    "a school request records the named paid payment; a second is refused",
    async () => {
      const f = await createBillingFixture(database!);
      const userId = await studentUserId(f);
      const { providers } = providerSpy();

      const request = await createSchoolRefundRequest(f.db.sql, providers, {
        paymentReference: "chg_paid",
        reason: "duplicate_charge",
        details: "  Charged twice  ",
        tenantContext: ctx(f, userId),
      });

      expect(request).toMatchObject({
        scope: "school",
        status: "pending",
        paymentReference: "chg_paid",
        amountMinor: 15_000,
        currencyCode: "USD",
        details: "Charged twice",
      });
      expect(await auditStatuses(f, f.schoolId, request.id)).toEqual([
        { actor: userId, status: "filed" },
      ]);

      expect(
        await codeOf(
          createSchoolRefundRequest(f.db.sql, providers, {
            reason: "other",
            tenantContext: ctx(f, userId),
          }),
        ),
      ).toBe("SUBSCRIPTION_REFUND_ALREADY_REQUESTED");

      const listed = await listSchoolRefundRequests(f.db.sql, ctx(f, userId));
      expect(listed.map((r) => r.id)).toEqual([request.id]);
    },
  );

  integrationTest("a payment that is not a paid charge cannot be named", async () => {
    const f = await createBillingFixture(database!);
    const { providers } = providerSpy();

    for (const paymentReference of ["chg_open", "chg_missing"]) {
      expect(
        await codeOf(
          createSchoolRefundRequest(f.db.sql, providers, {
            paymentReference,
            reason: "other",
            tenantContext: ctx(f, await studentUserId(f)),
          }),
        ),
      ).toBe("SUBSCRIPTION_REFUND_PAYMENT_NOT_REFUNDABLE");
    }
  });

  integrationTest("the student may ask about their own AI add-on; nobody else may", async () => {
    const f = await createBillingFixture(database!);
    await addAiSubscription(f);
    const studentUser = await studentUserId(f);
    const stranger = await addUser(f, "stranger");

    expect(
      await codeOf(
        createAiRefundRequest(f.db.sql, {
          studentId: f.studentId,
          reason: "accidental_purchase",
          tenantContext: ctx(f, stranger),
        }),
      ),
    ).toBe("RESOURCE_NOT_FOUND");

    const request = await createAiRefundRequest(f.db.sql, {
      studentId: f.studentId,
      reason: "accidental_purchase",
      tenantContext: ctx(f, studentUser),
    });
    expect(request).toMatchObject({ scope: "ai", status: "pending", paymentReference: null });

    expect((await listMyAiRefundRequests(f.db.sql, ctx(f, studentUser))).length).toBe(1);
    expect((await listMyAiRefundRequests(f.db.sql, ctx(f, stranger))).length).toBe(0);
  });
});

describe("reviewing a refund request", () => {
  integrationTest(
    "approval refunds a partial amount at the provider and is audited in both schools",
    async () => {
      const f = await createBillingFixture(database!);
      const actor = await operator();
      const spy = providerSpy();
      const filed = await createSchoolRefundRequest(f.db.sql, spy.providers, {
        paymentReference: "chg_paid",
        reason: "service_issue",
        tenantContext: ctx(f, await studentUserId(f)),
      });

      expect(
        await codeOf(
          approveRefundRequest(
            f.db.sql,
            spy.providers,
            f.schoolId,
            filed.id,
            { amountMinor: 15_001 },
            actor,
          ),
        ),
      ).toBe("SUBSCRIPTION_REFUND_AMOUNT_EXCEEDS_PAYMENT");

      const result = await approveRefundRequest(
        f.db.sql,
        spy.providers,
        f.schoolId,
        filed.id,
        { amountMinor: 5_000, cancelSubscription: true },
        actor,
      );

      expect(result.request).toMatchObject({
        status: "refunded",
        refundedAmountMinor: 5_000,
        providerRefundId: "re_1",
        reviewedBy: actor.userId,
      });
      expect(result.cancellation).toBe("scheduled");
      expect(spy.refunds).toHaveLength(1);
      expect(spy.refunds[0]).toMatchObject({
        invoiceId: "chg_paid",
        amountMinor: 5_000,
        currency: "USD",
      });
      expect(spy.cancellations).toEqual([f.stripeSubscriptionId]);

      expect(
        await codeOf(
          approveRefundRequest(f.db.sql, spy.providers, f.schoolId, filed.id, {}, actor),
        ),
      ).toBe("SUBSCRIPTION_REFUND_INVALID_TRANSITION");

      const inSchool = await auditStatuses(f, f.schoolId, filed.id);
      expect(inSchool.filter((r) => r.actor === null).map((r) => r.status)).toEqual([
        "approved",
        "refunded",
      ]);
      const inHome = await auditStatuses(f, actor.schoolId, filed.id);
      expect(inHome).toEqual([
        { actor: actor.userId, status: "approved" },
        { actor: actor.userId, status: "refunded" },
      ]);
    },
  );

  integrationTest(
    "a provider failure is recorded as failed and may be approved again",
    async () => {
      const f = await createBillingFixture(database!);
      await addAiSubscription(f);
      const actor = await operator();
      const spy = providerSpy({ failRefund: true });
      const filed = await createAiRefundRequest(f.db.sql, {
        studentId: f.studentId,
        reason: "no_longer_needed",
        tenantContext: ctx(f, await studentUserId(f)),
      });

      // An AI request names no payment, so the reviewer must.
      expect(
        await codeOf(
          approveRefundRequest(f.db.sql, spy.providers, f.schoolId, filed.id, {}, actor),
        ),
      ).toBe("SUBSCRIPTION_REFUND_PAYMENT_REQUIRED");

      const failure: unknown = await approveRefundRequest(
        f.db.sql,
        spy.providers,
        f.schoolId,
        filed.id,
        { paymentReference: "chg_paid" },
        actor,
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(PaymentProviderError);

      const afterFailure = await listPlatformRefundRequests(f.db.sql, {
        schoolId: f.schoolId,
        limit: 25,
        offset: 0,
      });
      expect(afterFailure.requests[0]).toMatchObject({
        status: "failed",
        failureMessage: "Tap refused the refund",
      });

      spy.state.failRefund = false;
      const retried = await approveRefundRequest(
        f.db.sql,
        spy.providers,
        f.schoolId,
        filed.id,
        { paymentReference: "chg_paid" },
        actor,
      );
      expect(retried.request).toMatchObject({ status: "refunded", refundedAmountMinor: 15_000 });
      expect(retried.cancellation).toBe("not_requested");
      // Two attempts, two keys: the retry is not a replay of the failed call.
      expect(new Set(spy.refunds.map((r) => r.idempotencyKey)).size).toBe(2);
    },
  );

  integrationTest("rejection needs a pending request and records the note", async () => {
    const f = await createBillingFixture(database!);
    const actor = await operator();
    const { providers } = providerSpy();
    const filed = await createSchoolRefundRequest(f.db.sql, providers, {
      reason: "other",
      tenantContext: ctx(f, await studentUserId(f)),
    });

    const rejected = await rejectRefundRequest(
      f.db.sql,
      f.schoolId,
      filed.id,
      "  Outside the refund window  ",
      actor,
    );
    expect(rejected).toMatchObject({ status: "rejected", reviewNote: "Outside the refund window" });

    expect(await codeOf(rejectRefundRequest(f.db.sql, f.schoolId, filed.id, "again", actor))).toBe(
      "SUBSCRIPTION_REFUND_INVALID_TRANSITION",
    );

    // Closed, so the school may file again.
    const again = await createSchoolRefundRequest(f.db.sql, providers, {
      reason: "other",
      tenantContext: ctx(f, await studentUserId(f)),
    });
    const page = await listPlatformRefundRequests(f.db.sql, {
      schoolId: f.schoolId,
      status: "pending",
      limit: 25,
      offset: 0,
    });
    expect(page.requests.map((r) => r.id)).toEqual([again.id]);
    expect(page.pendingCount).toBe(1);
  });
});
