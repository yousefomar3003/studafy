/**
 * Row claiming for the email dispatcher.
 *
 * The claim query is scoped by tenant isolation rather than a school_id predicate: the dispatcher
 * runs it inside withSystemTenantTx, so the FORCE'd RLS on app.outbox_events already narrows the
 * result to the school being processed. FOR UPDATE SKIP LOCKED is what makes concurrent dispatcher
 * instances safe — whichever transaction locks a row first wins, the others skip it.
 */

import { EMAIL_EVENT_NAMES } from "./resolve";

import type { ClaimedOutboxRow } from "./resolve";
import type { TransactionSql } from "postgres";

export async function claimEmailRows(
  tx: TransactionSql,
  limit: number,
): Promise<ClaimedOutboxRow[]> {
  return await tx<ClaimedOutboxRow[]>`
    SELECT id, school_id, event_name, payload, created_at
    FROM app.outbox_events
    WHERE event_name IN ${tx(EMAIL_EVENT_NAMES)}
      AND email_dispatched_at IS NULL
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT ${limit}
  `;
}
