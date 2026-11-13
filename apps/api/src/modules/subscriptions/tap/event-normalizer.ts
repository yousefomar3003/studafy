/**
 * Tap charge -> the shared billing event vocabulary.
 *
 * `@studafy/billing` reads one dialect, Stripe's event names and object fields, so that the state
 * machine, the fold and the worker retry exist once. Tap has no subscription objects and no event
 * envelope: it posts the charge itself whenever the charge's status changes. This module turns each
 * such post into the Stripe event that means the same thing to Studafy.
 *
 * ## Which charges are subscription charges
 *
 * Only charges whose metadata carries a subscription `billing_reason` (Stripe's own field name and
 * values) are allowed to move a subscription. `TapAdapter.createCheckoutSession` stamps
 * `subscription_create`; a renewal charge would stamp `subscription_cycle`. Any other charge, such
 * as a fee payment, normalizes to `charge.succeeded` / `charge.failed`, which the state machine
 * records and ignores. Without that gate a paid tuition fee would be read as a paid subscription.
 *
 *   CAPTURED                -> checkout.session.completed | invoice.paid           | charge.succeeded
 *   DECLINED, FAILED, ...   -> checkout.session.expired   | invoice.payment_failed | charge.failed
 *   INITIATED, IN_PROGRESS  -> payment_intent.processing, whatever the billing_reason
 *   any other status        -> tap.charge.<status>: unmapped, so the pipeline parks it for a human
 *
 * (columns: subscription_create | subscription_cycle | no subscription billing_reason)
 *
 * A declined first checkout maps to `checkout.session.expired`, not `invoice.payment_failed`: the
 * school never had a paid subscription, and Stripe likewise reports nothing for a card declined on
 * its hosted page.
 *
 * ## Event identity
 *
 * Tap sends no event id. The charge id alone would be the wrong key -- the port requires the event's
 * identity, not its object's, and one charge legitimately posts INITIATED and then CAPTURED -- so
 * the id is `{charge id}:{status}`. A redelivery of the same status dedupes; a new status does not.
 *
 * ## What Stripe would have told us, and Tap does not
 *
 * A paid subscription charge also carries, in `data`:
 *
 *   - `period_start` / `period_end` (Unix seconds, the fields `extractPeriod` reads). A first charge
 *     starts its period when it was created and runs one `billing_interval` (checkout metadata); a
 *     renewal carries the period the renewal worker charged for in its own metadata.
 *   - `payment_method`: the saved card and payment agreement, which `@studafy/billing` stores on the
 *     subscription so the renewal worker can charge it next period.
 */

import { addBillingInterval, isBillingInterval } from "@studafy/billing";
import { tapChargeOutcome } from "@studafy/tap-payments";

import type { ParsedWebhookEvent } from "../ports/payment-provider";
import type { TapCharge } from "@studafy/tap-payments";

type ChargeOutcome = "paid" | "failed";

const EVENT_TYPES: Readonly<Record<string, Readonly<Record<ChargeOutcome, string>>>> = {
  subscription_create: { paid: "checkout.session.completed", failed: "checkout.session.expired" },
  subscription_cycle: { paid: "invoice.paid", failed: "invoice.payment_failed" },
};

const NON_SUBSCRIPTION_EVENT_TYPES: Readonly<Record<ChargeOutcome, string>> = {
  paid: "charge.succeeded",
  failed: "charge.failed",
};

/** Thrown for a charge that verified but cannot be normalized. The adapter maps it to a 400. */
export class TapChargeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TapChargeShapeError";
  }
}

export function normalizeTapCharge(charge: TapCharge): ParsedWebhookEvent {
  const id = charge.id;
  const status = charge.status?.toUpperCase();
  if (!id || !status) {
    throw new TapChargeShapeError("Tap charge carries no id or status");
  }

  const metadata = charge.metadata ?? {};
  const createdAt = parseCreated(charge.transaction?.created);
  const paidSubscriptionCharge =
    tapChargeOutcome(status) === "paid" && subscriptionEventTypes(metadata.billing_reason) !== null;

  return {
    id: `${id}:${status}`,
    type: eventTypeFor(status, metadata.billing_reason),
    effectiveAt: createdAt,
    livemode: charge.live_mode === true,
    // The fields @studafy/billing's readers look for, under the names they look for them by:
    // `customer` as a bare id string, `metadata` carrying school_id / student_id. No card data --
    // Tap's charge object holds only a masked card, and none of it is copied here.
    data: {
      id,
      object: "charge",
      customer: charge.customer?.id ?? null,
      metadata,
      amount: charge.amount ?? null,
      currency: charge.currency ?? null,
      status,
      ...(paidSubscriptionCharge ? periodFor(metadata, createdAt) : {}),
      ...(paidSubscriptionCharge ? paymentMethodFor(charge) : {}),
    },
  };
}

/** The period a paid subscription charge pays for, in the Unix seconds `extractPeriod` reads. */
function periodFor(
  metadata: Record<string, unknown>,
  createdAt: Date,
): { period_start: number; period_end: number } | Record<string, never> {
  if (metadata.billing_reason === "subscription_cycle") {
    const start = Number(metadata.period_start);
    const end = Number(metadata.period_end);
    return Number.isFinite(start) && Number.isFinite(end) && end > start
      ? { period_start: start, period_end: end }
      : {};
  }

  if (!isBillingInterval(metadata.billing_interval)) return {};
  const end = addBillingInterval(createdAt, metadata.billing_interval);
  return {
    period_start: Math.floor(createdAt.getTime() / 1000),
    period_end: Math.floor(end.getTime() / 1000),
  };
}

/** Card and agreement ids only -- identifiers Tap issues, not card data. */
function paymentMethodFor(
  charge: TapCharge,
):
  | { payment_method: { tap_card_id: string; tap_payment_agreement_id: string } }
  | Record<string, never> {
  const cardId = charge.card?.id;
  const agreementId = charge.payment_agreement?.id;
  return cardId && agreementId
    ? { payment_method: { tap_card_id: cardId, tap_payment_agreement_id: agreementId } }
    : {};
}

function eventTypeFor(status: string, billingReason: unknown): string {
  const outcome = tapChargeOutcome(status);
  if (outcome === "pending") return "payment_intent.processing";
  if (outcome === "unknown") return `tap.charge.${status.toLowerCase()}`;

  return (subscriptionEventTypes(billingReason) ?? NON_SUBSCRIPTION_EVENT_TYPES)[outcome];
}

/** Own keys only: metadata is payer-visible input, and `"constructor" in {}` is true. */
function subscriptionEventTypes(
  billingReason: unknown,
): Readonly<Record<ChargeOutcome, string>> | null {
  return typeof billingReason === "string" && Object.hasOwn(EVENT_TYPES, billingReason)
    ? EVENT_TYPES[billingReason]!
    : null;
}

/**
 * `transaction.created` is epoch *milliseconds*, sent as a string. Stripe's `created` is seconds,
 * and the Stripe adapter multiplies by 1000; doing that here would date every Tap event tens of
 * thousands of years ahead and sort it after everything else.
 */
function parseCreated(created: string | number | undefined): Date {
  const millis = typeof created === "string" ? Number(created) : created;
  if (typeof millis !== "number" || !Number.isFinite(millis) || millis <= 0) {
    throw new TapChargeShapeError("Tap charge carries no valid transaction.created");
  }
  return new Date(millis);
}
