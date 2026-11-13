/**
 * Deciding whose subscription an inbound webhook is about (ST-132).
 *
 * Attribution is deliberately a two-step affair, and the seam between the steps is a tenant
 * boundary rather than an aesthetic one:
 *
 *   1. `resolveSchoolId` runs *before* `app.school_id` is set, so it may only read tables that are
 *      not tenant-isolated. `app.schools` is one of the six global tables (see
 *      docs/database/global-tables.md), which is exactly why `stripe_customer_id` -- written on it
 *      by checkout-service before any Checkout session is created -- is the attribution key. Reading
 *      `app.subscriptions` here instead would either error on an unset GUC or, worse, match nothing
 *      and look like "no such subscription".
 *   2. `resolveTarget` runs after `setTenantScope`, with RLS armed, and is therefore free to read
 *      the subscription tables. Every query it issues is additionally scoped by `school_id` in the
 *      predicate as well as by the policy -- belt and braces, and it makes the intent readable
 *      without knowing the policy exists.
 */

import { isStorageAddonPlanCode, STORAGE_ADDON_TIERS } from "@studafy/constants";

import {
  extractAddonHint,
  extractLocalPriceIdHint,
  extractStudentIdHint,
  extractSubscriptionId,
} from "./event-mapping";
import { TERMINAL_STATUSES } from "./state-machine";

import type { BillingEventSource, BillingProvider } from "./billing-event-store";
import type { SubscriptionKind } from "./state-machine";
import type { SubscriptionStatus } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/**
 * How long an AI subscription row lives before a real provider period replaces it.
 *
 * `app.ai_subscriptions.current_period_start/end` are NOT NULL with `end > start`, so the row
 * created when Checkout completes needs *some* period -- and `checkout.session.completed` carries
 * none. The authoritative dates arrive moments later on `customer.subscription.created` and
 * overwrite this. Matches the placeholder the pre-ST-132 handler used, so behaviour here is
 * unchanged.
 */
const AI_PLACEHOLDER_PERIOD_DAYS = 30;

/** The same placeholder for a storage add-on row, whose period columns are NOT NULL too (000205). */
const STORAGE_PLACEHOLDER_PERIOD_DAYS = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttributionTarget {
  kind: SubscriptionKind;
  /** Our row's uuid -- the audit `target_id` and the `billing_events.subscription_id`. */
  id: string;
  schoolId: string;
  /**
   * The student this AI add-on belongs to, or `null` for a school subscription (ST-133).
   *
   * Carried so the entitlement change publisher can key the student's version counter and cache
   * entry without a second lookup. `app.ai_subscriptions.student_id` is NOT NULL, so this is
   * non-null exactly when `kind === "ai"`.
   */
  studentId: string | null;
  status: SubscriptionStatus;
}

/**
 * The school this event concerns, or `null` if it cannot be established.
 *
 * `null` is terminal for this event: with no school there is no tenant scope to enter, no
 * subscription to look up and nothing to audit against, so the caller parks it. That is the right
 * outcome rather than a retry -- the missing link is a `stripe_customer_id` mapping that a redelivery
 * will not conjure.
 */
export async function resolveSchoolId(
  tx: TransactionSql,
  provider: BillingEventSource,
  customerId: string | null,
  schoolIdHint: string | null,
): Promise<string | null> {
  // Only the payment providers have customers; an app-store purchase is attributed by its metadata.
  if (customerId && (provider === "stripe" || provider === "tap")) {
    const rows = await findSchoolByCustomerId(tx, provider, customerId);
    if (rows.length > 0) return rows[0]!.id;
  }

  // Metadata is the fallback, not the primary: it is set by our own Checkout call and so is present
  // on the events that flow from one, but an event Stripe originates on its own (a dunning invoice,
  // say) may carry none. It is still worth trying -- a school whose stripe_customer_id write was
  // lost is recoverable from it -- but it is checked second because it is the weaker guarantee.
  if (schoolIdHint) {
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM app.schools WHERE id = ${schoolIdHint}::uuid LIMIT 1
    `;
    if (rows.length > 0) return rows[0]!.id;
  }

  return null;
}

/**
 * Each provider's customer id lives in its own column, so a Tap `cus_...` can never match a Stripe
 * `cus_...` that happens to share the string. Two literal statements rather than one with an
 * interpolated column name: identifiers are not parameters, and the SQL-safety lint rightly refuses
 * to let one be built from a string.
 */
async function findSchoolByCustomerId(
  tx: TransactionSql,
  provider: BillingProvider,
  customerId: string,
): Promise<readonly { id: string }[]> {
  return provider === "tap"
    ? tx<{ id: string }[]>`
        SELECT id FROM app.schools WHERE tap_customer_id = ${customerId} LIMIT 1
      `
    : tx<{ id: string }[]>`
        SELECT id FROM app.schools WHERE stripe_customer_id = ${customerId} LIMIT 1
      `;
}

/**
 * The subscription row this event should move, creating the AI row if this is the event that buys it.
 *
 * Resolution order runs strongest key first. The provider subscription id is a natural key both
 * tables carry and Stripe guarantees unique, so it wins; the metadata hints are a fallback for the
 * one event that precedes the id being stamped on (`checkout.session.completed`, where the row and
 * the link are created together); and a school with neither falls through to its single school
 * subscription, which `uq_subscriptions_school` makes unambiguous.
 */
export async function resolveTarget(
  tx: TransactionSql,
  schoolId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<AttributionTarget | null> {
  const stripeSubscriptionId = extractSubscriptionId(payload);

  if (stripeSubscriptionId) {
    const byProviderKey = await findByProviderSubscriptionId(tx, schoolId, stripeSubscriptionId);
    if (byProviderKey) return byProviderKey;
  }

  // A storage add-on is a school purchase with no student, so it must be told apart before the
  // fall-through to the school's own subscription below -- which would otherwise activate, renew or
  // cancel the school plan on the strength of a storage payment.
  if (extractAddonHint(payload) === "storage") {
    return resolveStorageTarget(tx, schoolId, eventType, payload, stripeSubscriptionId);
  }

  const studentId = extractStudentIdHint(payload);

  if (studentId) {
    const existing = await tx<{ id: string; status: SubscriptionStatus }[]>`
      SELECT id, status::text AS status
      FROM app.ai_subscriptions
      WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
      LIMIT 1
    `;

    if (existing.length > 0) {
      const row = existing[0]!;
      await linkProviderSubscription(tx, "ai", row.id, stripeSubscriptionId);
      return { kind: "ai", id: row.id, schoolId, studentId, status: row.status };
    }

    // Only Checkout completing creates an entitlement. A later event naming a student we have no
    // row for is a genuine inconsistency and must be parked rather than papered over by conjuring a
    // paid entitlement out of an invoice.
    if (eventType !== "checkout.session.completed") return null;

    const created = await createAiSubscription(tx, schoolId, studentId, stripeSubscriptionId);
    return created === null
      ? null
      : { kind: "ai", id: created, schoolId, studentId, status: "trialing" };
  }

  const school = await tx<{ id: string; status: SubscriptionStatus }[]>`
    SELECT id, status::text AS status
    FROM app.subscriptions
    WHERE school_id = ${schoolId}::uuid
    LIMIT 1
  `;

  if (school.length === 0) return null;

  const row = school[0]!;
  await linkProviderSubscription(tx, "school", row.id, stripeSubscriptionId);
  return { kind: "school", id: row.id, schoolId, studentId: null, status: row.status };
}

async function findByProviderSubscriptionId(
  tx: TransactionSql,
  schoolId: string,
  stripeSubscriptionId: string,
): Promise<AttributionTarget | null> {
  const ai = await tx<{ id: string; student_id: string; status: SubscriptionStatus }[]>`
    SELECT id, student_id, status::text AS status
    FROM app.ai_subscriptions
    WHERE school_id = ${schoolId}::uuid AND stripe_subscription_id = ${stripeSubscriptionId}
    LIMIT 1
  `;
  if (ai.length > 0) {
    return {
      kind: "ai",
      id: ai[0]!.id,
      schoolId,
      studentId: ai[0]!.student_id,
      status: ai[0]!.status,
    };
  }

  const storage = await tx<{ id: string; status: SubscriptionStatus }[]>`
    SELECT id, status::text AS status
    FROM app.storage_subscriptions
    WHERE school_id = ${schoolId}::uuid AND stripe_subscription_id = ${stripeSubscriptionId}
    LIMIT 1
  `;
  if (storage.length > 0) {
    return {
      kind: "storage",
      id: storage[0]!.id,
      schoolId,
      studentId: null,
      status: storage[0]!.status,
    };
  }

  const school = await tx<{ id: string; status: SubscriptionStatus }[]>`
    SELECT id, status::text AS status
    FROM app.subscriptions
    WHERE school_id = ${schoolId}::uuid AND stripe_subscription_id = ${stripeSubscriptionId}
    LIMIT 1
  `;
  if (school.length > 0) {
    return {
      kind: "school",
      id: school[0]!.id,
      schoolId,
      studentId: null,
      status: school[0]!.status,
    };
  }

  return null;
}

/**
 * Stamp the provider subscription id onto a row that does not have one yet.
 *
 * `IS NULL` in the predicate rather than an unconditional SET: the id is the natural key the next
 * event will be attributed by, and overwriting it would silently re-point a row at a different
 * provider subscription. Both columns are UNIQUE, so a genuine conflict raises rather than corrupts.
 */
async function linkProviderSubscription(
  tx: TransactionSql,
  kind: SubscriptionKind,
  id: string,
  stripeSubscriptionId: string | null,
): Promise<void> {
  if (!stripeSubscriptionId) return;

  if (kind === "ai") {
    await tx`
      UPDATE app.ai_subscriptions
      SET stripe_subscription_id = ${stripeSubscriptionId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid AND stripe_subscription_id IS NULL
    `;
    return;
  }

  if (kind === "storage") {
    await tx`
      UPDATE app.storage_subscriptions
      SET stripe_subscription_id = ${stripeSubscriptionId}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${id}::uuid AND stripe_subscription_id IS NULL
    `;
    return;
  }

  await tx`
    UPDATE app.subscriptions
    SET stripe_subscription_id = ${stripeSubscriptionId}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid AND stripe_subscription_id IS NULL
  `;
}

/**
 * Create the AI entitlement row a completed Checkout just paid for.
 *
 * `ON CONFLICT DO NOTHING` on the natural key rather than a plain INSERT: two deliveries of the same
 * Checkout completion can race here, and the unique constraint is what settles it. A conflict means
 * the other delivery won, so this one re-reads the row it lost to instead of failing.
 */
async function createAiSubscription(
  tx: TransactionSql,
  schoolId: string,
  studentId: string,
  stripeSubscriptionId: string | null,
): Promise<string | null> {
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO app.ai_subscriptions (
      school_id, student_id, status, current_period_start, current_period_end, stripe_subscription_id
    ) VALUES (
      ${schoolId}::uuid,
      ${studentId}::uuid,
      'trialing'::app.subscription_status,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + ${`${AI_PLACEHOLDER_PERIOD_DAYS} days`}::interval,
      ${stripeSubscriptionId}
    )
    ON CONFLICT (school_id, student_id) DO NOTHING
    RETURNING id
  `;

  if (inserted.length > 0) return inserted[0]!.id;

  const existing = await tx<{ id: string }[]>`
    SELECT id FROM app.ai_subscriptions
    WHERE school_id = ${schoolId}::uuid AND student_id = ${studentId}::uuid
    LIMIT 1
  `;
  return existing.length > 0 ? existing[0]!.id : null;
}

// ---------------------------------------------------------------------------
// Storage add-on (000205)
// ---------------------------------------------------------------------------

interface StorageRow {
  id: string;
  status: SubscriptionStatus;
  stripe_subscription_id: string | null;
}

/**
 * The school's storage add-on row this event moves, creating or re-arming it when the event is the
 * completed checkout that bought it.
 *
 * A checkout completion fixes the tier: the `price_id` our checkout wrote names an `app.plan_prices`
 * row of a storage plan, and its cap is copied onto the row. A later event never changes the tier --
 * a tier change is made by the API when the provider has accepted it, which keeps an out-of-order
 * delivery from undoing it.
 *
 * Parked (null) rather than guessed: a completion naming no storage price, any other event for a
 * school with no storage row, and a second purchase while one is still live (two provider
 * subscriptions for one add-on is a double charge a person has to sort out, not something to fold).
 */
async function resolveStorageTarget(
  tx: TransactionSql,
  schoolId: string,
  eventType: string,
  payload: Record<string, unknown>,
  stripeSubscriptionId: string | null,
): Promise<AttributionTarget | null> {
  const [existing] = await tx<StorageRow[]>`
    SELECT id, status::text AS status, stripe_subscription_id
    FROM app.storage_subscriptions
    WHERE school_id = ${schoolId}::uuid
    LIMIT 1
  `;

  const target = (row: { id: string; status: SubscriptionStatus }): AttributionTarget => ({
    kind: "storage",
    id: row.id,
    schoolId,
    studentId: null,
    status: row.status,
  });

  if (eventType !== "checkout.session.completed") {
    if (!existing) return null;
    await linkProviderSubscription(tx, "storage", existing.id, stripeSubscriptionId);
    return target(existing);
  }

  const tier = await storageTierOf(tx, extractLocalPriceIdHint(payload));
  if (tier === null) return null;

  if (!existing) {
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO app.storage_subscriptions (
        school_id, plan_price_id, cap_bytes, status, current_period_start, current_period_end,
        stripe_subscription_id
      ) VALUES (
        ${schoolId}::uuid,
        ${tier.priceId}::uuid,
        ${tier.capBytes},
        'trialing'::app.subscription_status,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + ${`${STORAGE_PLACEHOLDER_PERIOD_DAYS} days`}::interval,
        ${stripeSubscriptionId}
      )
      ON CONFLICT (school_id) DO NOTHING
      RETURNING id
    `;
    if (inserted.length > 0) return target({ id: inserted[0]!.id, status: "trialing" });

    // A concurrent delivery of the same completion created it first: use that row.
    const [raced] = await tx<StorageRow[]>`
      SELECT id, status::text AS status, stripe_subscription_id
      FROM app.storage_subscriptions
      WHERE school_id = ${schoolId}::uuid
      LIMIT 1
    `;
    return raced ? target(raced) : null;
  }

  const sameSubscription =
    existing.stripe_subscription_id === null ||
    stripeSubscriptionId === null ||
    existing.stripe_subscription_id === stripeSubscriptionId;
  const ended = TERMINAL_STATUSES.has(existing.status);

  // Still live under another provider subscription: a second purchase. Park it for a person.
  if (!sameSubscription && !ended) return null;

  // Bought again after the last one ended (the fold restarts its lifecycle on this completion), or a
  // redelivery of the completion that bought this one: the row takes this purchase's tier and
  // provider subscription.
  await tx`
    UPDATE app.storage_subscriptions
    SET plan_price_id = ${tier.priceId}::uuid,
        cap_bytes = ${tier.capBytes},
        stripe_subscription_id = COALESCE(${stripeSubscriptionId}::text, stripe_subscription_id),
        cancel_at_period_end = CASE WHEN ${ended} THEN false ELSE cancel_at_period_end END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${existing.id}::uuid
  `;
  return target(existing);
}

/** The storage tier an `app.plan_prices` id sells, or null when it is not a storage plan's price. */
async function storageTierOf(
  tx: TransactionSql,
  priceId: string | null,
): Promise<{ priceId: string; capBytes: number } | null> {
  if (priceId === null || !UUID_PATTERN.test(priceId)) return null;

  const [row] = await tx<{ code: string }[]>`
    SELECT p.code
    FROM app.plan_prices pp
    JOIN app.plans p ON p.id = pp.plan_id
    WHERE pp.id = ${priceId}::uuid
    LIMIT 1
  `;
  if (!row || !isStorageAddonPlanCode(row.code)) return null;
  return { priceId, capBytes: STORAGE_ADDON_TIERS[row.code].capBytes };
}
