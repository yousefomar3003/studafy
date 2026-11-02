import type { TransactionSql } from "postgres";

/**
 * One batch of unrelayed outbox rows, claimed atomically via FOR UPDATE SKIP LOCKED. The relay
 * worker publishes these and marks them in the same transaction.
 */
export interface ClaimedBatch {
  rows: OutboxRow[];
}

export interface OutboxRow {
  id: string;
  school_id: string;
  event_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/**
 * Claim the next batch of unrelayed events for one tenant. Runs inside a transaction that holds
 * row locks for the duration — the caller must UPDATE relayed_at on these exact rows before
 * committing.
 *
 * Two concurrent relayers never claim the same row: whichever transaction locks a row first wins;
 * the other skips it and moves to the next candidate. This gives exactly-once claim semantics.
 * If the claiming transaction crashes before committing, the locks release and the rows remain
 * unrelayed — at-least-once delivery.
 */
export async function claimBatch(
  tx: TransactionSql,
  schoolId: string,
  batchSize: number,
): Promise<ClaimedBatch> {
  const rows = await tx<OutboxRow[]>`
    SELECT id, school_id, event_name, payload, created_at
    FROM app.outbox_events
    WHERE school_id = ${schoolId} AND relayed_at IS NULL
    ORDER BY id
    FOR UPDATE SKIP LOCKED
    LIMIT ${batchSize}
  `;
  return { rows };
}
