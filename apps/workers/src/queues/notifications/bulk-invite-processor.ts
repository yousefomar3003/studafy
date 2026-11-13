import { createHash, randomBytes } from "node:crypto";

import { leaseDatabase } from "../../db/pool";
import { withSystemTenantTx, withTenantTx } from "../../db/tenant-tx";

import type { DatabaseSource } from "../../db/pool";
import type { Sql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BulkInviteJobData {
  bulkInviteId: string;
  schoolId: string;
}

interface BulkInviteRecipient {
  id: string;
  email: string;
  normalized_email: string;
  status: string;
}

export const BULK_INVITE_BATCH_SIZE = 100;

/**
 * Thrown when a page of pending recipients was processed but not one of them left `pending` -- the
 * invitation insert failed and so did the write marking the recipient failed. Re-reading the page
 * would return the same rows forever, so the run stops here and the batch is marked failed.
 */
export class BulkInviteStalledError extends Error {
  constructor(bulkInviteId: string, pending: number) {
    super(
      `bulk invite ${bulkInviteId} made no progress: ${String(pending)} pending recipient(s) could not be sent or marked failed`,
    );
    this.name = "BulkInviteStalledError";
  }
}

// ---------------------------------------------------------------------------
// Token helpers (mirrors apps/api invitation service)
// ---------------------------------------------------------------------------

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/**
 * Process a bulk invitation job.
 *
 * Called by the BullMQ NOTIFICATIONS worker. Reads pending recipients from
 * bulk_invite_recipients, creates individual invitations (token + hash + outbox event)
 * for each, and tracks per-recipient status.
 *
 * Idempotency: only processes recipients in 'pending' status; re-running a partially
 * completed batch picks up where it left off.
 *
 * Every read and every status write runs in a system tenant transaction (`withSystemTenantTx`):
 * both tables are RLS-forced, and a statement outside one sees zero rows -- which used to make the
 * mark-failed UPDATE silently match nothing and the batch loop re-read the same page forever. A page
 * on which no recipient leaves `pending` now stops the run (`BulkInviteStalledError`).
 *
 * `database` is the process-wide pool in production, a connection string in tests (db/pool.ts).
 */
export async function processBulkInvite(
  data: BulkInviteJobData,
  database: DatabaseSource,
): Promise<{ sent: number; failed: number }> {
  const lease = leaseDatabase(database);
  const sql = lease.sql;
  const tenant = { schoolId: data.schoolId };

  try {
    // Mark as processing and fetch batch metadata for expiry_days and role.
    const batch = await withSystemTenantTx(sql, tenant, async (tx) => {
      await tx`
        UPDATE app.bulk_invites
        SET status = 'processing'::app.bulk_invite_status, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}::uuid
      `;
      const [row] = await tx<{ role: string; expiry_days: number; created_by: string }[]>`
        SELECT role, expiry_days, created_by
        FROM app.bulk_invites
        WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}::uuid
      `;
      return row;
    });

    if (!batch) {
      throw new Error(`Bulk invite ${data.bulkInviteId} not found`);
    }

    const expiresAtMs = Date.now() + batch.expiry_days * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();

    let sent = 0;
    let failed = 0;

    // Process pending recipients in pages. Every page either moves at least one recipient out of
    // `pending` or stops the run, so the loop is bounded by the number of recipients.
    while (true) {
      const batchResult = await processRecipientBatch(
        sql,
        data.schoolId,
        data.bulkInviteId,
        batch.role,
        batch.created_by,
        expiresAt,
      );

      sent += batchResult.sent;
      failed += batchResult.failed;

      if (batchResult.processed > 0 && batchResult.progressed === 0) {
        throw new BulkInviteStalledError(data.bulkInviteId, batchResult.processed);
      }
      if (batchResult.processed < BULK_INVITE_BATCH_SIZE) break;
    }

    // Update the batch summary and mark completed.
    await withSystemTenantTx(sql, tenant, async (tx) => {
      await tx`
        UPDATE app.bulk_invites
        SET status = 'completed'::app.bulk_invite_status,
            sent_count = ${sent},
            failed_count = ${failed},
            completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}::uuid
      `;
    });

    return { sent, failed };
  } catch (error) {
    // Mark as failed. Best-effort: an error from the status write itself is ignored so the
    // original error is what BullMQ sees.
    await withSystemTenantTx(sql, tenant, async (tx) => {
      await tx`
        UPDATE app.bulk_invites
        SET status = 'failed'::app.bulk_invite_status, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}::uuid
      `;
    }).catch(() => undefined);

    throw error;
  } finally {
    await lease.release();
  }
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

interface RecipientBatchResult {
  sent: number;
  failed: number;
  /** Recipients read on this page. */
  processed: number;
  /** Recipients this page actually moved out of `pending` (sent, or marked failed). */
  progressed: number;
}

async function processRecipientBatch(
  sql: Sql,
  schoolId: string,
  bulkInviteId: string,
  role: string,
  createdBy: string,
  expiresAt: string,
): Promise<RecipientBatchResult> {
  // Fetch a page of pending recipients.
  const recipients = await withSystemTenantTx(
    sql,
    { schoolId },
    (tx) => tx<BulkInviteRecipient[]>`
      SELECT id, email, normalized_email, status
      FROM app.bulk_invite_recipients
      WHERE bulk_invite_id = ${bulkInviteId}::uuid
        AND school_id = ${schoolId}::uuid
        AND status = 'pending'::app.bulk_invite_recipient_status
      ORDER BY created_at ASC
      LIMIT ${BULK_INVITE_BATCH_SIZE}
    `,
  );

  if (recipients.length === 0) {
    return { sent: 0, failed: 0, processed: 0, progressed: 0 };
  }

  let sent = 0;
  let failed = 0;
  let progressed = 0;

  // Process each recipient in its own transaction.
  for (const recipient of recipients) {
    try {
      const updated = await withTenantTx(sql, { schoolId }, async (tx) => {
        const token = generateToken();
        const tokenHash = hashToken(token);

        // Create the individual invitation.
        const [invitation] = await tx<{ id: string }[]>`
          INSERT INTO app.invitations (
            school_id, email, normalized_email, role,
            token_hash, invited_by_user_id, expires_at
          ) VALUES (
            ${schoolId},
            ${recipient.email},
            ${recipient.normalized_email},
            ${role}::app.user_role,
            ${tokenHash}::bytea,
            ${createdBy}::uuid,
            ${expiresAt}::timestamptz
          )
          -- The predicate must match uq_invitations_active's, or Postgres finds no arbiter index
          -- and every insert fails ("no unique or exclusion constraint matching").
          ON CONFLICT (school_id, normalized_email, role)
            WHERE revoked_at IS NULL AND consumed_at IS NULL
            DO NOTHING
          RETURNING id
        `;

        if (!invitation) {
          // Duplicate active invitation exists — mark as sent (already covered).
          const duplicate = await tx`
            UPDATE app.bulk_invite_recipients
            SET status = 'sent'::app.bulk_invite_recipient_status,
                error_message = 'duplicate active invitation',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ${recipient.id}::uuid
          `;
          return duplicate.count;
        }

        // Emit outbox event for downstream email dispatch. Carries the raw token, exactly as the
        // API's single invitation does (apps/api/src/lib/events/schemas.ts INVITATION_SENT): the
        // email dispatcher builds the accept link from it, and the hash alone cannot. tx.json(),
        // not JSON.stringify() + ::jsonb, which stores a JSON *string* the dispatcher cannot read
        // (see billing/entitlement-change-publisher.ts).
        const payload = tx.json({
          invitationId: invitation.id,
          email: recipient.email,
          role,
          expiresAt,
          invitedByUserId: createdBy,
          token,
        });

        await tx`
          INSERT INTO app.outbox_events (school_id, event_name, payload)
          VALUES (${schoolId}::uuid, 'invitation.sent', ${payload})
        `;

        // Mark recipient as sent with the invitation ID.
        const marked = await tx`
          UPDATE app.bulk_invite_recipients
          SET status = 'sent'::app.bulk_invite_recipient_status,
              invitation_id = ${invitation.id}::uuid,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${recipient.id}::uuid
        `;
        return marked.count;
      });
      // Counted only once the transaction has committed.
      sent++;
      if (updated > 0) progressed++;
    } catch (error) {
      // Mark recipient as failed with error message. Best-effort, but whether it matched a row is
      // what tells the caller this page made progress.
      const message = error instanceof Error ? error.message : "unknown error";
      const marked = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const result = await tx`
          UPDATE app.bulk_invite_recipients
          SET status = 'failed'::app.bulk_invite_recipient_status,
              error_message = ${message},
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${recipient.id}::uuid
            AND school_id = ${schoolId}::uuid
            AND status = 'pending'::app.bulk_invite_recipient_status
        `;
        return result.count;
      }).catch(() => 0);
      failed++;
      if (marked > 0) progressed++;
    }
  }

  return { sent, failed, processed: recipients.length, progressed };
}
