/**
 * Row claiming for the email dispatcher.
 *
 * The claim query is scoped by tenant isolation rather than a school_id predicate: the dispatcher
 * runs it inside withSystemTenantTx, so the FORCE'd RLS on app.outbox_events already narrows the
 * result to the school being processed. FOR UPDATE SKIP LOCKED is what makes concurrent dispatcher
 * instances safe — whichever transaction locks a row first wins, the others skip it.
 *
 * The WHERE clause implies the partial index `idx_outbox_events_school_email_claim` (000199), whose
 * predicate is `email_dispatched_at IS NULL AND event_name IN (<EMAIL_EVENT_NAMES>)`. Postgres only
 * uses a partial index when it can prove the query implies the predicate, so the event-name filter
 * here must stay a subset of that list: adding an email event needs a migration that rebuilds the
 * index as well as the change to EMAIL_EVENT_NAMES (an outbox-discovery test pins the two
 * together). `app.outbox_pending_school_ids('email')` (000200) repeats the same predicate.
 *
 * A row whose last send attempt failed transiently waits for `email_next_attempt_at` (000200); the
 * claim skips it until then, so one failing message never holds up the school's later ones.
 */

import { EMAIL_EVENT_NAMES } from "./resolve";

import type { ClaimedOutboxRow } from "./resolve";
import type { TransactionSql } from "postgres";

export interface ClaimedEmailRow extends ClaimedOutboxRow {
  /** Transient send failures so far (000200). */
  email_attempts: number;
}

export async function claimEmailRows(
  tx: TransactionSql,
  limit: number,
): Promise<ClaimedEmailRow[]> {
  return await tx<ClaimedEmailRow[]>`
    SELECT id, school_id, event_name, payload, created_at, email_attempts
    FROM app.outbox_events
    WHERE event_name IN ${tx(EMAIL_EVENT_NAMES)}
      AND email_dispatched_at IS NULL
      AND (email_next_attempt_at IS NULL OR email_next_attempt_at <= CURRENT_TIMESTAMP)
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT ${limit}
  `;
}
