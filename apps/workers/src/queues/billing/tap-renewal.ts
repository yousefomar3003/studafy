/**
 * Tap subscription renewals (ST-298).
 *
 * Tap has no subscription object, so nothing at Tap bills a school again. This daily job does what
 * Stripe Billing does for Stripe schools: when a Tap-billed subscription's period ends, charge the
 * card saved at checkout for the next period, retry a decline, give up into the grace period, and
 * end a subscription whose cancellation was scheduled for period end.
 *
 * ## State moves only through the shared pipeline
 *
 * This job never writes a subscription's status or period on the strength of a charge. The charge
 * carries `billing_reason: subscription_cycle` and the period it pays for; Tap posts it to the
 * webhook, and the same normalizer and state machine that handle every other event advance the
 * period (`invoice.paid`) or mark it `past_due` (`invoice.payment_failed`). The only transitions
 * made here are the two no provider event expresses -- `canceled` at period end and
 * `dunning_exhausted` after the last retry -- and they go through `applySystemTransition`, the audited
 * path the dunning sweep uses.
 *
 * ## Never charge twice for one period
 *
 * Each attempt is claimed in `app.tap_renewal_attempts` and committed BEFORE the charge is sent, keyed
 * on (subscription, period start, attempt number). Then the charge, outside any transaction; then the
 * outcome, in a new one. A crash between the claim and the answer leaves a `submitted` row with no
 * charge id: nobody can know whether Tap charged, so that period is blocked -- marked `unknown` and
 * logged for a human -- rather than retried. A blocked renewal is a support ticket; a double charge
 * is a refund and an apology.
 *
 * An attempt Tap answered `INITIATED` is re-read from Tap on the next run until it settles.
 */

import { addBillingInterval, applySystemTransition, isBillingInterval } from "@studafy/billing";
import { TapApiError, tapChargeOutcome } from "@studafy/tap-payments";

import { emitAuditLog } from "../../db/audit";
import { withSystemTenantTx, withSystemTx } from "../../db/tenant-tx";

import { publishEntitlementChange } from "./entitlement-change-publisher";

import type { BillingInterval, BillingLogger, SubscriptionKind } from "@studafy/billing";
import type { CreateSavedCardChargeInput, TapCharge } from "@studafy/tap-payments";
import type { Sql, TransactionSql } from "postgres";

/** Declines retried before the subscription is handed to the grace period. */
export const TAP_RENEWAL_MAX_ATTEMPTS = 3;

/** Days between attempts for one period. */
export const TAP_RENEWAL_RETRY_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Tap calls this job makes. `TapClient` satisfies it; tests pass a fake. */
export interface TapRenewalCharger {
  chargeSavedCard(input: CreateSavedCardChargeInput): Promise<TapCharge>;
  retrieveCharge(chargeId: string): Promise<TapCharge>;
}

export interface TapRenewalResult {
  schools: number;
  /** Charges sent to Tap this run. */
  charged: number;
  /** Charges Tap answered as captured this run (the webhook still applies them). */
  succeeded: number;
  /** Charges Tap answered as declined or failed this run. */
  failed: number;
  /** Subscriptions ended at period end because a cancellation was scheduled. */
  canceled: number;
  /** Subscriptions moved to the grace period after the last attempt failed. */
  exhausted: number;
  /** Renewals that could not be attempted and need a human; each one is logged. */
  blocked: number;
}

interface DueSubscription {
  kind: SubscriptionKind;
  id: string;
  studentId: string | null;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  tapCardId: string;
  tapPaymentAgreementId: string;
}

interface AttemptRow {
  id: string;
  attempt: number;
  status: "submitted" | "succeeded" | "failed" | "unknown";
  tap_charge_id: string | null;
  attempted_at: Date;
}

/** A renewal ready to send: everything the claim, the charge and its metadata need. */
interface RenewalPlan {
  subscription: DueSubscription;
  attempt: number;
  periodStart: Date;
  periodEnd: Date;
  amountMinor: number;
  currency: string;
  metadata: Record<string, string>;
}

export async function runTapRenewals(
  sql: Sql,
  charger: TapRenewalCharger,
  webhookUrl: string,
  now: Date,
  log: BillingLogger,
): Promise<TapRenewalResult> {
  const schools = await withSystemTx(
    sql,
    (tx) =>
      tx<{ id: string; tap_customer_id: string }[]>`
      SELECT id, tap_customer_id FROM app.schools
      WHERE tap_customer_id IS NOT NULL
      ORDER BY id
    `,
  );

  const result: TapRenewalResult = {
    schools: schools.length,
    charged: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    exhausted: 0,
    blocked: 0,
  };

  for (const school of schools) {
    try {
      await renewSchool(sql, charger, webhookUrl, now, log, school, result);
    } catch (error) {
      // One school's failure must not strand the schools after it; the next run retries it.
      log.warn(
        { err: error, school_id: school.id },
        "tap renewal failed for a school; continuing with the rest",
      );
    }
  }

  log.info({ ...result }, "tap renewal run complete");
  return result;
}

async function renewSchool(
  sql: Sql,
  charger: TapRenewalCharger,
  webhookUrl: string,
  now: Date,
  log: BillingLogger,
  school: { id: string; tap_customer_id: string },
  result: TapRenewalResult,
): Promise<void> {
  const options = { emitAudit: emitAuditLog, publishEntitlementChange, logger: log };

  // Phase 1, one transaction: settle what is already known and decide what to charge.
  const plans = await withSystemTenantTx(sql, { schoolId: school.id }, async (tx) => {
    const ready: RenewalPlan[] = [];

    for (const subscription of await loadDueSubscriptions(tx, school.id, now)) {
      const target = {
        kind: subscription.kind,
        schoolId: school.id,
        subscriptionId: subscription.id,
      };

      if (subscription.cancelAtPeriodEnd) {
        const outcome = await applySystemTransition(tx, { ...target, intent: "canceled" }, options);
        if (outcome.outcome === "transitioned") result.canceled += 1;
        continue;
      }

      const plan = await planRenewal(tx, charger, school.id, subscription, now, log);
      if (plan === "wait") continue;
      if (plan === "blocked") {
        result.blocked += 1;
        continue;
      }
      if (plan === "exhausted") {
        const outcome = await applySystemTransition(
          tx,
          { ...target, intent: "dunning_exhausted" },
          options,
        );
        if (outcome.outcome === "transitioned") result.exhausted += 1;
        continue;
      }
      ready.push(plan);
    }

    return ready;
  });

  for (const plan of plans) {
    await sendRenewal(sql, charger, webhookUrl, school, plan, now, log, result);
  }
}

/**
 * Tap-billed subscriptions whose period has ended.
 *
 * Tap-billed means a saved card exists: a Stripe school never gets one, so a school that moved
 * provider is never charged by both. Only `active` and `past_due` renew; `grace_period` has already
 * exhausted its attempts and is the dunning sweep's to close, and every other status has no access
 * to pay for. `SKIP LOCKED` so two concurrent runs split the work instead of queuing on it.
 */
async function loadDueSubscriptions(
  tx: TransactionSql,
  schoolId: string,
  now: Date,
): Promise<DueSubscription[]> {
  const school = await tx<
    {
      id: string;
      current_period_end: Date;
      cancel_at_period_end: boolean;
      tap_card_id: string;
      tap_payment_agreement_id: string;
    }[]
  >`
    SELECT id, current_period_end, cancel_at_period_end, tap_card_id, tap_payment_agreement_id
    FROM app.subscriptions
    WHERE school_id = ${schoolId}::uuid
      AND status IN ('active', 'past_due')
      AND tap_card_id IS NOT NULL
      AND current_period_end <= ${now}
    FOR UPDATE SKIP LOCKED
  `;

  const ai = await tx<
    {
      id: string;
      student_id: string;
      current_period_end: Date;
      tap_card_id: string;
      tap_payment_agreement_id: string;
    }[]
  >`
    SELECT id, student_id, current_period_end, tap_card_id, tap_payment_agreement_id
    FROM app.ai_subscriptions
    WHERE school_id = ${schoolId}::uuid
      AND status IN ('active', 'past_due')
      AND tap_card_id IS NOT NULL
      AND current_period_end <= ${now}
    FOR UPDATE SKIP LOCKED
  `;

  return [
    ...school.map((row) => ({
      kind: "school" as const,
      id: row.id,
      studentId: null,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end,
      tapCardId: row.tap_card_id,
      tapPaymentAgreementId: row.tap_payment_agreement_id,
    })),
    ...ai.map((row) => ({
      kind: "ai" as const,
      id: row.id,
      studentId: row.student_id,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: false,
      tapCardId: row.tap_card_id,
      tapPaymentAgreementId: row.tap_payment_agreement_id,
    })),
  ];
}

/**
 * Decide this subscription's renewal for the period that starts at its current period end.
 *
 *   - `wait`: an attempt is in flight, succeeded (the webhook will advance the period), or the retry
 *     interval has not passed.
 *   - `blocked`: something only a human can resolve; logged.
 *   - `exhausted`: every attempt for this period has failed.
 *   - a plan: send attempt N.
 */
async function planRenewal(
  tx: TransactionSql,
  charger: TapRenewalCharger,
  schoolId: string,
  subscription: DueSubscription,
  now: Date,
  log: BillingLogger,
): Promise<RenewalPlan | "wait" | "blocked" | "exhausted"> {
  const periodStart = subscription.currentPeriodEnd;
  const context = {
    school_id: schoolId,
    kind: subscription.kind,
    subscription_id: subscription.id,
  };

  const attempts = await tx<AttemptRow[]>`
    SELECT id, attempt, status::text AS status, tap_charge_id, attempted_at
    FROM app.tap_renewal_attempts
    WHERE subscription_type = ${subscription.kind}::app.billing_subscription_type
      AND subscription_id = ${subscription.id}::uuid
      AND period_start = ${periodStart}
    ORDER BY attempt
  `;

  for (const attempt of attempts) {
    if (attempt.status === "submitted") {
      await resolveSubmittedAttempt(tx, charger, attempt, log);
    }
  }

  if (attempts.some((a) => a.status === "succeeded")) return "wait";
  if (attempts.some((a) => a.status === "submitted")) return "wait";
  if (attempts.some((a) => a.status === "unknown")) {
    log.warn(context, "tap renewal blocked: an earlier attempt's outcome is unknown");
    return "blocked";
  }

  const last = attempts.at(-1);
  if (last && attempts.length >= TAP_RENEWAL_MAX_ATTEMPTS) return "exhausted";
  if (last && now.getTime() - last.attempted_at.getTime() < TAP_RENEWAL_RETRY_DAYS * DAY_MS) {
    return "wait";
  }

  const pricing = await loadPricing(tx, schoolId, subscription);
  if (typeof pricing === "string") {
    log.warn({ ...context, reason: pricing }, "tap renewal blocked: cannot price the renewal");
    return "blocked";
  }

  const periodEnd = addBillingInterval(periodStart, pricing.interval);
  const seconds = (date: Date) => String(Math.floor(date.getTime() / 1000));

  return {
    subscription,
    attempt: (last?.attempt ?? 0) + 1,
    periodStart,
    periodEnd,
    amountMinor: pricing.amountMinor,
    currency: pricing.currency,
    // Everything the webhook needs to apply the renewal, and the next renewal needs to repeat it.
    metadata: {
      school_id: schoolId,
      ...(subscription.studentId ? { student_id: subscription.studentId } : {}),
      billing_reason: "subscription_cycle",
      price_id: pricing.priceId,
      billing_interval: pricing.interval,
      ...(pricing.seatBilling ? { seat_billing: "enrolled_students" } : {}),
      period_start: seconds(periodStart),
      period_end: seconds(periodEnd),
    },
  };
}

/** Re-read a charge Tap had not settled when it answered, and record where it landed. */
async function resolveSubmittedAttempt(
  tx: TransactionSql,
  charger: TapRenewalCharger,
  attempt: AttemptRow,
  log: BillingLogger,
): Promise<void> {
  if (!attempt.tap_charge_id) {
    // Claimed, never answered: the process died mid-call. Tap may or may not have charged.
    attempt.status = "unknown";
    await recordAttempt(tx, attempt.id, "unknown", null, "no response recorded for this charge");
    return;
  }

  try {
    const charge = await charger.retrieveCharge(attempt.tap_charge_id);
    const outcome = tapChargeOutcome(charge.status);
    if (outcome === "paid" || outcome === "failed") {
      attempt.status = outcome === "paid" ? "succeeded" : "failed";
      await recordAttempt(
        tx,
        attempt.id,
        attempt.status,
        attempt.tap_charge_id,
        charge.status ?? null,
      );
    }
  } catch (error) {
    log.warn({ err: error, attempt_id: attempt.id }, "could not re-read a pending tap renewal");
  }
}

interface Pricing {
  priceId: string;
  amountMinor: number;
  currency: string;
  interval: BillingInterval;
  seatBilling: boolean;
}

/**
 * Price the renewal exactly as the subscription was last paid for.
 *
 * The price id and seat rule come off the subscription's last paid Tap charge, recorded in
 * `app.billing_events` (checkout stamps them; each renewal carries them forward). The amount and
 * interval come from that `app.plan_prices` row, so a price change reaches the next renewal. A
 * seat-billed school pays for its enrolled students today, as the checkout did.
 */
async function loadPricing(
  tx: TransactionSql,
  schoolId: string,
  subscription: DueSubscription,
): Promise<Pricing | string> {
  const [paid] = await tx<{ price_id: string | null; seat_billing: string | null }[]>`
    SELECT payload->'metadata'->>'price_id' AS price_id,
           payload->'metadata'->>'seat_billing' AS seat_billing
    FROM app.billing_events
    WHERE provider = 'tap'
      AND status = 'processed'
      AND event_type IN ('checkout.session.completed', 'invoice.paid')
      AND subscription_type = ${subscription.kind}::app.billing_subscription_type
      AND subscription_id = ${subscription.id}::uuid
    ORDER BY effective_at DESC
    LIMIT 1
  `;

  if (!paid?.price_id)
    return "no paid Tap charge records the price this subscription was bought at";

  const [price] = await tx<{ amount_minor: string; currency: string; billing_interval: string }[]>`
    SELECT pp.amount_minor::text AS amount_minor, cur.code AS currency,
           pp.billing_interval::text AS billing_interval
    FROM app.plan_prices pp
    JOIN app.currencies cur ON cur.id = pp.currency_id
    WHERE pp.id = ${paid.price_id}::uuid
  `;

  if (!price) return `plan price ${paid.price_id} no longer exists`;
  if (!isBillingInterval(price.billing_interval)) {
    return `plan price ${paid.price_id} has interval ${price.billing_interval}`;
  }

  const seatBilling = subscription.kind === "school" && paid.seat_billing === "enrolled_students";
  let quantity = 1;
  if (seatBilling) {
    const [{ count }] = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM app.students
      WHERE school_id = ${schoolId}::uuid AND status = 'enrolled'
    `;
    quantity = Number(count);
    if (quantity === 0) return "school has no enrolled students to bill for";
  }

  return {
    priceId: paid.price_id,
    amountMinor: Number(price.amount_minor) * quantity,
    currency: price.currency,
    interval: price.billing_interval,
    seatBilling,
  };
}

/** Claim (committed), charge (no transaction), record (committed). See the header. */
async function sendRenewal(
  sql: Sql,
  charger: TapRenewalCharger,
  webhookUrl: string,
  school: { id: string; tap_customer_id: string },
  plan: RenewalPlan,
  now: Date,
  log: BillingLogger,
  result: TapRenewalResult,
): Promise<void> {
  const { subscription } = plan;

  const attemptId = await withSystemTenantTx(sql, { schoolId: school.id }, async (tx) => {
    const [claimed] = await tx<{ id: string }[]>`
      INSERT INTO app.tap_renewal_attempts (
        school_id, subscription_type, subscription_id, period_start, period_end, attempt,
        attempted_at, amount_minor, currency_code
      ) VALUES (
        ${school.id}::uuid, ${subscription.kind}::app.billing_subscription_type,
        ${subscription.id}::uuid, ${plan.periodStart}, ${plan.periodEnd}, ${plan.attempt},
        ${now}, ${plan.amountMinor}, ${plan.currency}
      )
      ON CONFLICT (subscription_type, subscription_id, period_start, attempt) DO NOTHING
      RETURNING id
    `;
    return claimed?.id ?? null;
  });

  // A concurrent run claimed this attempt first; it owns the charge.
  if (attemptId === null) return;

  let status: AttemptRow["status"];
  let chargeId: string | null = null;
  let reason: string | null = null;

  try {
    const charge = await charger.chargeSavedCard({
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      customerId: school.tap_customer_id,
      cardId: subscription.tapCardId,
      paymentAgreementId: subscription.tapPaymentAgreementId,
      description: "Studafy subscription renewal",
      metadata: { ...plan.metadata, renewal_attempt_id: attemptId },
      webhookUrl,
      orderReference: attemptId,
    });

    chargeId = charge.id ?? null;
    const outcome = tapChargeOutcome(charge.status);
    status =
      outcome === "paid"
        ? "succeeded"
        : outcome === "failed"
          ? "failed"
          : chargeId
            ? "submitted"
            : "unknown";
    reason = outcome === "paid" ? null : (charge.status ?? "no status");
  } catch (error) {
    // Tap refused the request (4xx): no charge exists, so the attempt failed and may be retried.
    // Anything else -- unreachable, timeout, 5xx -- may have charged, so the period is blocked.
    const refused = error instanceof TapApiError && error.status >= 400 && error.status < 500;
    status = refused ? "failed" : "unknown";
    reason = error instanceof Error ? error.message : String(error);
  }

  result.charged += 1;
  if (status === "succeeded") result.succeeded += 1;
  if (status === "failed") result.failed += 1;
  if (status === "unknown") {
    result.blocked += 1;
    log.warn(
      { school_id: school.id, subscription_id: subscription.id, attempt_id: attemptId, reason },
      "tap renewal outcome unknown; period blocked until reconciled by hand",
    );
  }

  await withSystemTenantTx(sql, { schoolId: school.id }, (tx) =>
    recordAttempt(tx, attemptId, status, chargeId, reason),
  );
}

async function recordAttempt(
  tx: TransactionSql,
  attemptId: string,
  status: AttemptRow["status"],
  chargeId: string | null,
  reason: string | null,
): Promise<void> {
  await tx`
    UPDATE app.tap_renewal_attempts
    SET status = ${status}::app.tap_renewal_status,
        tap_charge_id = COALESCE(${chargeId}::text, tap_charge_id),
        failure_reason = ${reason === null ? null : reason.slice(0, 2000)},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${attemptId}::uuid
  `;
}
