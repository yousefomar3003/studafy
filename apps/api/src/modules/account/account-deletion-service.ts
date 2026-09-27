/**
 * Self-service account deletion (App Store 5.1.1(v), Google Play data deletion).
 *
 * Two phases, because they have different deadlines:
 *
 * 1. Immediately, in one transaction — everything that ends the person's relationship with the
 *    school and with billing:
 *      - revoke Sign in with Apple tokens (while the identities that locate them still exist),
 *      - stop AI add-on billing (Stripe: cancel at period end; Tap: drop the saved card so the
 *        renewal worker has nothing to charge),
 *      - detach from the school: status `archived`, roles, sign-in identities and parent links
 *        removed — with no oauth_identities row, no login path can resolve this account again,
 *      - file the erasure request, write the audit entry and queue the confirmation email,
 *      - enqueue the erasure job, last, so a queue failure rolls all of the above back and the
 *      still-signed-in user can simply retry.
 *    Then, after commit, every session is revoked and its access tokens denylisted.
 *
 * 2. Within the request's SLA — the maintenance worker's erasure pass (ST-268) redacts or deletes
 *    personal data across the tenant's tables, keeping only what retention-policy.ts lists.
 *
 * Enqueue-inside-the-transaction means the worker can pick the job up before the commit is
 * visible. It then fails to find the row, throws, and BullMQ retries with backoff
 * (privacy/dsr-queue.ts) — by which point the row exists. If the commit itself fails, the orphan job
 * exhausts its retries against a row that never existed and changes nothing.
 */

import { DOMAIN_EVENTS, ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { emit } from "../../lib/events/emitter";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { REVOCATION_REASONS, revokeAndDenylist } from "../auth/services/revocation-service";
import { addDsrJob } from "../privacy/dsr-queue";
import { createDsrRequest, findOpenDsrRequest } from "../privacy/service";
import { requirePaymentProvider } from "../subscriptions/payment-provider-routing";

import { RETAINED_RECORD_CATEGORIES } from "./retention-policy";

import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { JtiDenylist } from "../auth/denylist";
import type { DataSubjectRequestRow } from "../privacy/service";
import type { PaymentProviderRegistry } from "../subscriptions/payment-provider-routing";
import type { Queue } from "bullmq";
import type { TransactionSql } from "postgres";

/**
 * Revokes every Sign in with Apple token Studafy holds for a user. Runs inside the deletion
 * transaction, before the user's identities are removed; throwing rolls the deletion back.
 * No implementation exists yet — see apple-token-revoker.ts's status note.
 */
export interface SiwaTokenRevocation {
  revokeUserTokens(tx: TransactionSql, userId: string): Promise<number>;
}

export interface AccountDeletionDeps {
  database: Database;
  denylist: JtiDenylist | null;
  paymentProviders: PaymentProviderRegistry;
  maintenanceQueue: Queue;
  siwa: SiwaTokenRevocation | null;
}

/** Where the deletion was asked for. Recorded on the audit entry. */
export type AccountDeletionSource = "account_settings" | "web_request";

export interface AccountDeletionParams {
  schoolId: string;
  userId: string;
  /** Defaults to "account_settings", the signed-in path. */
  source?: AccountDeletionSource;
  requestId?: string;
  log?: Logger;
  userAgent?: string | null;
  clientIp?: string | null;
}

export interface AccountDeletionResult {
  request: DataSubjectRequestRow;
  aiSubscriptionsCanceled: number;
  siwaTokensRevoked: number;
  sessionsRevoked: number;
}

export async function deleteAccount(
  deps: AccountDeletionDeps,
  params: AccountDeletionParams,
): Promise<AccountDeletionResult> {
  const { schoolId, userId } = params;
  const tenant = { schoolId, userId, requestId: params.requestId };

  const { request, aiSubscriptionsCanceled, siwaTokensRevoked } = await withTenantTx(
    deps.database,
    tenant,
    async (tx) => {
      if (await findOpenDsrRequest(tx, schoolId, userId, "erasure")) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.DSR_ALREADY_PENDING,
          "A deletion request is already queued or processing for your account",
        );
      }

      const siwaTokensRevoked = deps.siwa ? await deps.siwa.revokeUserTokens(tx, userId) : 0;
      const aiSubscriptionsCanceled = await cancelAiSubscriptions(
        tx,
        deps.paymentProviders,
        userId,
      );
      const email = await detachFromSchool(tx, userId);

      const request = await createDsrRequest(tx, schoolId, userId, userId, "erasure");
      await emitAuditLog(tx, {
        action: "delete",
        targetTable: "users",
        targetId: userId,
        oldValues: null,
        newValues: {
          reason: "account_deletion",
          source: params.source ?? "account_settings",
          status: "archived",
          data_subject_request_id: request.id,
          erasure_due_at: request.slaDueAt.toISOString(),
          ai_subscriptions_canceled: aiSubscriptionsCanceled,
          siwa_tokens_revoked: siwaTokensRevoked,
          retained_record_categories: RETAINED_RECORD_CATEGORIES.map((c) => c.category),
        },
        clientIp: params.clientIp ?? null,
        userAgent: params.userAgent ?? null,
      });

      await emit(tx, DOMAIN_EVENTS.ACCOUNT_DELETED, {
        userId,
        email,
        completesBy: request.slaDueAt.toISOString(),
      });

      await addDsrJob(deps.maintenanceQueue, request, schoolId);
      return { request, aiSubscriptionsCanceled, siwaTokensRevoked };
    },
  );

  return {
    request,
    aiSubscriptionsCanceled,
    siwaTokensRevoked,
    sessionsRevoked: await revokeAllSessions(deps, params),
  };
}

/**
 * Stops every live AI add-on subscription billed for this user's student record. A parent or staff
 * account has no app.students row and matches nothing. The rows themselves stay (financial legal
 * hold); only future billing stops.
 */
async function cancelAiSubscriptions(
  tx: TransactionSql,
  providers: PaymentProviderRegistry,
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
      await requirePaymentProvider(providers, "stripe").port.scheduleCancellation({
        providerSubscriptionId: row.stripe_subscription_id,
      });
      canceled += 1;
    } else if (row.tap_billed) {
      // Tap subscriptions are renewed by Studafy's own worker, which only charges rows with a saved
      // card (apps/workers/src/queues/billing/tap-renewal.ts). Both columns go together
      // (ck_ai_subscriptions_tap_saved_card).
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

/**
 * Ends the user's membership of the school: archived, no roles, no sign-in identities, no parent
 * links. Returns the account's email address, for the confirmation email.
 */
async function detachFromSchool(tx: TransactionSql, userId: string): Promise<string> {
  const [updated] = await tx<{ email: string }[]>`
    UPDATE app.users
    SET status = 'archived'::app.user_status, updated_at = CURRENT_TIMESTAMP
    WHERE id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    RETURNING email
  `;
  if (!updated)
    throw new CodedHttpException(404, ERROR_CODES.DSR_SUBJECT_NOT_FOUND, "Account not found");

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
  return updated.email;
}

/**
 * Runs after the deletion has committed, so a failure here must not be reported as "deletion
 * failed": the account is already detached and can no longer sign in or refresh. What a failure can
 * leave is an access token that stays valid until its own expiry (JWT_ACCESS_TTL_SECONDS), which is
 * logged loudly instead of turned into an error response the user could not act on.
 */
async function revokeAllSessions(
  deps: AccountDeletionDeps,
  params: AccountDeletionParams,
): Promise<number> {
  try {
    const result = await revokeAndDenylist({
      database: deps.database,
      denylist: deps.denylist,
      tenant: { schoolId: params.schoolId, userId: params.userId, requestId: params.requestId },
      targetUserId: params.userId,
      scope: { kind: "user" },
      reason: REVOCATION_REASONS.ACCOUNT_DELETION,
      log: params.log,
      userAgent: params.userAgent,
      clientIp: params.clientIp,
    });
    return result.revokedTokens;
  } catch (error) {
    params.log?.error(
      { err: error, event: "account_deletion_session_revocation_failed", user_id: params.userId },
      "account deleted but session revocation failed; access tokens expire on their own TTL",
    );
    return 0;
  }
}
