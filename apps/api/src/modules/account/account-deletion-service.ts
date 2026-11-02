/**
 * Self-service account deletion (App Store 5.1.1(v), Google Play data deletion), with a 14-day
 * grace period (000143).
 *
 * Three steps, owned by two processes:
 *
 * 1. Schedule (here, `POST /api/account/deletion` and the emailed-link confirm) — one transaction:
 *      - refuse a second schedule, or an erasure already in flight,
 *      - re-authenticate a member-password account (its own member ID and password),
 *      - set `deletion_requested_at` / `deletion_due_at` (now + {@link DELETION_GRACE_DAYS} days),
 *      - write the audit entry.
 *    Then, after commit, every session is revoked and its access tokens denylisted. Signing in
 *    again during the grace period mints a token carrying `deletion_pending`, which
 *    accountDeletionGuard confines to showing and cancelling the deletion.
 *
 * 2. Cancel (here, `DELETE /api/account/deletion`) — clears both columns while the account is
 *    still attached. The client refreshes its token to drop the claim.
 *
 * 3. Run (apps/workers' account-deletion sweep, daily) — on the due date: stop AI add-on billing,
 *    detach from the school (archived; roles, sign-in identities and parent links removed), file
 *    and enqueue the erasure, revoke any session left. The erasure itself then completes within
 *    its 30-day SLA, keeping only what retention-policy.ts lists.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";
import { withTenantTx } from "../../db/tenant-tx";
import { emitAuditLog } from "../../middleware/auditEmitter";
import {
  isMemberPasswordAccount,
  verifyMemberCredentials,
} from "../auth/services/member-password-service";
import { REVOCATION_REASONS, revokeAndDenylist } from "../auth/services/revocation-service";
import { findOpenDsrRequest } from "../privacy/service";

import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { JtiDenylist } from "../auth/denylist";

/** How long a scheduled deletion waits before the sweep runs it. */
export const DELETION_GRACE_DAYS = 14;

/** The erasure SLA the sweep files with (privacy/service.ts): the latest erasure completes. */
const ERASURE_SLA_DAYS = 30;

const MILLIS_PER_DAY = 86_400_000;

export interface AccountDeletionDeps {
  database: Database;
  denylist: JtiDenylist | null;
}

/** Where the deletion was asked for. Recorded on the audit entry. */
export type AccountDeletionSource = "account_settings" | "web_request";

export interface ScheduleAccountDeletionParams {
  schoolId: string;
  userId: string;
  /**
   * "account_settings" (the default) is the signed-in path, which re-authenticates member-password
   * accounts; "web_request" is the emailed-link confirm, where the link already proved the address.
   */
  source?: AccountDeletionSource;
  /** Required from a member-password account on the signed-in path. */
  memberId?: string;
  password?: string;
  requestId?: string;
  log?: Logger;
  userAgent?: string | null;
  clientIp?: string | null;
}

export interface ScheduledAccountDeletion {
  requestedAt: Date;
  /** When the sweep detaches the account and files its erasure. */
  scheduledFor: Date;
  /** Latest time personal data will have been erased: the due date plus the erasure SLA. */
  completesBy: Date;
  sessionsRevoked: number;
}

export async function scheduleAccountDeletion(
  deps: AccountDeletionDeps,
  params: ScheduleAccountDeletionParams,
): Promise<ScheduledAccountDeletion> {
  const { schoolId, userId } = params;
  const source = params.source ?? "account_settings";
  const tenant = { schoolId, userId, requestId: params.requestId };

  // A wrong password must commit (it counts toward the lockout), so verification reports its
  // outcome instead of throwing inside the transaction.
  const outcome = await withTenantTx(deps.database, tenant, async (tx) => {
    const [user] = await tx<{ status: string; deletion_due_at: Date | null }[]>`
      SELECT status::text AS status, deletion_due_at FROM app.users
      WHERE id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
      FOR UPDATE
    `;
    if (!user || user.status === "archived") {
      throw new CodedHttpException(404, ERROR_CODES.DSR_SUBJECT_NOT_FOUND, "Account not found");
    }
    if (user.deletion_due_at) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.ACCOUNT_DELETION_ALREADY_SCHEDULED,
        "A deletion is already scheduled for your account",
      );
    }
    if (await findOpenDsrRequest(tx, schoolId, userId, "erasure")) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.DSR_ALREADY_PENDING,
        "A deletion request is already queued or processing for your account",
      );
    }

    if (source === "account_settings" && (await isMemberPasswordAccount(tx, userId))) {
      const verified = await verifyMemberCredentials(
        tx,
        userId,
        params.memberId ?? "",
        params.password ?? "",
      );
      if (verified !== "OK") return { kind: verified } as const;
    }

    const [scheduled] = await tx<{ requested_at: Date; due_at: Date }[]>`
      UPDATE app.users
      SET deletion_requested_at = CURRENT_TIMESTAMP,
          deletion_due_at = CURRENT_TIMESTAMP + make_interval(days => ${DELETION_GRACE_DAYS}),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${userId}::uuid AND school_id = current_setting('app.school_id')::uuid
      RETURNING deletion_requested_at AS requested_at, deletion_due_at AS due_at
    `;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "users",
      targetId: userId,
      oldValues: { deletion_due_at: null },
      newValues: {
        event: "account_deletion_scheduled",
        source,
        deletion_due_at: scheduled!.due_at.toISOString(),
      },
      clientIp: params.clientIp ?? null,
      userAgent: params.userAgent ?? null,
    });
    return {
      kind: "scheduled",
      requestedAt: scheduled!.requested_at,
      dueAt: scheduled!.due_at,
    } as const;
  });

  if (outcome.kind !== "scheduled") throw verificationFailure(outcome.kind);

  return {
    requestedAt: outcome.requestedAt,
    scheduledFor: outcome.dueAt,
    completesBy: new Date(outcome.dueAt.getTime() + ERASURE_SLA_DAYS * MILLIS_PER_DAY),
    sessionsRevoked: await revokeAllSessions(deps, params),
  };
}

function verificationFailure(kind: "LOCKED" | "WRONG"): CodedHttpException {
  if (kind === "LOCKED") {
    return new CodedHttpException(
      403,
      ERROR_CODES.AUTH_ACCOUNT_LOCKED,
      "Too many wrong passwords; try again later",
    );
  }
  return new CodedHttpException(
    422,
    ERROR_CODES.ACCOUNT_DELETION_VERIFICATION_FAILED,
    "The member ID or password is incorrect",
  );
}

export interface CancelAccountDeletionParams {
  schoolId: string;
  userId: string;
  requestId?: string;
  clientIp?: string | null;
  userAgent?: string | null;
}

/** Cancels the caller's scheduled deletion. 409 when none is scheduled (or it has already run). */
export async function cancelAccountDeletion(
  database: Database,
  params: CancelAccountDeletionParams,
): Promise<void> {
  const tenant = { schoolId: params.schoolId, userId: params.userId, requestId: params.requestId };
  await withTenantTx(database, tenant, async (tx) => {
    const [user] = await tx<{ status: string; deletion_due_at: Date | null }[]>`
      SELECT status::text AS status, deletion_due_at FROM app.users
      WHERE id = ${params.userId}::uuid AND school_id = current_setting('app.school_id')::uuid
      FOR UPDATE
    `;
    // An archived account has already been run by the sweep; there is nothing left to cancel.
    if (!user?.deletion_due_at || user.status === "archived") {
      throw new CodedHttpException(
        409,
        ERROR_CODES.ACCOUNT_DELETION_NOT_SCHEDULED,
        "No deletion is scheduled for your account",
      );
    }
    await tx`
      UPDATE app.users
      SET deletion_requested_at = NULL, deletion_due_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${params.userId}::uuid AND school_id = current_setting('app.school_id')::uuid
    `;
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "users",
      targetId: params.userId,
      oldValues: { deletion_due_at: user.deletion_due_at.toISOString() },
      newValues: { event: "account_deletion_cancelled", deletion_due_at: null },
      clientIp: params.clientIp ?? null,
      userAgent: params.userAgent ?? null,
    });
  });
}

/**
 * Runs after the schedule has committed, so a failure here must not be reported as "scheduling
 * failed": the deletion will run regardless. What a failure can leave is an access token without
 * the `deletion_pending` claim that stays valid until its own expiry (JWT_ACCESS_TTL_SECONDS),
 * which is logged loudly instead of turned into an error response the user could not act on.
 */
async function revokeAllSessions(
  deps: AccountDeletionDeps,
  params: ScheduleAccountDeletionParams,
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
      "account deletion scheduled but session revocation failed; access tokens expire on their own TTL",
    );
    return 0;
  }
}
