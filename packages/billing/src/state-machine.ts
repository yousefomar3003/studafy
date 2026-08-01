/**
 * The billing state machine (ST-132): the only place that decides what a provider event may do to a
 * subscription's status.
 *
 * ## Why intents, and not raw provider event types
 *
 * The transition table is keyed on `(from_state, intent)`, where an *intent* is the normalized
 * meaning of an event rather than its provider name. That indirection is not decoration. Stripe
 * sends `customer.subscription.updated` for a renewal, a failed payment, a pause and a cancellation
 * alike -- the discriminator is the `status` field inside the payload, not the event name. A table
 * keyed on the raw event type would therefore have to map that one name to one target, which is
 * exactly the "infer state ad hoc from whatever event arrived" failure this ticket exists to remove.
 *
 * `deriveIntent` is the single place the provider's vocabulary is read. The raw event type is still
 * what lands in `app.billing_events.event_type`, because that is what a support question is asked in.
 *
 * ## Vocabulary
 *
 * The states are `app.subscription_status` (000016 + 000042) and nothing else. The ST-132 ticket
 * says "grace" and "suspended"; this schema has said `grace_period` and `closed` since ST-092, and
 * ST-134/ST-136 will consume those names. The mapping is:
 *
 *   ticket "grace"     -> `grace_period`
 *   ticket "suspended" -> `closed`
 *
 * (`'suspended'` is a real value of `app.school_status` and `app.user_status`, which is where the
 * word comes from -- it has never been a subscription status. See
 * docs/database/stripe-webhook-state-machine.md.)
 *
 * The ticket also asks for a `suspended -> canceled` edge. It is deliberately absent: `closed` is
 * defined as terminal by SAD §11 and by the header of packages/constants/src/subscription-status.ts,
 * and adding an edge out of it here would make two documents disagree about the same enum. A
 * subscription that is closed stays closed.
 *
 * ## Terminal states are absorbing
 *
 * `canceled`, `expired` and `closed` have no outgoing edges. A stray `customer.subscription.updated`
 * claiming a canceled subscription is active resolves to `null` and is parked, never applied.
 */

import { SUBSCRIPTION_STATUSES } from "@studafy/constants";

import type { SubscriptionStatus } from "@studafy/constants";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Which of the two subscription tables a transition applies to. Mirrors `app.billing_subscription_type`. */
export type SubscriptionKind = "school" | "ai";

/**
 * The normalized meaning of a provider event, as far as subscription status is concerned.
 *
 * Deliberately smaller than the provider's event vocabulary: several Stripe events mean the same
 * thing to us (`invoice.paid` and a `customer.subscription.updated` carrying `status: "active"` are
 * both "this subscription is paid up"), and collapsing them here is what keeps the transition table
 * a statement about *our* lifecycle rather than a mirror of Stripe's API surface.
 */
export type BillingEventIntent =
  | "trial_started"
  | "activated"
  | "payment_failed"
  | "dunning_exhausted"
  | "grace_exhausted"
  | "canceled"
  | "expired";

/** States with no outgoing edges. */
export const TERMINAL_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  SUBSCRIPTION_STATUSES.CANCELED,
  SUBSCRIPTION_STATUSES.EXPIRED,
  SUBSCRIPTION_STATUSES.CLOSED,
]);

/**
 * States in which the tenant still has access.
 *
 * The AI cascade keys on leaving this set, not on reaching any one status -- see
 * `resolveAiCascade`.
 */
export const LIVE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  SUBSCRIPTION_STATUSES.TRIALING,
  SUBSCRIPTION_STATUSES.ACTIVE,
  SUBSCRIPTION_STATUSES.PAST_DUE,
  SUBSCRIPTION_STATUSES.GRACE_PERIOD,
]);

/**
 * The state a subscription is folded from when it has no history yet.
 *
 * `trialing` is both the column default in 000016 and the state every Studafy subscription genuinely
 * starts in, so a fold over zero events and a freshly inserted row agree.
 */
export const GENESIS_STATUS: SubscriptionStatus = SUBSCRIPTION_STATUSES.TRIALING;

// ---------------------------------------------------------------------------
// Transition tables
// ---------------------------------------------------------------------------

type TransitionKey = `${SubscriptionStatus}:${BillingEventIntent}`;
type TransitionTable = Readonly<Partial<Record<TransitionKey, SubscriptionStatus>>>;

/**
 * School subscription transitions (`app.subscriptions.status`).
 *
 * Object keys are unique by construction, which is the same guarantee the ticket asks a lookup table
 * to get from `UNIQUE (from_state, event_type)`: the table cannot encode two targets for one
 * `(from_state, intent)` pair, because the second literal would replace the first and TypeScript
 * flags the duplicate.
 *
 * Self-edges (`active + activated -> active`) are present on purpose. A renewal, a repeated failed
 * charge and a re-delivered event are all ordinary, and modelling them as legal no-op transitions is
 * what stops the fold from parking events that are merely unsurprising.
 */
export const SCHOOL_TRANSITIONS: TransitionTable = {
  // trialing -- the genesis state.
  "trialing:trial_started": SUBSCRIPTION_STATUSES.TRIALING,
  "trialing:activated": SUBSCRIPTION_STATUSES.ACTIVE,
  "trialing:payment_failed": SUBSCRIPTION_STATUSES.PAST_DUE,
  "trialing:dunning_exhausted": SUBSCRIPTION_STATUSES.GRACE_PERIOD,
  "trialing:canceled": SUBSCRIPTION_STATUSES.CANCELED,
  "trialing:expired": SUBSCRIPTION_STATUSES.EXPIRED,

  // active.
  "active:activated": SUBSCRIPTION_STATUSES.ACTIVE,
  "active:payment_failed": SUBSCRIPTION_STATUSES.PAST_DUE,
  "active:dunning_exhausted": SUBSCRIPTION_STATUSES.GRACE_PERIOD,
  "active:canceled": SUBSCRIPTION_STATUSES.CANCELED,
  "active:expired": SUBSCRIPTION_STATUSES.EXPIRED,

  // past_due -- recoverable. `past_due:activated` is the payment-recovered edge.
  "past_due:activated": SUBSCRIPTION_STATUSES.ACTIVE,
  "past_due:payment_failed": SUBSCRIPTION_STATUSES.PAST_DUE,
  "past_due:dunning_exhausted": SUBSCRIPTION_STATUSES.GRACE_PERIOD,
  "past_due:canceled": SUBSCRIPTION_STATUSES.CANCELED,
  "past_due:expired": SUBSCRIPTION_STATUSES.EXPIRED,

  // grace_period -- the last window before the tenant is locked.
  "grace_period:activated": SUBSCRIPTION_STATUSES.ACTIVE,
  "grace_period:payment_failed": SUBSCRIPTION_STATUSES.GRACE_PERIOD,
  "grace_period:dunning_exhausted": SUBSCRIPTION_STATUSES.GRACE_PERIOD,
  "grace_period:grace_exhausted": SUBSCRIPTION_STATUSES.CLOSED,
  "grace_period:canceled": SUBSCRIPTION_STATUSES.CANCELED,
  "grace_period:expired": SUBSCRIPTION_STATUSES.EXPIRED,

  // canceled / expired / closed: absorbing. No entries, by design.
};

/**
 * AI subscription transitions (`app.ai_subscriptions.status`).
 *
 * Identical to the school table, and that is a finding rather than an oversight: both columns are
 * the same `app.subscription_status` enum and both describe the same paid-access lifecycle, which is
 * exactly what docs/database/subscriptions-data-model.md already says. What makes an AI subscription
 * different is not its own transitions but the cross-entity rule below -- it is additionally gated on
 * its school, and no provider event expresses that.
 *
 * Kept as a separate binding rather than an alias so ST-136 can diverge it without touching the
 * school lifecycle, and so `resolveTransition` reads the same either way.
 */
export const AI_TRANSITIONS: TransitionTable = { ...SCHOOL_TRANSITIONS };

const TRANSITION_TABLES: Readonly<Record<SubscriptionKind, TransitionTable>> = {
  school: SCHOOL_TRANSITIONS,
  ai: AI_TRANSITIONS,
};

/**
 * The target state, or `null` when the transition is illegal.
 *
 * `null` means "park this event", never "leave the state alone" -- an event that legitimately has
 * nothing to say about status never reaches here, because `deriveIntent` classified it as `ignored`
 * first.
 */
export function resolveTransition(
  kind: SubscriptionKind,
  from: SubscriptionStatus,
  intent: BillingEventIntent,
): SubscriptionStatus | null {
  return TRANSITION_TABLES[kind][`${from}:${intent}`] ?? null;
}

// ---------------------------------------------------------------------------
// Cross-entity rule: school -> AI
// ---------------------------------------------------------------------------

/**
 * The state an AI subscription is driven to when its school subscription changes state.
 *
 * ST-131 makes an active school subscription a precondition for buying an AI add-on, so the AI
 * entitlement cannot outlive the school's. This is the one transition no provider event describes:
 * Stripe has no opinion about a relationship this product invented.
 *
 * Two halves, and the asymmetry is the point:
 *
 *   - Leaving a live state cascades. The school going `canceled`/`expired`/`closed` takes every AI
 *     subscription under it to the same state, in the same transaction as the school's own change.
 *   - Returning to a live state does NOT cascade. A school that recovers from `past_due` to `active`
 *     does not resurrect AI subscriptions that were canceled with it: re-entitling a student is a
 *     billing decision with a price attached, not an automatic consequence, and inventing one here
 *     would silently grant paid access. ST-136 owns pause/resume semantics; this ticket stops at
 *     making the terminal direction correct.
 *
 * Returns `null` when no cascade applies.
 */
export function resolveAiCascade(
  schoolFrom: SubscriptionStatus,
  schoolTo: SubscriptionStatus,
): SubscriptionStatus | null {
  if (!LIVE_STATUSES.has(schoolFrom)) return null;
  if (LIVE_STATUSES.has(schoolTo)) return null;
  return schoolTo;
}

// ---------------------------------------------------------------------------
// Provider vocabulary -> intent
// ---------------------------------------------------------------------------

export type IntentResolution =
  /** The event means something for status. */
  | { kind: "transition"; intent: BillingEventIntent }
  /** A known event that carries no status meaning. Processed, no transition, no audit row. */
  | { kind: "ignored" }
  /** An event this processor does not know at all. Parked for a human, per ST-132's DLQ rule. */
  | { kind: "unmapped" };

/**
 * Stripe subscription statuses, mapped to intents.
 *
 * `incomplete` is genuinely "nothing has happened yet" -- the customer opened Checkout and has not
 * paid -- so it maps to no intent rather than to a state. Treating it as a transition would move a
 * subscription on the strength of an abandoned browser tab.
 */
const STRIPE_STATUS_INTENTS: Readonly<Record<string, BillingEventIntent | null>> = {
  trialing: "trial_started",
  active: "activated",
  past_due: "payment_failed",
  unpaid: "dunning_exhausted",
  paused: "dunning_exhausted",
  canceled: "canceled",
  incomplete_expired: "expired",
  incomplete: null,
};

/** Events whose intent is fixed by the event type alone, whatever the payload says. */
const FIXED_EVENT_INTENTS: Readonly<Record<string, BillingEventIntent>> = {
  "checkout.session.completed": "activated",
  "customer.subscription.deleted": "canceled",
  "customer.subscription.paused": "dunning_exhausted",
  "invoice.paid": "activated",
  "invoice.payment_succeeded": "activated",
  "invoice.payment_failed": "payment_failed",
  // Stripe's terminal dunning outcome: every retry configured on the account has been exhausted.
  "invoice.marked_uncollectible": "grace_exhausted",
};

/** Events whose intent comes from the `status` field of the subscription object they carry. */
const STATUS_BEARING_EVENTS: ReadonlySet<string> = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.resumed",
]);

/**
 * Events we knowingly receive and knowingly do nothing about.
 *
 * An allowlist rather than a catch-all `default: ignore`, because "unmapped event type" is one of
 * the poison-event cases ST-132 requires be dead-lettered. Silently ignoring anything unrecognised
 * would make a genuinely new Stripe event -- the kind that *should* wake somebody up -- indis-
 * tinguishable from a `charge.succeeded` we never cared about.
 */
const IGNORED_EVENTS: ReadonlySet<string> = new Set([
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "customer.subscription.trial_will_end",
  "invoice.created",
  "invoice.finalized",
  "invoice.upcoming",
  "invoice.updated",
  "invoice.sent",
  "invoice.voided",
  "payment_intent.created",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_method.attached",
  "payment_method.detached",
  "payment_method.updated",
  "charge.succeeded",
  "charge.failed",
  "charge.refunded",
  "checkout.session.expired",
  "price.created",
  "price.updated",
  "product.created",
  "product.updated",
]);

/**
 * Classify one provider event.
 *
 * The single place Stripe's vocabulary is interpreted. The convergence fold calls this on every
 * historical row as well as on the arriving event, so a change here changes both -- which is the
 * property that keeps "what this event meant" from being decided differently in two places.
 */
export function deriveIntent(
  eventType: string,
  payload: Record<string, unknown>,
): IntentResolution {
  const fixed = FIXED_EVENT_INTENTS[eventType];
  if (fixed) return { kind: "transition", intent: fixed };

  if (STATUS_BEARING_EVENTS.has(eventType)) {
    const status = typeof payload.status === "string" ? payload.status : undefined;
    if (status === undefined) return { kind: "unmapped" };

    // `undefined` (absent key) is a Stripe status we have never seen and must be told about;
    // `null` (present, mapped to nothing) is one we have decided carries no state meaning.
    if (!(status in STRIPE_STATUS_INTENTS)) return { kind: "unmapped" };

    const intent = STRIPE_STATUS_INTENTS[status];
    return intent === null || intent === undefined
      ? { kind: "ignored" }
      : { kind: "transition", intent };
  }

  return IGNORED_EVENTS.has(eventType) ? { kind: "ignored" } : { kind: "unmapped" };
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** One historical event, as the fold needs it. */
export interface FoldableEvent {
  /** `provider_event_id`. Carried so a caller can ask whether *its own* event was the one skipped. */
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface SkippedStep {
  id: string;
  eventType: string;
  from: SubscriptionStatus;
  intent: BillingEventIntent;
}

export interface FoldResult {
  status: SubscriptionStatus;
  /** Steps whose `(from, intent)` pair had no legal target. Non-empty means something was parked. */
  skipped: SkippedStep[];
}

/**
 * Replay a subscription's whole event history, in effective-time order, to a final state.
 *
 * This is how out-of-order delivery is tolerated, and it is a re-fold rather than a patch for a
 * reason worth stating, because the cheaper design looks correct until it isn't.
 *
 * The obvious alternative is a watermark: keep the newest `effective_at` applied so far and ignore
 * anything older. That is *not* permutation-invariant. Take a cancellation at T1 and a renewal at
 * T2 > T1, where the renewal cannot legally follow a cancellation:
 *
 *   in order      -- cancel applies, renewal hits an absorbing state and is parked -> canceled
 *   out of order  -- renewal applies, cancel is older than the watermark and is skipped -> active
 *
 * Same two events, two different final states, decided by network timing. Re-folding from genesis
 * over the full ordered history has no such freedom: the sequence handed to this function is the
 * same set sorted the same way regardless of arrival order, so the result is a pure function of the
 * set. That is exactly the property the ST-132 permutation test asserts.
 *
 * Callers order by `(effective_at, provider_event_id)`. The second key is not decoration: two Stripe
 * events can share a `created` second, and without a tiebreaker the ordering would not be total and
 * the fold would stop being deterministic.
 */
export function foldStatus(kind: SubscriptionKind, events: readonly FoldableEvent[]): FoldResult {
  let status = GENESIS_STATUS;
  const skipped: FoldResult["skipped"] = [];

  for (const event of events) {
    const resolution = deriveIntent(event.eventType, event.payload);
    if (resolution.kind !== "transition") continue;

    const next = resolveTransition(kind, status, resolution.intent);
    if (next === null) {
      skipped.push({
        id: event.id,
        eventType: event.eventType,
        from: status,
        intent: resolution.intent,
      });
      continue;
    }

    status = next;
  }

  return { status, skipped };
}
