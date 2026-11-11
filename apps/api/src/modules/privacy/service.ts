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
  /** Set once the data retention sweep deleted the stored export bundle (000189). */
  exportDeletedAt: Date | null;
  failureMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
  slaDueAt: Date;
}

const ROW_COLUMNS = `
  id, request_type::text AS request_type, subject_user_id, status::text AS status,
  storage_key, export_deleted_at, failure_message, created_at, completed_at, sla_due_at
`;

function parseRow(row: Record<string, unknown>): DataSubjectRequestRow {
  return {
    id: row.id as string,
    requestType: row.request_type as DsrRequestType,
    subjectUserId: row.subject_user_id as string,
    status: row.status as DsrStatus,
    storageKey: row.storage_key as string | null,
    exportDeletedAt: row.export_deleted_at as Date | null,
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

/**
 * A subject's own request history, most recent first -- the self-service read
 * (`GET /api/privacy/dsr/me`) that lets a caller check whether they already have a request in
 * flight without needing to have kept the id from when they filed it.
 */
export async function listDsrRequestsForSubject(
  tx: TransactionSql,
  schoolId: string,
  subjectUserId: string,
): Promise<DataSubjectRequestRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT ${tx.unsafe(ROW_COLUMNS)}
    FROM app.data_subject_requests
    WHERE school_id = ${schoolId}::uuid AND subject_user_id = ${subjectUserId}::uuid
    ORDER BY created_at DESC
    LIMIT 20
  `;
  return rows.map(parseRow);
}

export interface SchoolDataSubjectRequestRow extends DataSubjectRequestRow {
  subjectDisplayName: string | null;
}

/**
 * The school's per-person requests, most recent first -- the admin's view of every export and
 * erasure filed,
 * by them or by the subject, so a request filed last week can be followed up without its id. The
 * subject's display name rides along for the list; an erased subject's name is already gone.
 */
export async function listDsrRequestsForSchool(
  tx: TransactionSql,
  schoolId: string,
  options: { subjectUserId?: string; limit: number },
): Promise<SchoolDataSubjectRequestRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    SELECT
      dsr.id, dsr.request_type::text AS request_type, dsr.subject_user_id,
      dsr.status::text AS status, dsr.storage_key, dsr.failure_message, dsr.created_at,
      dsr.completed_at, dsr.sla_due_at, u.display_name AS subject_display_name
    FROM app.data_subject_requests AS dsr
    LEFT JOIN app.users AS u ON u.id = dsr.subject_user_id AND u.school_id = dsr.school_id
    WHERE dsr.school_id = ${schoolId}::uuid
      -- A school closure's whole-tenant request has no subject; it is the platform's, not this list's.
      AND dsr.subject_scope = 'user'
      ${options.subjectUserId ? tx`AND dsr.subject_user_id = ${options.subjectUserId}::uuid` : tx``}
    ORDER BY dsr.created_at DESC
    LIMIT ${options.limit}
  `;
  return rows.map((row) => ({
    ...parseRow(row),
    subjectDisplayName: (row.subject_display_name as string | null) ?? null,
  }));
}
