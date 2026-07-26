import { createHash, randomBytes } from "node:crypto";

import postgres from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BulkInviteJobData {
  bulkInviteId: string;
  schoolId: string;
}

interface BulkInviteRecipient {
  id: string;
  email: string;
  normalized_email: string;
  status: string;
}

const BATCH_SIZE = 100;

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
 */
export async function processBulkInvite(
  data: BulkInviteJobData,
  databaseUrl: string,
): Promise<{ sent: number; failed: number }> {
  const sql = postgres(databaseUrl, { max: 4, idle_timeout: 20, prepare: false });

  try {
    // Mark as processing.
    await sql`
      UPDATE app.bulk_invites
      SET status = 'processing'::app.bulk_invite_status, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}
    `;

    // Fetch batch metadata for expiry_days and role.
    const [batch] = await sql<{ role: string; expiry_days: number; created_by: string }[]>`
      SELECT role, expiry_days, created_by
      FROM app.bulk_invites
      WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}
    `;

    if (!batch) {
      throw new Error(`Bulk invite ${data.bulkInviteId} not found`);
    }

    const expiresAtMs = Date.now() + batch.expiry_days * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();

    let sent = 0;
    let failed = 0;

    // Process pending recipients in batches.
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

      if (batchResult.processed < BATCH_SIZE) break;
    }

    // Update the batch summary and mark completed.
    await sql`
      UPDATE app.bulk_invites
      SET status = 'completed'::app.bulk_invite_status,
          sent_count = ${sent},
          failed_count = ${failed},
          completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}
    `;

    return { sent, failed };
  } catch (error) {
    // Mark as failed.
    await sql`
      UPDATE app.bulk_invites
      SET status = 'failed'::app.bulk_invite_status, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${data.bulkInviteId}::uuid AND school_id = ${data.schoolId}
    `.catch(() => {
      // Best-effort status update on failure; ignore errors from the status write itself.
    });

    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

async function processRecipientBatch(
  sql: postgres.Sql,
  schoolId: string,
  bulkInviteId: string,
  role: string,
  createdBy: string,
  expiresAt: string,
): Promise<{ sent: number; failed: number; processed: number }> {
  // Fetch a page of pending recipients.
  const recipients = await sql<BulkInviteRecipient[]>`
    SELECT id, email, normalized_email, status
    FROM app.bulk_invite_recipients
    WHERE bulk_invite_id = ${bulkInviteId}::uuid
      AND school_id = ${schoolId}
      AND status = 'pending'::app.bulk_invite_recipient_status
    ORDER BY created_at ASC
    LIMIT ${BATCH_SIZE}
  `;

  if (recipients.length === 0) {
    return { sent: 0, failed: 0, processed: 0 };
  }

  let sent = 0;
  let failed = 0;

  // Process each recipient in its own transaction.
  for (const recipient of recipients) {
    try {
      await sql.begin(async (tx) => {
        await tx`
          SELECT set_config('role', 'studafy_app', true),
                 set_config('app.school_id', ${schoolId}, true)
        `;

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
          ON CONFLICT (school_id, normalized_email, role) DO NOTHING
          RETURNING id
        `;

        if (!invitation) {
          // Duplicate active invitation exists — mark as sent (already covered).
          await tx`
            UPDATE app.bulk_invite_recipients
            SET status = 'sent'::app.bulk_invite_recipient_status,
                error_message = 'duplicate active invitation',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ${recipient.id}::uuid
          `;
          sent++;
          return;
        }

        // Emit outbox event for downstream email dispatch.
        const payload = JSON.stringify({
          invitationId: invitation.id,
          email: recipient.email,
          role,
          expiresAt,
          invitedByUserId: createdBy,
        });

        await tx`
          INSERT INTO app.outbox_events (school_id, event_name, payload)
          VALUES (${schoolId}::uuid, 'invitation.sent', ${payload}::jsonb)
        `;

        // Mark recipient as sent with the invitation ID.
        await tx`
          UPDATE app.bulk_invite_recipients
          SET status = 'sent'::app.bulk_invite_recipient_status,
              invitation_id = ${invitation.id}::uuid,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${recipient.id}::uuid
        `;

        sent++;
      });
    } catch (error) {
      // Mark recipient as failed with error message.
      const message = error instanceof Error ? error.message : "unknown error";
      await sql`
        UPDATE app.bulk_invite_recipients
        SET status = 'failed'::app.bulk_invite_recipient_status,
            error_message = ${message},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${recipient.id}::uuid
      `.catch(() => {
        // Best-effort status update on failure; ignore errors from the status write itself.
      });
      failed++;
    }
  }

  return { sent, failed, processed: recipients.length };
}
