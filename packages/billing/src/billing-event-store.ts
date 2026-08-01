/**
 * Reads and writes over `app.billing_events` (ST-132).
 *
 * Every statement here runs as `studafy_admin`: the table revokes all privileges from `studafy_app`
 * and its only policy names the admin role (000016, restated in 000078). Callers get there through
 * `withSystemTx`.
 */

import type { SubscriptionKind } from "./state-machine";
import type { JSONValue, TransactionSql } from "postgres";

/** Mirrors `ck_billing_events_last_error`'s length bound. Truncate here, never let the CHECK reject. */
export const MAX_LAST_ERROR_LENGTH = 2000;

export function truncateError(value: string): string {
  return value.length <= MAX_LAST_ERROR_LENGTH
    ? value
    : `${value.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…`;
}

export interface ClaimInput {
  providerEventId: string;
  eventType: string;
  effectiveAt: Date;
  payload: Record<string, unknown>;
}

/**
 * Claim an event for processing, or discover that someone already has.
 *
 * This single statement is the whole idempotency guarantee, and it is a database guarantee rather
 * than an application one on purpose.
 *
 * A `SELECT` followed by an `INSERT` -- which is what this replaced -- has a window between the two
 * in which a concurrent redelivery also sees "not present" and also inserts. Under Stripe's retry
 * behaviour that window is not theoretical. `INSERT ... ON CONFLICT DO NOTHING RETURNING id` has no
 * window: the second transaction blocks on `uq_billing_events_provider_event_id` until the first
 * commits, then returns zero rows. The loser exits cleanly with no application-level mutex, no
 * advisory lock and no retry, which is exactly the property ST-132 asks for. It is the same claim
 * shape `app.erpnext_webhook_dedup`, `app.email_deliveries` and `app.notification_idempotency_keys`
 * already rely on.
 *
 * Returns the new row's id, or `null` when this delivery lost the race (or is a plain replay).
 *
 * `tx.json()`, never `JSON.stringify()`: postgres.js serializes parameters bound to a `jsonb`
 * column, so a pre-stringified value is encoded twice and stored as a jsonb *string*, silently
 * corrupting every reader downstream -- including the fold, which would then see no payload fields
 * at all.
 */
export async function claimEvent(tx: TransactionSql, input: ClaimInput): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO app.billing_events (
      provider, provider_event_id, event_type, effective_at, payload, status, attempt_count
    ) VALUES (
      'stripe',
      ${input.providerEventId},
      ${input.eventType},
      ${input.effectiveAt},
      ${tx.json(input.payload as JSONValue)},
      'pending',
      1
    )
    ON CONFLICT (provider, provider_event_id) DO NOTHING
    RETURNING id
  `;

  return rows.length > 0 ? rows[0]!.id : null;
}

/** Record which subscription an event was attributed to, so the fold can find it later. */
export async function attributeEvent(
  tx: TransactionSql,
  id: string,
  kind: SubscriptionKind,
  subscriptionId: string,
): Promise<void> {
  await tx`
    UPDATE app.billing_events
    SET subscription_type = ${kind}::app.billing_subscription_type,
        subscription_id = ${subscriptionId}::uuid,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
  `;
}

export async function markProcessed(tx: TransactionSql, id: string): Promise<void> {
  await tx`
    UPDATE app.billing_events
    SET status = 'processed',
        processed_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
  `;
}

/**
 * Park an event no retry can help: a payload we cannot attribute, an event type we do not know, or a
 * transition the state machine refuses.
 *
 * Terminal by design. Re-running any of these produces the same answer, so enqueuing a retry would
 * burn attempts to reach the same conclusion; what these rows need is a human, and they stay fully
 * inspectable -- reason in `last_error`, raw event in `payload` -- for one.
 */
export async function markDeadLettered(
  tx: TransactionSql,
  id: string,
  reason: string,
): Promise<void> {
  await tx`
    UPDATE app.billing_events
    SET status = 'dlq',
        last_error = ${truncateError(reason)},
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${id}::uuid
  `;
}

/**
 * Record a transient failure and leave the row retryable.
 *
 * Runs in its own transaction, because the one that failed is being rolled back -- writing the
 * reason inside it would roll the reason back too, leaving a row stuck in `pending` with no
 * explanation. `idx_billing_events_unresolved` is what the retry worker polls to find it.
 */
export async function markFailed(
  tx: TransactionSql,
  providerEventId: string,
  reason: string,
): Promise<void> {
  await tx`
    UPDATE app.billing_events
    SET status = 'failed',
        last_error = ${truncateError(reason)},
        attempt_count = attempt_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE provider = 'stripe' AND provider_event_id = ${providerEventId}
  `;
}

export interface HistoricalEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * This subscription's full event sequence, oldest effective time first, ready to fold.
 *
 * Ordered by `(effective_at, provider_event_id)` and served by
 * `idx_billing_events_subscription_effective`. The second sort key is not cosmetic: two Stripe
 * events can share a `created` second, and an ordering that is not total would let the planner's row
 * order decide the result -- precisely the non-determinism the fold exists to eliminate.
 *
 * The set is "everything already applied, plus the event being processed now". Ordering it in SQL
 * rather than splicing the new event into a fetched list in TypeScript is what makes arrival order
 * irrelevant: an event that Stripe delivered late simply sorts into its own place, and the sequence
 * handed to `foldStatus` is the same whichever order the deliveries happened to arrive in.
 *
 * `failed` and `dlq` rows are excluded. Neither ever contributed to the current state, and letting
 * one join the fold retroactively -- because some later event happened to trigger a reload -- would
 * apply an event that was explicitly rejected.
 */
export async function loadFoldSequence(
  tx: TransactionSql,
  kind: SubscriptionKind,
  subscriptionId: string,
  pendingEventId: string,
): Promise<HistoricalEvent[]> {
  const rows = await tx<
    { provider_event_id: string; event_type: string; payload: Record<string, unknown> }[]
  >`
    SELECT provider_event_id, event_type, payload
    FROM app.billing_events
    WHERE subscription_type = ${kind}::app.billing_subscription_type
      AND subscription_id = ${subscriptionId}::uuid
      AND (status = 'processed' OR id = ${pendingEventId}::uuid)
    ORDER BY effective_at, provider_event_id
  `;

  return rows.map((row) => ({
    id: row.provider_event_id,
    eventType: row.event_type,
    payload: row.payload,
  }));
}
