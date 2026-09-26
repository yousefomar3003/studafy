/**
 * Online fee collection (ST-298): a payer settles an outstanding ERPNext invoice on a provider's
 * hosted page, and the provider's webhook records it in ERPNext.
 *
 * ## Start
 *
 * The amount is the invoice's outstanding balance from `app.invoice_cache`, never a number the
 * client sends. The provider is chosen by the school's region (`selectPaymentProviderForSchool`):
 * Tap in its MENA markets, Stripe elsewhere -- the same rule subscription checkout uses. The payer
 * gets a customer of their own at that provider (`app.payment_provider_customers`), created once.
 *
 * ## Settle
 *
 * The provider's webhook arrives at the shared billing webhook processor, which hands any event
 * whose `metadata.purpose` is `fee_payment` here instead of to the subscription state machine.
 * Settlement is idempotent on the local row: only a `pending` row moves, so a redelivery is a
 * no-op. A successful payment is forwarded to ERPNext through the existing payment forwarder
 * (`createPayment`), keyed on this payment's id, so a webhook retried after ERPNext accepted the
 * entry replays rather than posting twice. The row is marked `succeeded` only once ERPNext holds
 * the Payment Entry; if ERPNext is down the webhook answers 500 and the provider redelivers.
 *
 * ## Why one pending payment per invoice at a time
 *
 * Two payers (or two tabs) paying the same invoice at once would both capture, and the second
 * Payment Entry would overpay the invoice -- money taken that ERPNext then has to refund. A pending
 * payment younger than `PENDING_PAYMENT_WINDOW_MINUTES` therefore blocks a new one for the same
 * invoice.
 */

import { ERROR_CODES, PAYMENT_PURPOSES, PERMISSIONS } from "@studafy/constants";
import { fromTapAmount } from "@studafy/tap-payments";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { hasPermission } from "../../../middleware/authz";
import { selectPaymentProviderForSchool } from "../../subscriptions/payment-provider-routing";
import { fromMinorUnits } from "../currency";
import { createPayment } from "../payments/service";

import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthContext } from "../../../middleware/authContext";
import type {
  PaymentProviderRegistry,
  SelectedPaymentProvider,
} from "../../subscriptions/payment-provider-routing";
import type { ParsedWebhookEvent } from "../../subscriptions/ports/payment-provider";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { BillingProvider } from "@studafy/billing";
import type { TransactionSql } from "postgres";

/** How long a started-but-unfinished payment blocks another for the same invoice. */
export const PENDING_PAYMENT_WINDOW_MINUTES = 30;

export type OnlineFeePaymentStatus = "pending" | "succeeded" | "failed";

export interface OnlineFeePayment {
  id: string;
  student_id: string;
  invoice_id: string;
  provider: BillingProvider;
  amount_minor: number;
  currency: string;
  status: OnlineFeePaymentStatus;
  erpnext_payment_entry_id: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface StartOnlineFeePaymentParams {
  student_id: string;
  invoice_id: string;
  success_url: string;
  cancel_url: string;
}

export interface StartOnlineFeePaymentResult {
  payment: OnlineFeePayment;
  /** The provider's hosted payment page. */
  checkout_url: string;
}

interface PaymentRow {
  id: string;
  school_id: string;
  student_id: string;
  payer_user_id: string;
  erpnext_invoice_id: string;
  provider: BillingProvider;
  provider_session_id: string | null;
  amount_minor: string;
  currency: string;
  currency_minor_unit: number;
  status: OnlineFeePaymentStatus;
  erpnext_payment_docname: string | null;
  created_at: Date;
  settled_at: Date | null;
}

const PAYMENT_COLUMNS = `
  p.id, p.school_id, p.student_id, p.payer_user_id, p.erpnext_invoice_id, p.provider,
  p.provider_session_id, p.amount_minor::text AS amount_minor, c.code AS currency,
  c.minor_unit AS currency_minor_unit, p.status::text AS status, p.erpnext_payment_docname,
  p.created_at, p.settled_at
`;

function toPayment(row: PaymentRow): OnlineFeePayment {
  return {
    id: row.id,
    student_id: row.student_id,
    invoice_id: row.erpnext_invoice_id,
    provider: row.provider,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    erpnext_payment_entry_id: row.erpnext_payment_docname,
    created_at: row.created_at.toISOString(),
    settled_at: row.settled_at ? row.settled_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export async function startOnlineFeePayment(
  database: Database,
  providers: PaymentProviderRegistry,
  auth: AuthContext,
  requestId: string | undefined,
  params: StartOnlineFeePaymentParams,
): Promise<StartOnlineFeePaymentResult> {
  const context = { schoolId: auth.schoolId, userId: auth.userId, requestId };

  return withTenantTx(database, context, async (tx) => {
    await requireMayPayFor(tx, auth, params.student_id);

    const [invoice] = await tx<
      { outstanding: string; currency_id: string; currency: string; minor_unit: number }[]
    >`
      SELECT ic.outstanding_amount_minor::text AS outstanding, ic.currency_id,
             c.code AS currency, c.minor_unit
      FROM app.invoice_cache ic
      JOIN app.currencies c ON c.id = ic.currency_id
      WHERE ic.school_id = ${auth.schoolId}::uuid
        AND ic.erpnext_docname = ${params.invoice_id}
        AND ic.student_id = ${params.student_id}::uuid
    `;

    if (!invoice) {
      throw new CodedHttpException(404, ERROR_CODES.INVOICE_NOT_FOUND, "Invoice not found");
    }
    const amountMinor = Number(invoice.outstanding);
    if (amountMinor <= 0) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.CONFLICT_STATE_MISMATCH,
        "This invoice has nothing outstanding",
      );
    }

    // Serialize starts for one invoice, then refuse if another payment is still in flight.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`online-fee:${auth.schoolId}:${params.invoice_id}`}))`;
    const [inFlight] = await tx<{ id: string }[]>`
      SELECT id FROM app.online_fee_payments
      WHERE school_id = ${auth.schoolId}::uuid
        AND erpnext_invoice_id = ${params.invoice_id}
        AND status = 'pending'
        AND created_at > CURRENT_TIMESTAMP - make_interval(mins => ${PENDING_PAYMENT_WINDOW_MINUTES})
      LIMIT 1
    `;
    if (inFlight) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.PAYMENT_IN_PROGRESS,
        "A payment for this invoice is already in progress; finish it or retry later",
      );
    }

    const selected = await selectPaymentProviderForSchool(tx, providers, auth.schoolId);
    const customerId = await ensurePayerCustomer(tx, selected, auth);

    const [created] = await tx<{ id: string }[]>`
      INSERT INTO app.online_fee_payments (
        school_id, student_id, payer_user_id, erpnext_invoice_id, provider, amount_minor, currency_id
      ) VALUES (
        ${auth.schoolId}::uuid, ${params.student_id}::uuid, ${auth.userId}::uuid,
        ${params.invoice_id}, ${selected.name}, ${amountMinor}, ${invoice.currency_id}::uuid
      )
      RETURNING id
    `;
    const paymentId = created!.id;

    const session = await selected.port.createPaymentSession({
      customerId,
      amountMinor,
      currency: invoice.currency,
      description: `School fees ${params.invoice_id}`,
      successUrl: params.success_url,
      cancelUrl: params.cancel_url,
      metadata: {
        purpose: PAYMENT_PURPOSES.FEE_PAYMENT,
        online_payment_id: paymentId,
        school_id: auth.schoolId,
        student_id: params.student_id,
        invoice_id: params.invoice_id,
      },
    });

    const [row] = await tx<PaymentRow[]>`
      WITH updated AS (
        UPDATE app.online_fee_payments
        SET provider_session_id = ${session.sessionId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${paymentId}::uuid
        RETURNING *
      )
      SELECT ${tx.unsafe(PAYMENT_COLUMNS)}
      FROM updated p JOIN app.currencies c ON c.id = p.currency_id
    `;

    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "online_fee_payments",
      targetId: paymentId,
      newValues: {
        student_id: params.student_id,
        erpnext_invoice_id: params.invoice_id,
        provider: selected.name,
        amount_minor: amountMinor,
        currency: invoice.currency,
      },
    });

    return { payment: toPayment(row!), checkout_url: session.url };
  });
}

export async function getOnlineFeePayment(
  database: Database,
  auth: AuthContext,
  requestId: string | undefined,
  paymentId: string,
): Promise<OnlineFeePayment> {
  return withTenantTx(
    database,
    { schoolId: auth.schoolId, userId: auth.userId, requestId },
    async (tx) => {
      const [row] = await tx<PaymentRow[]>`
        SELECT ${tx.unsafe(PAYMENT_COLUMNS)}
        FROM app.online_fee_payments p JOIN app.currencies c ON c.id = p.currency_id
        WHERE p.school_id = ${auth.schoolId}::uuid AND p.id = ${paymentId}::uuid
      `;

      // The payer sees their own payment; finance staff see any. Anyone else gets the same 404 as
      // a payment that does not exist, so the endpoint does not confirm other people's payments.
      const visible =
        row &&
        (row.payer_user_id === auth.userId || hasPermission(auth.roles, PERMISSIONS.BILLING_READ));
      if (!visible) {
        throw new CodedHttpException(404, ERROR_CODES.PAYMENT_NOT_FOUND, "Payment not found");
      }
      return toPayment(row);
    },
  );
}

/** A linked parent of the student, or staff allowed to record payments. */
async function requireMayPayFor(
  tx: TransactionSql,
  auth: AuthContext,
  studentId: string,
): Promise<void> {
  if (hasPermission(auth.roles, PERMISSIONS.BILLING_UPDATE)) return;

  const [link] = await tx<{ found: boolean }[]>`
    SELECT true AS found FROM app.parent_child_links
    WHERE school_id = ${auth.schoolId}::uuid
      AND parent_user_id = ${auth.userId}::uuid
      AND student_id = ${studentId}::uuid
    LIMIT 1
  `;
  if (!link) {
    // 404, not 403: whether a student exists is not the caller's business.
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Student not found");
  }
}

/** The payer's customer at the selected provider, created on their first online payment. */
async function ensurePayerCustomer(
  tx: TransactionSql,
  selected: SelectedPaymentProvider,
  auth: AuthContext,
): Promise<string> {
  const [existing] = await tx<{ provider_customer_id: string }[]>`
    SELECT provider_customer_id FROM app.payment_provider_customers
    WHERE school_id = ${auth.schoolId}::uuid
      AND user_id = ${auth.userId}::uuid
      AND provider = ${selected.name}
  `;
  if (existing) return existing.provider_customer_id;

  const [user] = await tx<{ display_name: string; email: string }[]>`
    SELECT display_name, email FROM app.users
    WHERE school_id = ${auth.schoolId}::uuid AND id = ${auth.userId}::uuid
  `;

  const { providerCustomerId } = await selected.port.createCustomer({
    name: user?.display_name ?? "Studafy payer",
    email: user?.email ?? "",
    metadata: { school_id: auth.schoolId, user_id: auth.userId },
  });

  await tx`
    INSERT INTO app.payment_provider_customers (school_id, user_id, provider, provider_customer_id)
    VALUES (${auth.schoolId}::uuid, ${auth.userId}::uuid, ${selected.name}, ${providerCustomerId})
  `;
  return providerCustomerId;
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

export type SettlementOutcome = "processed" | "duplicate" | "parked";

type PaymentResult =
  | { kind: "succeeded"; paidMinor: number | null; currency: string }
  | {
      kind: "failed";
      reason: string;
    };

/**
 * What a verified provider event says about a one-time payment, or `null` when it says nothing
 * final yet (a Stripe session awaiting an async method, a Tap charge still initiated).
 *
 * Reads the shared, Stripe-shaped vocabulary the adapters normalize to: Stripe's own Checkout
 * events, and the `charge.*` events the Tap normalizer emits for charges with no subscription
 * `billing_reason`.
 */
export function feePaymentResult(
  provider: BillingProvider,
  event: ParsedWebhookEvent,
): PaymentResult | null {
  const data = event.data;
  const currency = typeof data.currency === "string" ? data.currency.toUpperCase() : "";

  if (provider === "tap") {
    if (event.type === "charge.succeeded") {
      const amount = typeof data.amount === "number" ? fromTapAmount(data.amount, currency) : null;
      return { kind: "succeeded", paidMinor: amount, currency };
    }
    if (event.type === "charge.failed") {
      return { kind: "failed", reason: `Tap charge ${String(data.status ?? "failed")}` };
    }
    return null;
  }

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (data.payment_status !== "paid") return null;
      return {
        kind: "succeeded",
        paidMinor: typeof data.amount_total === "number" ? data.amount_total : null,
        currency,
      };
    case "checkout.session.expired":
      return { kind: "failed", reason: "Stripe Checkout session expired" };
    case "checkout.session.async_payment_failed":
      return { kind: "failed", reason: "Stripe asynchronous payment failed" };
    default:
      return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function settleOnlineFeePayment(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
  logger: Logger,
  provider: BillingProvider,
  event: ParsedWebhookEvent,
): Promise<SettlementOutcome> {
  const metadata = event.data.metadata as Record<string, unknown>;
  const schoolId = String(metadata.school_id ?? "");
  const paymentId = String(metadata.online_payment_id ?? "");
  const log = { provider, event_id: event.id, online_payment_id: paymentId };

  if (!UUID.test(schoolId) || !UUID.test(paymentId)) {
    logger.warn(log, "fee payment event names no valid school or payment; parked");
    return "parked";
  }

  const result = feePaymentResult(provider, event);
  if (result === null) return "processed";

  const context = { schoolId, requestId: undefined };

  // Phase 1: load, check, and settle a failure outright.
  const row = await withTenantTx(database, context, async (tx) => {
    const [found] = await tx<PaymentRow[]>`
      SELECT ${tx.unsafe(PAYMENT_COLUMNS)}
      FROM app.online_fee_payments p JOIN app.currencies c ON c.id = p.currency_id
      WHERE p.school_id = ${schoolId}::uuid AND p.id = ${paymentId}::uuid
      FOR UPDATE OF p
    `;
    if (!found) return { verdict: "parked" as const, reason: "no such payment" };
    if (found.status !== "pending") return { verdict: "duplicate" as const };
    if (found.provider !== provider || found.provider_session_id !== event.data.id) {
      return { verdict: "parked" as const, reason: "event does not belong to this payment" };
    }

    if (result.kind === "failed") {
      await tx`
        UPDATE app.online_fee_payments
        SET status = 'failed', settled_at = CURRENT_TIMESTAMP, failure_reason = ${result.reason},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${paymentId}::uuid
      `;
      return { verdict: "settled" as const };
    }

    // The provider must have taken exactly what the invoice owed when the payment started.
    if (result.paidMinor !== Number(found.amount_minor) || result.currency !== found.currency) {
      return {
        verdict: "parked" as const,
        reason: `paid ${result.paidMinor} ${result.currency}, expected ${found.amount_minor} ${found.currency}`,
      };
    }
    return { verdict: "forward" as const, found };
  });

  if (row.verdict === "duplicate") return "duplicate";
  if (row.verdict === "settled") return "processed";
  if (row.verdict === "parked") {
    // Money may have moved: this is a page, not a debug line.
    logger.error({ ...log, reason: row.reason }, "fee payment event could not be settled; parked");
    return "parked";
  }

  const payment = row.found;

  // Phase 2: record in ERPNext. Idempotent on the payment id: a redelivery after ERPNext accepted
  // the entry replays it instead of posting a second one.
  const { row: entry } = await createPayment(
    database,
    erpnextFactory,
    { schoolId, userId: payment.payer_user_id },
    {
      student_id: payment.student_id,
      invoice_id: payment.erpnext_invoice_id,
      amount: fromMinorUnits(BigInt(payment.amount_minor), payment.currency_minor_unit),
      payment_mode: "card_external",
      currency: payment.currency,
      reference_no: payment.provider_session_id!,
      reference_date: new Date().toISOString().slice(0, 10),
      remarks: `Online payment via ${provider} (${payment.id})`,
    },
    `online-fee-${payment.id}`,
  );

  // Phase 3: mark it paid, conditionally, so a concurrent delivery that got here first wins.
  await withTenantTx(database, context, async (tx) => {
    const updated = await tx`
      UPDATE app.online_fee_payments
      SET status = 'succeeded', settled_at = CURRENT_TIMESTAMP,
          erpnext_payment_docname = ${entry.erpnext_payment_entry_id},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${payment.id}::uuid AND status = 'pending'
    `;
    if (updated.count === 0) return;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "online_fee_payments",
      targetId: payment.id,
      oldValues: { status: "pending" },
      newValues: { status: "succeeded", erpnext_payment_entry_id: entry.erpnext_payment_entry_id },
    });
  });

  return "processed";
}
