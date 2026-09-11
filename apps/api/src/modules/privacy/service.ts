/**
 * Data subject request lifecycle rows (ST-268), the API-side half of app.data_subject_requests.
 *
 * A separate, small copy of the claim/create logic apps/workers/src/queues/maintenance/dsr-store.ts
 * has -- the API never processes a request (that's the maintenance queue's job), it only files one
 * and reports its status, which is a narrower surface than the worker-side store's claim/complete/
 * fail lifecycle. apps/api does not depend on apps/workers (same reason apps/workers ported its own
 * db/tenant-tx.ts rather than importing apps/api's), so this is the API's own thin read/write, not a
 * shared import.
 */

import type { TransactionSql } from "postgres";

export type DsrRequestType = "export" | "erasure";
export type DsrStatus = "queued" | "processing" | "completed" | "failed";

export interface DataSubjectRequestRow {
  id: string;
  requestType: DsrRequestType;
  subjectUserId: string;
  status: DsrStatus;
  storageKey: string | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  slaDueAt: Date;
}

const ROW_COLUMNS = `
  id, request_type::text AS request_type, subject_user_id, status::text AS status,
  storage_key, failure_message, created_at, completed_at, sla_due_at
`;

function parseRow(row: Record<string, unknown>): DataSubjectRequestRow {
  return {
    id: row.id as string,
    requestType: row.request_type as DsrRequestType,
    subjectUserId: row.subject_user_id as string,
    status: row.status as DsrStatus,
    storageKey: row.storage_key as string | null,
    failureMessage: row.failure_message as string | null,
    createdAt: row.created_at as Date,
    completedAt: row.completed_at as Date | null,
    slaDueAt: row.sla_due_at as Date,
  };
}

/** True when the subject user id belongs to this school -- checked before filing a request about them. */
export async function subjectExists(
  tx: TransactionSql,
  schoolId: string,
  subjectUserId: string,
): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM app.users WHERE id = ${subjectUserId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return rows.length > 0;
}

/** An open (queued/processing) request of this type for this subject, if one already exists. */
export async function findOpenDsrRequest(
  tx: TransactionSql,
  schoolId: string,
  subjectUserId: string,
  requestType: DsrRequestType,
): Promise<DataSubjectRequestRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(ROW_COLUMNS)}
    FROM app.data_subject_requests
    WHERE school_id = ${schoolId}::uuid
      AND subject_user_id = ${subjectUserId}::uuid
      AND request_type = ${requestType}
      AND status IN ('queued', 'processing')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ? parseRow(row) : undefined;
}

export async function createDsrRequest(
  tx: TransactionSql,
  schoolId: string,
  requestedByUserId: string,
  subjectUserId: string,
  requestType: DsrRequestType,
): Promise<DataSubjectRequestRow> {
  const [row] = await tx<Record<string, unknown>[]>`
    INSERT INTO app.data_subject_requests
      (school_id, request_type, subject_scope, reason, subject_user_id, requested_by_user_id, sla_due_at)
    VALUES (
      ${schoolId}::uuid, ${requestType}, 'user', 'user_request', ${subjectUserId}::uuid,
      ${requestedByUserId}::uuid, CURRENT_TIMESTAMP + interval '30 days'
    )
    RETURNING ${tx.unsafe(ROW_COLUMNS)}
  `;
  if (!row) throw new Error("data subject request insert returned no row");
  return parseRow(row);
}

export async function getDsrRequest(
  tx: TransactionSql,
  schoolId: string,
  requestId: string,
): Promise<DataSubjectRequestRow | undefined> {
  const [row] = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(ROW_COLUMNS)}
    FROM app.data_subject_requests
    WHERE id = ${requestId}::uuid AND school_id = ${schoolId}::uuid
  `;
  return row ? parseRow(row) : undefined;
}
