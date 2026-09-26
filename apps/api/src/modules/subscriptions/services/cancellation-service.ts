import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import { requirePaymentProvider } from "../payment-provider-routing";

import { requireSchoolSubscription } from "./subscription-service";

import type { SchoolSubscription } from "./subscription-service";
import type { Database } from "../../../db";
import type { TenantContext } from "../../../db/tenant-tx";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { TransactionSql } from "postgres";

export interface ScheduleCancellationParams {
  schoolId: string;
  reason?: string;
  retentionOfferShown?: boolean;
  tenantContext: TenantContext;
}

export interface ReverseCancellationParams {
  schoolId: string;
  tenantContext: TenantContext;
}

/**
 * Schedule a school's subscription to cancel at the end of its current billing period.
 *
 * The subscription stays `active` (or whatever live status it holds) and keeps its access until
 * the period ends; `cancel_at_period_end` records the intent so the portal can show it. What eventually moves `status` to `canceled` depends on who bills the
 * subscription: for Stripe, its `customer.subscription.deleted` webhook through the state machine;
 * for Tap, the renewal worker, which reads this flag at period end and applies the `canceled`
 * system transition instead of charging. This function never writes `status` itself.
 */
export async function scheduleCancellation(
  database: Database,
  providers: PaymentProviderRegistry,
  params: ScheduleCancellationParams,
): Promise<SchoolSubscription> {
  const { schoolId, reason, retentionOfferShown, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const before = await requireSchoolSubscription(tx, schoolId);

    if (before.cancelAtPeriodEnd) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SUBSCRIPTION_ALREADY_CANCELED,
        "A cancellation is already scheduled for this subscription",
      );
    }

    const billing = await billingFor(tx, before.id, before.stripeSubscriptionId, "cancel");
    if (billing.kind === "stripe") {
      await requirePaymentProvider(providers, "stripe").port.scheduleCancellation({
        providerSubscriptionId: billing.providerSubscriptionId,
      });
    }

    const retentionState = retentionOfferShown ? "offer_shown" : "none";

    const [after] = await tx<SchoolSubscription[]>`
      UPDATE app.subscriptions SET
        cancel_at_period_end = true,
        cancellation_requested_at = CURRENT_TIMESTAMP,
        cancellation_reason = ${reason ?? null},
        retention_state = ${retentionState}::app.subscription_retention_state,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${before.id}::uuid
      RETURNING
        id, school_id AS "schoolId", plan_id AS "planId", status::text AS status,
        student_cap AS "studentCap",
        current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd",
        stripe_subscription_id AS "stripeSubscriptionId",
        stripe_subscription_item_id AS "stripeSubscriptionItemId",
        cancel_at_period_end AS "cancelAtPeriodEnd",
        cancellation_requested_at AS "cancellationRequestedAt",
        cancellation_reason AS "cancellationReason",
        retention_state::text AS "retentionState"
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "subscriptions",
      targetId: before.id,
      oldValues: {
        cancel_at_period_end: before.cancelAtPeriodEnd,
        retention_state: before.retentionState,
      },
      newValues: {
        cancel_at_period_end: true,
        cancellation_reason: reason ?? null,
        retention_state: retentionState,
      },
    });

    return after!;
  });
}

/** Undo a pending end-of-period cancellation. Marks the retention state as won-back. */
export async function reverseCancellation(
  database: Database,
  providers: PaymentProviderRegistry,
  params: ReverseCancellationParams,
): Promise<SchoolSubscription> {
  const { schoolId, tenantContext } = params;

  return withTenantTx(database, tenantContext, async (tx) => {
    const before = await requireSchoolSubscription(tx, schoolId);

    if (!before.cancelAtPeriodEnd) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.SUBSCRIPTION_CANCELLATION_NOT_PENDING,
        "No pending cancellation to reverse",
      );
    }

    const billing = await billingFor(tx, before.id, before.stripeSubscriptionId, "update");
    if (billing.kind === "stripe") {
      await requirePaymentProvider(providers, "stripe").port.reverseCancellation({
        providerSubscriptionId: billing.providerSubscriptionId,
      });
    }

    const [after] = await tx<SchoolSubscription[]>`
      UPDATE app.subscriptions SET
        cancel_at_period_end = false,
        cancellation_requested_at = NULL,
        cancellation_reason = NULL,
        retention_state = 'retained'::app.subscription_retention_state,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ${before.id}::uuid
      RETURNING
        id, school_id AS "schoolId", plan_id AS "planId", status::text AS status,
        student_cap AS "studentCap",
        current_period_start AS "currentPeriodStart", current_period_end AS "currentPeriodEnd",
        stripe_subscription_id AS "stripeSubscriptionId",
        stripe_subscription_item_id AS "stripeSubscriptionItemId",
        cancel_at_period_end AS "cancelAtPeriodEnd",
        cancellation_requested_at AS "cancellationRequestedAt",
        cancellation_reason AS "cancellationReason",
        retention_state::text AS "retentionState"
    `;

    await emitAuditLog(tx, {
      action: "update",
      targetTable: "subscriptions",
      targetId: before.id,
      oldValues: {
        cancel_at_period_end: before.cancelAtPeriodEnd,
        retention_state: before.retentionState,
      },
      newValues: {
        cancel_at_period_end: false,
        retention_state: "retained",
      },
    });

    return after!;
  });
}

/**
 * Who bills this subscription, as far as cancellation is concerned.
 *
 * A Stripe subscription id means Stripe renews it and must be told. A saved Tap card means Studafy's
 * renewal worker renews it and reads `cancel_at_period_end` itself, so the local flag is the whole
 * change. Neither means nothing has been paid through a provider yet, and there is nothing to cancel.
 */
async function billingFor(
  tx: TransactionSql,
  subscriptionId: string,
  stripeSubscriptionId: string | null,
  verb: "cancel" | "update",
): Promise<{ kind: "stripe"; providerSubscriptionId: string } | { kind: "tap" }> {
  if (stripeSubscriptionId) return { kind: "stripe", providerSubscriptionId: stripeSubscriptionId };

  const [row] = await tx<{ tap_billed: boolean }[]>`
    SELECT tap_card_id IS NOT NULL AS tap_billed
    FROM app.subscriptions
    WHERE id = ${subscriptionId}::uuid
  `;
  if (row?.tap_billed) return { kind: "tap" };

  throw new CodedHttpException(
    400,
    ERROR_CODES.SUBSCRIPTION_NOT_LINKED_TO_PROVIDER,
    `Subscription has no payment-provider record to ${verb}`,
  );
}
