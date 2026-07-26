import { HTTPException } from "hono/http-exception";

import type { BulkInviteStatus, BulkInviteRecipientStatus } from "./schemas";
import type { Role } from "@studafy/constants";
import type { JSONValue, TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BulkInviteRecord {
  id: string;
  school_id: string;
  created_by: string;
  status: BulkInviteStatus;
  role: Role;
  expiry_days: number;
  target_mode: string;
  target_ref: string | null;
  total_count: number;
  sent_count: number;
  failed_count: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface BulkInviteRecipientRecord {
  id: string;
  bulk_invite_id: string;
  school_id: string;
  email: string;
  normalized_email: string;
  status: BulkInviteRecipientStatus;
  invitation_id: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RecipientInput {
  email: string;
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Create a bulk invitation batch. Inserts the bulk_invites record and all recipients
 * in pending state. Returns the batch for immediate queue dispatch.
 */
export async function createBulkInvite(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  params: { role: Role; expiryDays?: number; recipients: RecipientInput[] },
): Promise<BulkInviteRecord> {
  const expiryDays = params.expiryDays ?? 7;
  const normalizedRecipients = params.recipients.map((r) => ({
    email: r.email,
    normalizedEmail: r.email.toLowerCase().trim(),
  }));

  // Deduplicate by normalized email within this request.
  const seen = new Set<string>();
  const unique = normalizedRecipients.filter((r) => {
    if (seen.has(r.normalizedEmail)) return false;
    seen.add(r.normalizedEmail);
    return true;
  });

  if (unique.length === 0) {
    throw new HTTPException(400, { message: "All recipient emails are duplicates." });
  }

  // Insert the batch.
  const [batch] = await tx<BulkInviteRecord[]>`
    INSERT INTO app.bulk_invites (
      school_id, created_by, role, expiry_days,
      target_mode, total_count
    ) VALUES (
      ${schoolId},
      ${userId},
      ${params.role}::app.user_role,
      ${expiryDays},
      'explicit',
      ${unique.length}
    )
    RETURNING id, school_id, created_by, status, role, expiry_days,
              target_mode, target_ref, total_count, sent_count, failed_count,
              created_at, updated_at, completed_at
  `;

  if (!batch) {
    throw new HTTPException(500, { message: "Failed to create bulk invite." });
  }

  // Insert recipients in batches of 100.
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    await tx`
      INSERT INTO app.bulk_invite_recipients (bulk_invite_id, school_id, email, normalized_email)
      SELECT ${batch.id}::uuid, ${schoolId}, value->>'email', LOWER(TRIM(value->>'email'))
      FROM jsonb_array_elements(${tx.json(chunk as unknown as JSONValue)}::jsonb) AS value
    `;
  }

  return batch;
}

/**
 * Get a single bulk invite batch by ID.
 */
export async function getBulkInvite(
  tx: TransactionSql,
  schoolId: string,
  bulkInviteId: string,
): Promise<BulkInviteRecord> {
  const [record] = await tx<BulkInviteRecord[]>`
    SELECT id, school_id, created_by, status, role, expiry_days,
           target_mode, target_ref, total_count, sent_count, failed_count,
           created_at, updated_at, completed_at
    FROM app.bulk_invites
    WHERE id = ${bulkInviteId}::uuid AND school_id = ${schoolId}
  `;

  if (!record) {
    throw new HTTPException(404, { message: "Bulk invite not found." });
  }

  return record;
}

/**
 * List bulk invite batches with cursor-based pagination.
 */
export async function listBulkInvites(
  tx: TransactionSql,
  schoolId: string,
  params: { limit: number; cursor?: string },
): Promise<{ rows: BulkInviteRecord[]; next_cursor: string | null }> {
  const limit = params.limit + 1;

  const cursorFilter = params.cursor
    ? (() => {
        const sep = params.cursor.lastIndexOf(":");
        const createdAt = params.cursor.slice(0, sep);
        const id = params.cursor.slice(sep + 1);
        return tx` AND (created_at, id) < (${createdAt}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const rows = await tx<BulkInviteRecord[]>`
    SELECT id, school_id, created_by, status, role, expiry_days,
           target_mode, target_ref, total_count, sent_count, failed_count,
           created_at, updated_at, completed_at
    FROM app.bulk_invites
    WHERE school_id = ${schoolId}
      ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = sliced[sliced.length - 1];
  const next_cursor =
    hasMore && lastRow ? `${lastRow.created_at.toISOString()}:${lastRow.id}` : null;

  return { rows: sliced, next_cursor };
}

/**
 * List recipients for a bulk invite with cursor-based pagination and optional status filter.
 */
export async function getBulkInviteRecipients(
  tx: TransactionSql,
  schoolId: string,
  bulkInviteId: string,
  params: { limit: number; cursor?: string; status?: BulkInviteRecipientStatus },
): Promise<{ rows: BulkInviteRecipientRecord[]; next_cursor: string | null }> {
  // Verify the bulk invite exists.
  await getBulkInvite(tx, schoolId, bulkInviteId);

  const statusFilter = params.status
    ? tx` AND status = ${params.status}::app.bulk_invite_recipient_status`
    : tx``;

  const limit = params.limit + 1;

  const cursorFilter = params.cursor
    ? (() => {
        const sep = params.cursor.lastIndexOf(":");
        const createdAt = params.cursor.slice(0, sep);
        const id = params.cursor.slice(sep + 1);
        return tx` AND (created_at, id) < (${createdAt}::timestamptz, ${id}::uuid)`;
      })()
    : tx``;

  const rows = await tx<BulkInviteRecipientRecord[]>`
    SELECT id, bulk_invite_id, school_id, email, normalized_email,
           status, invitation_id, error_message, created_at, updated_at
    FROM app.bulk_invite_recipients
    WHERE bulk_invite_id = ${bulkInviteId}::uuid
      AND school_id = ${schoolId}
      ${statusFilter}
      ${cursorFilter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;

  const hasMore = rows.length > limit;
  const sliced = hasMore ? rows.slice(0, params.limit) : rows;
  const lastRow = sliced[sliced.length - 1];
  const next_cursor =
    hasMore && lastRow ? `${lastRow.created_at.toISOString()}:${lastRow.id}` : null;

  return { rows: sliced, next_cursor };
}

/**
 * Reset failed recipients back to pending for retry. Returns the bulk invite
 * so the caller can dispatch a new job.
 */
export async function resetFailedRecipients(
  tx: TransactionSql,
  schoolId: string,
  bulkInviteId: string,
): Promise<BulkInviteRecord> {
  const batch = await getBulkInvite(tx, schoolId, bulkInviteId);

  if (batch.status === "processing") {
    throw new HTTPException(409, { message: "Bulk invite is currently processing." });
  }

  const reset = await tx<{ changed: boolean }[]>`
    UPDATE app.bulk_invite_recipients
    SET status = 'pending'::app.bulk_invite_recipient_status,
        error_message = NULL,
        invitation_id = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE bulk_invite_id = ${bulkInviteId}::uuid
      AND school_id = ${schoolId}
      AND status = 'failed'::app.bulk_invite_recipient_status
  `;

  if (reset.count === 0) {
    throw new HTTPException(400, { message: "No failed recipients to retry." });
  }

  // Recount and reset the batch.
  const [updated] = await tx<BulkInviteRecord[]>`
    UPDATE app.bulk_invites
    SET status = 'pending'::app.bulk_invite_status,
        sent_count = (
          SELECT COUNT(*) FROM app.bulk_invite_recipients
          WHERE bulk_invite_id = ${bulkInviteId}::uuid AND status = 'sent'
        ),
        failed_count = 0,
        updated_at = CURRENT_TIMESTAMP,
        completed_at = NULL
    WHERE id = ${bulkInviteId}::uuid AND school_id = ${schoolId}
    RETURNING id, school_id, created_by, status, role, expiry_days,
              target_mode, target_ref, total_count, sent_count, failed_count,
              created_at, updated_at, completed_at
  `;

  return updated!;
}
