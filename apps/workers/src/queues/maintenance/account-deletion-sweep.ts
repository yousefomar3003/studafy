/**
 * The account-deletion sweep (000143): the scheduled job that runs every self-service deletion
 * whose 14-day grace period has ended. Scheduling (and cancelling) is apps/api's
 * account-deletion-service.ts; this is the half that used to run inside the deletion request.
 *
 * Per due account, one transaction:
 *   - stop AI add-on billing (Stripe: cancel at period end; Tap: drop the saved card so the
 *     renewal worker has nothing to charge),
 *   - detach from the school: status `archived`, roles, sign-in identities and parent links
 *     removed — with no oauth_identities row and no roles, no login or refresh can succeed,
 *   - revoke any session still open (one signed in during the grace period to cancel, say),
 *   - file the erasure request, write the audit entry and the ACCOUNT_DELETED event (the
 *     confirmation email), then enqueue the erasure job after commit.
 *
 * Sign in with Apple token revocation belongs in this transaction too, before the identities are
 * removed, once Studafy offers SIWA (apps/api/src/modules/account/apple-token-revoker.ts).
 *
 * Idempotent: a run account is archived and drops out of the due set. A failure rolls that
 * account back and leaves it due for the next run; it does not strand the accounts after it.
 * An enqueue failure after commit leaves a `queued` request the DSR pipeline's own retries
 * don't see — logged loudly so it can be re-enqueued.
 */

import { DOMAIN_EVENTS } from "@studafy/constants";

import { emitAuditLog } from "../../db/audit";
import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import { createDsrRequest } from "./dsr-store";

import type { EnqueueDsrJob } from "./closure-sweep";
import type { BillingLogger } from "@studafy/billing";
import type { Sql, TransactionSql } from "postgres";

/** GDPR Art. 12(3)'s one-month response deadline, from the moment the erasure is filed. */
const ERASURE_SLA_DAYS = 30;
const MILLIS_PER_DAY = 86_400_000;

/** Ends Stripe billing for one AI add-on subscription at the end of its current period. */
export interface AiBillingCanceller {
  cancelStripeSubscriptionAtPeriodEnd(subscriptionId: string): Promise<void>;
}

export interface AccountDeletionSweepResult {
  accountsDeleted: number;
  failures: number;
}

export async function runAccountDeletionSweep(
  sql: Sql,
  now: Date,
  billing: AiBillingCanceller | null,
  enqueue: EnqueueDsrJob,
  log: BillingLogger,
): Promise<AccountDeletionSweepResult> {
  const result: AccountDeletionSweepResult = { accountsDeleted: 0, failures: 0 };

  for (const schoolId of await loadSchoolIds(sql)) {
    const due = await withSystemTenantTx(sql, { schoolId }, (tx) => loadDueUserIds(tx, now));
    for (const userId of due) {
      try {
        const requestId = await withSystemTenantTx(sql, { schoolId }, (tx) =>
          runDeletion(tx, schoolId, userId, now, billing),
        );
        if (!requestId) continue;
        result.accountsDeleted += 1;
        try {
          await enqueue({ schoolId, requestId, kind: "erasure" });
        } catch (error) {
          log.warn(
            { err: error, school_id: schoolId, request_id: requestId },
            "account deleted but its erasure job could not be enqueued; re-enqueue the request",
          );
        }
      } catch (error) {
        result.failures += 1;
        log.warn(
          { err: error, school_id: schoolId, user_id: userId },
          "scheduled account deletion failed; it stays due for the next run",
        );
      }
    }
  }

  log.info({ ...result }, "account deletion sweep complete");
  return result;
}

async function loadDueUserIds(tx: TransactionSql, now: Date): Promise<string[]> {
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM app.users
    WHERE school_id = current_setting('app.school_id')::uuid
      AND deletion_due_at <= ${now}
      AND status <> 'archived'
    ORDER BY deletion_due_at
  `;
  return rows.map((row) => row.id);
}

/** Runs one due deletion; returns the erasure request id, or null if it was cancelled meanwhile. */
async function runDeletion(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  now: Date,
  billing: AiBillingCanceller | null,
): Promise<string | null> {
  // Re-checked under the row lock: a cancellation may have landed since the due set was read.
  const [user] = await tx<{ email: string | null; status: string; deletion_requested_at: Date }[]>`
    SELECT email, status::text AS status, deletion_requested_at FROM app.users
    WHERE id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
      AND deletion_due_at <= ${now} AND status <> 'archived'
    FOR UPDATE
  `;
  if (!user) return null;

  const aiSubscriptionsCanceled = await cancelAiSubscriptions(tx, billing, userId);

  await tx`
    UPDATE app.users
    SET status = 'archived'::app.user_status, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  await tx`
    DELETE FROM app.parent_child_links
    WHERE parent_user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  await tx`
    DELETE FROM app.oauth_identities
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  await tx`
    DELETE FROM app.user_roles
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
  `;
  await tx`
    UPDATE app.refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
    WHERE user_id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
      AND revoked_at IS NULL
  `;

  const request = await createDsrRequest(tx, {
    schoolId,
    requestType: "erasure",
    subjectScope: "user",
    reason: "user_request",
    subjectUserId: userId,
    requestedByUserId: userId,
    slaDueAt: new Date(now.getTime() + ERASURE_SLA_DAYS * MILLIS_PER_DAY),
  });

  // `update`, not `delete`: the row is archived, not removed (ck_audit_logs_payload also forbids
  // new values on a delete).
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "users",
    targetId: userId,
    oldValues: { status: user.status },
    newValues: {
      reason: "account_deletion",
      status: "archived",
      deletion_requested_at: user.deletion_requested_at.toISOString(),
      data_subject_request_id: request.id,
      erasure_due_at: request.slaDueAt.toISOString(),
      ai_subscriptions_canceled: aiSubscriptionsCanceled,
    },
  });

  // Shape must match eventPayloadSchemas[ACCOUNT_DELETED] in apps/api/src/lib/events/schemas.ts.
  // Member-ID-only accounts have no address to send the confirmation to.
  if (user.email) {
    await tx`
      INSERT INTO app.outbox_events (school_id, event_name, payload)
      VALUES (
        ${schoolId}::uuid,
        ${DOMAIN_EVENTS.ACCOUNT_DELETED},
        ${tx.json({ userId, email: user.email, completesBy: request.slaDueAt.toISOString() })}
      )
    `;
  }

  return request.id;
}

/**
 * Stops every live AI add-on subscription billed for this user's student record. A parent or staff
 * account has no app.students row and matches nothing. The rows themselves stay (financial legal
 * hold); only future billing stops. Same rules as the API's former in-request deletion.
 */
async function cancelAiSubscriptions(
  tx: TransactionSql,
  billing: AiBillingCanceller | null,
  userId: string,
): Promise<number> {
  const rows = await tx<
    { id: string; stripe_subscription_id: string | null; tap_billed: boolean }[]
  >`
    SELECT a.id, a.stripe_subscription_id, a.tap_card_id IS NOT NULL AS tap_billed
    FROM app.ai_subscriptions AS a
    JOIN app.students AS s ON s.id = a.student_id AND s.school_id = a.school_id
    WHERE s.user_id = ${userId}::uuid
      AND a.status NOT IN ('canceled', 'expired', 'closed')
    FOR UPDATE OF a
  `;

  let canceled = 0;
  for (const row of rows) {
    if (row.stripe_subscription_id) {
      // Throwing rolls this account back: better to retry tomorrow than detach someone Stripe
      // keeps charging.
      if (!billing) throw new Error("Stripe is not configured; cannot stop AI add-on billing");
      await billing.cancelStripeSubscriptionAtPeriodEnd(row.stripe_subscription_id);
      canceled += 1;
    } else if (row.tap_billed) {
      // Tap subscriptions are renewed by Studafy's own worker, which only charges rows with a saved
      // card (../billing/tap-renewal.ts). Both columns go together (ck_ai_subscriptions_tap_saved_card).
      await tx`
        UPDATE app.ai_subscriptions
        SET tap_card_id = NULL, tap_payment_agreement_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${row.id}::uuid
      `;
      canceled += 1;
    }
  }
  return canceled;
}
