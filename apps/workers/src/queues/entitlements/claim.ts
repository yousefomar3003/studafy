import { DOMAIN_EVENTS } from "@studafy/constants";

import type { TransactionSql } from "postgres";

/**
 * Row claiming for the entitlement invalidator (ST-133).
 *
 * Like the email dispatcher's claim, this is scoped by tenant isolation rather than a `school_id`
 * predicate: it runs inside `withSystemTenantTx`, so the FORCE'd RLS on `app.outbox_events` already
 * narrows the result to the school being processed. `FOR UPDATE SKIP LOCKED` is what makes concurrent
 * invalidator instances safe — whichever transaction locks a row first wins and the others move on.
 */

/**
 * The events this consumer claims.
 *
 * Must stay in step with the `event_name IN (...)` list in
 * `idx_outbox_events_school_entitlement_pending` (000080). The index predicate names these two
 * explicitly so it stays proportional to the unresolved entitlement tail rather than to the whole
 * outbox; the cost of that narrowness is that adding a third event needs a migration as well as a
 * change here.
 */
export const ENTITLEMENT_EVENT_NAMES = [
  DOMAIN_EVENTS.SUBSCRIPTION_STATUS_CHANGED,
  DOMAIN_EVENTS.AI_SUBSCRIPTION_STATUS_CHANGED,
] as const;

export interface ClaimedEntitlementRow {
  id: string;
  school_id: string;
  event_name: string;
  payload: {
    schoolId?: unknown;
    studentId?: unknown;
    entitlementsVersion?: unknown;
  };
}

export async function claimEntitlementRows(
  tx: TransactionSql,
  limit: number,
): Promise<ClaimedEntitlementRow[]> {
  // The WHERE clause repeats the partial index predicate verbatim, including both event names.
  // Postgres only uses a partial index when it can prove the query implies the predicate, so
  // dropping either half here would silently fall back to a sequential scan of the outbox.
  return await tx<ClaimedEntitlementRow[]>`
    SELECT id::text AS id, school_id::text AS school_id, event_name, payload
    FROM app.outbox_events
    WHERE entitlement_applied_at IS NULL
      AND event_name IN ${tx([...ENTITLEMENT_EVENT_NAMES])}
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT ${limit}
  `;
}

/** Mark the claimed rows consumed, in the same transaction that claimed them. */
export async function markEntitlementRowsApplied(
  tx: TransactionSql,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  await tx`
    UPDATE app.outbox_events
    SET entitlement_applied_at = CURRENT_TIMESTAMP
    WHERE id = ANY(${[...ids]}::bigint[])
  `;
}
