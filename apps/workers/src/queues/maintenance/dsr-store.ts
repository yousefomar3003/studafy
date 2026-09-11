/**
 * The app.data_subject_requests lifecycle port (ST-268), mirroring the report framework's
 * ReportStateStore (apps/workers/src/queues/reports/report-state-store.ts) in spirit -- claim, then
 * complete or fail -- but not its exact shape: a request here is export XOR erasure, only export
 * produces a storage key, and erasure's "what happened" is a structured list, not a single artifact.
 * Force-fitting this into ReportStateStore would mean padding erasure with unused signed-URL fields
 * for no benefit, so this is its own small, purpose-built port instead.
 */

import type { DataSubjectRequestRow, RedactedTableEntry, RetainedTableEntry } from "./dsr-types";
import type { TransactionSql } from "postgres";

function parseRow(row: Record<string, unknown>): DataSubjectRequestRow {
  return {
    id: row.id as string,
    schoolId: row.school_id as string,
    requestType: row.request_type as DataSubjectRequestRow["requestType"],
    subjectScope: row.subject_scope as DataSubjectRequestRow["subjectScope"],
    reason: row.reason as DataSubjectRequestRow["reason"],
    subjectUserId: row.subject_user_id as string | null,
    requestedByUserId: row.requested_by_user_id as string,
    status: row.status as DataSubjectRequestRow["status"],
    storageKey: row.storage_key as string | null,
    redactedTables: row.redacted_tables as RedactedTableEntry[],
    retainedTables: row.retained_tables as RetainedTableEntry[],
    failureMessage: row.failure_message as string | null,
    slaDueAt: row.sla_due_at as Date,
    createdAt: row.created_at as Date,
    startedAt: row.started_at as Date | null,
    completedAt: row.completed_at as Date | null,
  };
}

const ROW_COLUMNS = `
  id, school_id, request_type::text AS request_type, subject_scope::text AS subject_scope,
  reason::text AS reason, subject_user_id, requested_by_user_id, status::text AS status,
  storage_key, redacted_tables, retained_tables, failure_message, sla_due_at,
  created_at, started_at, completed_at
`;

export type DsrClaim = { state: "new"; record: DataSubjectRequestRow } | { state: "terminal" };

/**
 * Lock the request row and mark it `processing`. "terminal" means a duplicate job delivery found
 * the row already completed/failed -- the caller must skip work, not re-run it.
 */
export async function claimDsrRequest(
  tx: TransactionSql,
  schoolId: string,
  requestId: string,
): Promise<DsrClaim> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(ROW_COLUMNS)}
    FROM app.data_subject_requests
    WHERE id = ${requestId}::uuid AND school_id = ${schoolId}::uuid
    FOR UPDATE
  `;
  if (!row) throw new Error(`data subject request ${requestId} not found for school ${schoolId}`);

  const record = parseRow(row);
  if (record.status === "completed" || record.status === "failed") return { state: "terminal" };

  await tx`
    UPDATE app.data_subject_requests
    SET status = 'processing', started_at = COALESCE(started_at, clock_timestamp()), updated_at = clock_timestamp()
    WHERE id = ${requestId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return { state: "new", record };
}

export async function completeDsrExport(
  tx: TransactionSql,
  schoolId: string,
  requestId: string,
  storageKey: string,
): Promise<void> {
  await tx`
    UPDATE app.data_subject_requests
    SET status = 'completed', storage_key = ${storageKey}, completed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = ${requestId}::uuid AND school_id = ${schoolId}::uuid
  `;
}

export async function completeDsrErasure(
  tx: TransactionSql,
  schoolId: string,
  requestId: string,
  redactedTables: RedactedTableEntry[],
  retainedTables: RetainedTableEntry[],
): Promise<void> {
  await tx`
    UPDATE app.data_subject_requests
    SET status = 'completed', redacted_tables = ${tx.json(redactedTables as never)},
        retained_tables = ${tx.json(retainedTables as never)},
        completed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = ${requestId}::uuid AND school_id = ${schoolId}::uuid
  `;
}

/** Only called on the final BullMQ attempt -- earlier attempts leave the row `processing`. */
export async function failDsrRequest(
  tx: TransactionSql,
  schoolId: string,
  requestId: string,
  message: string,
): Promise<void> {
  await tx`
    UPDATE app.data_subject_requests
    SET status = 'failed', failure_message = ${message.slice(0, 1000)}, completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = ${requestId}::uuid AND school_id = ${schoolId}::uuid
      AND status IN ('queued', 'processing')
  `;
}

/** Creates a request row. Used by both the tenant-closure sweep and the per-user DSR API route. */
export async function createDsrRequest(
  tx: TransactionSql,
  input: {
    schoolId: string;
    requestType: DataSubjectRequestRow["requestType"];
    subjectScope: DataSubjectRequestRow["subjectScope"];
    reason: DataSubjectRequestRow["reason"];
    subjectUserId: string | null;
    requestedByUserId: string;
    /** GDPR Art. 12(3)'s one-month response deadline, from the caller's clock. */
    slaDueAt: Date;
  },
): Promise<DataSubjectRequestRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.data_subject_requests
      (school_id, request_type, subject_scope, reason, subject_user_id, requested_by_user_id, sla_due_at)
    VALUES (
      ${input.schoolId}::uuid, ${input.requestType}, ${input.subjectScope}, ${input.reason},
      ${input.subjectUserId}::uuid, ${input.requestedByUserId}::uuid, ${input.slaDueAt}
    )
    RETURNING ${tx.unsafe(ROW_COLUMNS)}
  `;
  if (!row) throw new Error("data subject request insert returned no row");
  return parseRow(row);
}

/** The most recent tenant-closure request of this type, whatever its status -- for the sweep's idempotency check. */
export async function findLatestTenantClosureRequest(
  tx: TransactionSql,
  schoolId: string,
  requestType: DataSubjectRequestRow["requestType"],
): Promise<DataSubjectRequestRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(ROW_COLUMNS)}
    FROM app.data_subject_requests
    WHERE school_id = ${schoolId}::uuid AND subject_scope = 'tenant' AND request_type = ${requestType}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ? parseRow(row) : undefined;
}
