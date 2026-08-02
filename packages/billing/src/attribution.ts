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

import { extractStudentIdHint, extractSubscriptionId } from "./event-mapping";

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
  customerId: string | null,
  schoolIdHint: string | null,
): Promise<string | null> {
  if (customerId) {
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM app.schools WHERE stripe_customer_id = ${customerId} LIMIT 1
    `;
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
