/**
 * Ends duplicate storage subscriptions (db/migrations/000219): a school pays for one storage add-on,
 * never two.
 *
 * When a second storage purchase completes while the first is live, the webhook pipeline
 * (packages/billing attribution) keeps the newest -- the school's add-on row moves to it -- and
 * records the subscription it replaced as `pending`. This job, every 10 minutes, for each such row:
 *
 *  1. fixes the refund once: the unused share of the old subscription's current period times its
 *     full price, capped at what its latest paid invoice took (anything the cap holds back is kept
 *     as `unrefunded_minor` for a person to see);
 *  2. cancels the old subscription in Stripe at once (no proration credit: the refund is the money
 *     back);
 *  3. refunds that amount on the old subscription's latest paid invoice;
 *  4. marks the row `resolved`, with an audit row.
 *
 * No transaction is held across a Stripe call. Each step's result is written as soon as it is
 * known, every Stripe write carries an idempotency key derived from the row, and the refund is
 * looked up by the row's id before one is made, so a retry -- after a crash, a timeout or the
 * idempotency window -- never cancels or refunds twice. A row that keeps failing goes to
 * `needs_review` after MAX_ATTEMPTS, and stays on the super admin's health page until a person
 * finishes it in Stripe.
 */

import Stripe from "stripe";

import { emitAuditLog } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";

import type { BillingLogger } from "@studafy/billing";
import type { Sql } from "postgres";

/** Attempts before a row is handed to a person. With the backoff below, about a day of retries. */
export const MAX_ATTEMPTS = 8;
/** Rows claimed per school per run. */
const CLAIM_LIMIT = 10;
const ERROR_LENGTH = 500;

/** Minutes to wait after attempt `n` (1-based) before the next: 10, 20, 40, ... capped at 6 hours. */
export function retryDelayMinutes(attempt: number): number {
  return Math.min(10 * 2 ** Math.max(0, attempt - 1), 360);
}

export interface DuplicateSubscriptionInfo {
  /** Stripe's status; `canceled` and `incomplete_expired` need no cancel. */
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** The full price of one period, in minor units. */
  unitAmountMinor: number | null;
  currency: string;
  /** The latest invoice, when it was paid and took money. */
  paidInvoice: { id: string; amountPaidMinor: number } | null;
}

/** The Stripe calls this job makes. A port so tests run without Stripe. */
export interface StorageDuplicateStripe {
  retrieveSubscription(subscriptionId: string): Promise<DuplicateSubscriptionInfo>;
  cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<void>;
  /**
   * Refund `amountMinor` of the invoice's payment, or return the refund already made for
   * `duplicateId` (found by its metadata), so a retry never refunds twice.
   */
  refundInvoice(input: {
    invoiceId: string;
    amountMinor: number;
    duplicateId: string;
    idempotencyKey: string;
  }): Promise<string>;
}

interface DuplicateRow {
  id: string;
  stripe_subscription_id: string;
  attempts: number;
  canceled_at: Date | null;
  refund_amount_minor: string | null;
  stripe_refund_id: string | null;
}

export interface StorageDuplicateResult {
  schools: number;
  claimed: number;
  resolved: number;
  failed: number;
  needsReview: number;
}

/** The refund for the unused share of the old subscription's period, and what the cap holds back. */
export function unusedRefund(
  info: DuplicateSubscriptionInfo,
  at: Date,
): { amountMinor: number; unrefundedMinor: number } {
  if (!info.paidInvoice || info.paidInvoice.amountPaidMinor <= 0) {
    return { amountMinor: 0, unrefundedMinor: 0 };
  }
  const { periodStart, periodEnd, unitAmountMinor } = info;
  // Without a usable period or price, refund what the latest invoice took: the school paid for a
  // duplicate it never meant to buy.
  if (!periodStart || !periodEnd || unitAmountMinor === null || periodEnd <= periodStart) {
    return { amountMinor: info.paidInvoice.amountPaidMinor, unrefundedMinor: 0 };
  }
  const total = periodEnd.getTime() - periodStart.getTime();
  const left = Math.min(Math.max(periodEnd.getTime() - at.getTime(), 0), total);
  const owed = Math.round((unitAmountMinor * left) / total);
  const amountMinor = Math.min(owed, info.paidInvoice.amountPaidMinor);
  return { amountMinor, unrefundedMinor: owed - amountMinor };
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > ERROR_LENGTH ? `${text.slice(0, ERROR_LENGTH)}…` : text;
}

/** Schools that can have a Stripe subscription at all. app.schools is global, so no tenant scope. */
async function stripeSchoolIds(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM app.schools WHERE stripe_customer_id IS NOT NULL ORDER BY id
  `;
  return rows.map((row) => row.id);
}

/** Take the school's due rows: count the attempt and push the next one out before any Stripe call. */
async function claimDue(sql: Sql, schoolId: string, now: Date): Promise<DuplicateRow[]> {
  return withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const rows = await tx<{ id: string; attempts: number }[]>`
      SELECT id, attempts FROM app.storage_duplicate_subscriptions
      WHERE school_id = ${schoolId}::uuid AND status = 'pending' AND next_attempt_at <= ${now}
      ORDER BY created_at
      LIMIT ${CLAIM_LIMIT}
      FOR UPDATE SKIP LOCKED
    `;
    const claimed: DuplicateRow[] = [];
    for (const row of rows) {
      const attempt = row.attempts + 1;
      const next = new Date(now.getTime() + retryDelayMinutes(attempt) * 60_000);
      const [updated] = await tx<DuplicateRow[]>`
        UPDATE app.storage_duplicate_subscriptions
        SET attempts = ${attempt}, next_attempt_at = ${next},
            updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
        WHERE id = ${row.id}::uuid
        RETURNING id, stripe_subscription_id, attempts, canceled_at,
                  refund_amount_minor::text AS refund_amount_minor, stripe_refund_id
      `;
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

async function update(
  sql: Sql,
  schoolId: string,
  id: string,
  values: Record<string, unknown>,
): Promise<void> {
  await withSystemTenantTx(sql, { schoolId }, async (tx) => {
    await tx`
      UPDATE app.storage_duplicate_subscriptions
      SET ${tx(values)}, updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
      WHERE id = ${id}::uuid
    `;
  });
}

/** Cancel and refund one duplicate. Throws on a Stripe failure; the caller records it. */
async function resolveOne(
  sql: Sql,
  stripe: StorageDuplicateStripe,
  schoolId: string,
  row: DuplicateRow,
  now: Date,
): Promise<{ refundId: string | null; amountMinor: number }> {
  const info = await stripe.retrieveSubscription(row.stripe_subscription_id);

  // 1. The refund is decided once, at the first attempt, so every retry asks for the same amount.
  let amountMinor = row.refund_amount_minor === null ? null : Number(row.refund_amount_minor);
  if (amountMinor === null) {
    const refund = unusedRefund(info, row.canceled_at ?? now);
    amountMinor = refund.amountMinor;
    await update(sql, schoolId, row.id, {
      refund_amount_minor: refund.amountMinor,
      refund_currency: info.currency,
      unrefunded_minor: refund.unrefundedMinor,
    });
  }

  // 2. End it now, unless Stripe already has.
  if (info.status !== "canceled" && info.status !== "incomplete_expired") {
    await stripe.cancelSubscription(
      row.stripe_subscription_id,
      `storage-duplicate-cancel:${row.id}`,
    );
  }
  if (!row.canceled_at) {
    await update(sql, schoolId, row.id, { canceled_at: now });
  }

  // 3. Refund what is owed, once.
  let refundId = row.stripe_refund_id;
  if (!refundId && amountMinor > 0 && info.paidInvoice) {
    refundId = await stripe.refundInvoice({
      invoiceId: info.paidInvoice.id,
      amountMinor,
      duplicateId: row.id,
      idempotencyKey: `storage-duplicate-refund:${row.id}`,
    });
    await update(sql, schoolId, row.id, { stripe_refund_id: refundId });
  }

  return { refundId, amountMinor };
}

export async function runStorageDuplicateResolver(
  sql: Sql,
  stripe: StorageDuplicateStripe,
  now: Date,
  log: BillingLogger,
): Promise<StorageDuplicateResult> {
  const schoolIds = await stripeSchoolIds(sql);
  const result: StorageDuplicateResult = {
    schools: schoolIds.length,
    claimed: 0,
    resolved: 0,
    failed: 0,
    needsReview: 0,
  };

  for (const schoolId of schoolIds) {
    let claimed: DuplicateRow[];
    try {
      claimed = await claimDue(sql, schoolId, now);
    } catch (error) {
      log.warn({ school_id: schoolId, error: errorText(error) }, "storage duplicate claim failed");
      continue;
    }
    result.claimed += claimed.length;

    for (const row of claimed) {
      try {
        const { refundId, amountMinor } = await resolveOne(sql, stripe, schoolId, row, now);
        await withSystemTenantTx(sql, { schoolId }, async (tx) => {
          await tx`
            UPDATE app.storage_duplicate_subscriptions
            SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP, last_error = NULL,
                updated_at = GREATEST(CURRENT_TIMESTAMP, updated_at)
            WHERE id = ${row.id}::uuid
          `;
          await emitAuditLog(tx, {
            action: "update",
            targetTable: "storage_duplicate_subscriptions",
            targetId: row.id,
            oldValues: { status: "pending" },
            newValues: {
              status: "resolved",
              stripe_subscription_id: row.stripe_subscription_id,
              stripe_refund_id: refundId,
              refund_amount_minor: amountMinor,
            },
          });
        });
        result.resolved += 1;
        log.info(
          {
            school_id: schoolId,
            storage_duplicate_id: row.id,
            duplicate_subscription_id: row.stripe_subscription_id,
            refund_amount_minor: amountMinor,
            stripe_refund_id: refundId,
          },
          "duplicate storage subscription canceled and refunded",
        );
      } catch (error) {
        const giveUp = row.attempts >= MAX_ATTEMPTS;
        result.failed += 1;
        if (giveUp) result.needsReview += 1;
        try {
          await update(sql, schoolId, row.id, {
            last_error: errorText(error),
            ...(giveUp ? { status: "needs_review" } : {}),
          });
        } catch (recordError) {
          log.warn(
            { storage_duplicate_id: row.id, error: errorText(recordError) },
            "could not record a storage duplicate failure",
          );
        }
        log.warn(
          {
            school_id: schoolId,
            storage_duplicate_id: row.id,
            duplicate_subscription_id: row.stripe_subscription_id,
            attempt: row.attempts,
            needs_review: giveUp,
            error: errorText(error),
          },
          giveUp
            ? "duplicate storage subscription could not be canceled or refunded; needs review"
            : "duplicate storage subscription not resolved yet; will retry",
        );
      }
    }
  }

  return result;
}

/** The Stripe side, on the same SDK and API version as apps/api's adapter. */
export class StripeStorageDuplicateClient implements StorageDuplicateStripe {
  private readonly stripe: Stripe;

  constructor(secretKeyOrClient: string | Stripe) {
    this.stripe =
      typeof secretKeyOrClient === "string"
        ? new Stripe(secretKeyOrClient, { apiVersion: "2026-07-29.dahlia" })
        : secretKeyOrClient;
  }

  async retrieveSubscription(subscriptionId: string): Promise<DuplicateSubscriptionInfo> {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice"],
    });
    const item = subscription.items.data[0];
    const invoice =
      typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
    return {
      status: subscription.status,
      periodStart: item?.current_period_start ? new Date(item.current_period_start * 1000) : null,
      periodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000) : null,
      unitAmountMinor: item?.price.unit_amount ?? null,
      currency: subscription.currency.toUpperCase(),
      paidInvoice:
        invoice?.id && invoice.status === "paid" && invoice.amount_paid > 0
          ? { id: invoice.id, amountPaidMinor: invoice.amount_paid }
          : null,
    };
  }

  async cancelSubscription(subscriptionId: string, idempotencyKey: string): Promise<void> {
    await this.stripe.subscriptions.cancel(
      subscriptionId,
      { prorate: false, invoice_now: false },
      { idempotencyKey },
    );
  }

  async refundInvoice(input: {
    invoiceId: string;
    amountMinor: number;
    duplicateId: string;
    idempotencyKey: string;
  }): Promise<string> {
    const payments = await this.stripe.invoicePayments.list({
      invoice: input.invoiceId,
      status: "paid",
      limit: 1,
    });
    const payment = payments.data[0]?.payment;
    const paymentIntent =
      typeof payment?.payment_intent === "string"
        ? payment.payment_intent
        : payment?.payment_intent?.id;
    const charge = typeof payment?.charge === "string" ? payment.charge : payment?.charge?.id;
    if (!paymentIntent && !charge) {
      throw new Error(`Invoice ${input.invoiceId} has no paid payment to refund`);
    }
    const on = paymentIntent ? { payment_intent: paymentIntent } : { charge: charge! };

    // A refund made on an earlier attempt, past Stripe's idempotency window, is found by its tag.
    for await (const refund of this.stripe.refunds.list({ ...on, limit: 100 })) {
      if (
        refund.metadata?.storage_duplicate_id === input.duplicateId &&
        refund.status !== "failed" &&
        refund.status !== "canceled"
      ) {
        return refund.id;
      }
    }

    const refund = await this.stripe.refunds.create(
      {
        ...on,
        amount: input.amountMinor,
        reason: "duplicate",
        metadata: { storage_duplicate_id: input.duplicateId },
      },
      { idempotencyKey: input.idempotencyKey },
    );
    if (refund.status === "failed" || refund.status === "canceled") {
      throw new Error(`Stripe refund ${refund.id} ${refund.status}`);
    }
    return refund.id;
  }
}
