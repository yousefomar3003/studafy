/**
 * Platform console support actions on one account in one school (`/portal/platform/users`).
 *
 * The operator is a SUPER_ADMIN of their *home* school acting on an account in any school, so every
 * action follows the console's cross-tenant pattern (see the header of ./service.ts): one system
 * transaction, the target school's scope armed, the work done with no `app.user_id` (so the target
 * school's own rows read "Studafy did this"), then {@link auditSchoolChange} writes the operator's
 * attributed row at home. The target-school writes always come first: once the home row is written
 * the transaction's `app.user_id` names the operator, whom the target school's FK cannot hold.
 *
 * Each action reuses the service a school admin's own action uses -- invitations, the deactivation
 * status step, the SECURITY DEFINER session revoke, the member lockout reset -- rather than its own
 * copy, and none of them returns a credential: an invitation token goes out by email to the
 * account's own address through the outbox, exactly as a school admin's resend does.
 *
 * Deliberately absent: signing in as the user (impersonation), setting or revealing a password, and
 * changing an email address (no flow re-verifies a new address yet).
 */

import { ROLES } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { setTenantScope, withSystemTx } from "../../db/tenant-tx";
import { createInvitationService } from "../auth/invitation/service";
import { clearMemberLockoutInTx } from "../auth/services/member-password-service";
import {
  denylistRevoked,
  REVOCATION_REASONS,
  revokeUserSessionsInTx,
} from "../auth/services/revocation-service";
import { suspendUserInTx } from "../users/user-service";

import { auditSchoolChange, loadSchool } from "./service";

import type { Actor } from "./service";
import type { Database } from "../../db/client";
import type { Logger } from "../../logger";
import type { JtiDenylist } from "../auth/denylist";
import type { RevokedSessionRow } from "../auth/services/revocation-service";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

/** The audit `support_action` names, one per console action. */
export const SUPPORT_ACTIONS = {
  VIEW: "view",
  RESEND_INVITATION: "resend_invitation",
  SIGN_OUT_EVERYWHERE: "sign_out_everywhere",
  UNLOCK: "unlock",
  DEACTIVATE: "deactivate",
  REACTIVATE: "reactivate",
} as const;

export type SupportAction = (typeof SUPPORT_ACTIONS)[keyof typeof SUPPORT_ACTIONS];

/** Roles that may hold the invitation a resend reissues; platform roles are never invited here. */
const INVITABLE_ROLES: readonly Role[] = [
  ROLES.ORG_ADMIN,
  ROLES.PRINCIPAL,
  ROLES.FINANCE,
  ROLES.INSTRUCTOR,
  ROLES.ATTENDANCE_OFFICER,
  ROLES.PARENT,
  ROLES.STUDENT,
];

interface TargetRow {
  id: string;
  display_name: string | null;
  email: string | null;
  normalized_email: string | null;
  status: string;
  created_at: Date;
  last_login_at: Date | null;
  email_verified_at: Date | null;
  roles: string[] | null;
  has_password: boolean;
  has_identity: boolean;
}

export interface SupportDeps {
  database: Database;
  denylist: JtiDenylist | null;
  logger: Logger;
}

const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

/** Loads the school, arms its scope with no actor and loads the account; 404 if either is missing. */
async function loadTarget(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  actor: Actor,
): Promise<{ school: Awaited<ReturnType<typeof loadSchool>>; target: TargetRow }> {
  const school = await loadSchool(tx, schoolId);
  await setTenantScope(tx, schoolId, actor.requestId);
  await tx`SELECT set_config('app.user_id', '', true)`;
  const [row] = await tx<TargetRow[]>`
    SELECT u.id, u.display_name, u.email, u.normalized_email, u.status::text AS status,
           u.created_at, u.last_login_at, u.email_verified_at,
           ARRAY(SELECT r.role::text FROM app.user_roles r
                 WHERE r.user_id = u.id ORDER BY r.role) AS roles,
           EXISTS (SELECT 1 FROM app.member_credentials mc
                   WHERE mc.user_id = u.id AND mc.password_hash IS NOT NULL) AS has_password,
           EXISTS (SELECT 1 FROM app.oauth_identities oi WHERE oi.user_id = u.id) AS has_identity
    FROM app.users u
    WHERE u.id = ${userId}::uuid
  `;
  if (!row) throw new HTTPException(404, { message: "Account not found in this school" });
  return { school, target: row };
}

/** Another SUPER_ADMIN's account is out of the console's reach; the operator's own is not. */
function isProtected(target: TargetRow, actor: Actor): boolean {
  return (target.roles ?? []).includes(ROLES.SUPER_ADMIN) && target.id !== actor.userId;
}

function assertActionable(target: TargetRow, actor: Actor): void {
  if (isProtected(target, actor)) {
    throw new HTTPException(403, {
      message: "Support actions cannot target another Studafy platform administrator",
    });
  }
}

function isActivated(target: TargetRow): boolean {
  return (
    target.last_login_at !== null ||
    target.email_verified_at !== null ||
    target.has_password ||
    target.has_identity
  );
}

/**
 * The action's two audit rows. A change is an `update` of the account, which the audit table only
 * accepts with the prior state as well (ck_audit_logs_payload): the account's status before it.
 */
async function audit(
  tx: TransactionSql,
  schoolId: string,
  actor: Actor,
  action: SupportAction,
  target: TargetRow,
  reason: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const isRead = action === SUPPORT_ACTIONS.VIEW;
  await auditSchoolChange(tx, schoolId, actor, {
    action: isRead ? "read" : "update",
    targetTable: "users",
    targetId: target.id,
    oldValues: isRead ? null : { status: target.status },
    newValues: { support_action: action, reason, ...details },
  });
}

// ---------------------------------------------------------------------------
// Read-only panel
// ---------------------------------------------------------------------------

/** One account's support panel. Personal data leaving its tenant, so audited as a read. */
export async function getSupportUser(
  database: Database,
  schoolId: string,
  userId: string,
  actor: Actor,
) {
  return withSystemTx(database, async (tx) => {
    const { school, target } = await loadTarget(tx, schoolId, userId, actor);

    const [credentials] = await tx<
      { failed_attempts: number; locked_until: Date | null; locked: boolean }[]
    >`
      SELECT failed_attempts, locked_until,
             coalesce(locked_until > CURRENT_TIMESTAMP, false) AS locked
      FROM app.member_credentials WHERE user_id = ${userId}::uuid
    `;
    const providers = await tx<{ provider: string }[]>`
      SELECT DISTINCT provider FROM app.oauth_identities
      WHERE user_id = ${userId}::uuid ORDER BY provider
    `;
    const memberCodes = await tx<{ code: string }[]>`
      SELECT code FROM app.member_codes WHERE user_id = ${userId}::uuid ORDER BY kind
    `;
    const [sessions] = await tx<{ count: number }[]>`
      SELECT count(*)::int AS count FROM app.admin_list_user_sessions(${userId}::uuid)
    `;
    const [invitation] = target.normalized_email
      ? await tx<
          {
            expires_at: Date;
            created_at: Date;
            revoked_at: Date | null;
            consumed_at: Date | null;
            expired: boolean;
          }[]
        >`
          SELECT expires_at, created_at, revoked_at, consumed_at,
                 expires_at <= CURRENT_TIMESTAMP AS expired
          FROM app.invitations
          WHERE normalized_email = ${target.normalized_email}
          ORDER BY created_at DESC LIMIT 1
        `
      : [];
    const children = await tx<{ name: string | null; relationship: string }[]>`
      SELECT NULLIF(concat_ws(' ', s.first_name, s.last_name), '') AS name,
             l.relationship::text AS relationship
      FROM app.parent_child_links l
      JOIN app.students s ON s.id = l.student_id
      WHERE l.parent_user_id = ${userId}::uuid
      ORDER BY s.first_name, s.id
    `;
    const parents = await tx<{ name: string | null; relationship: string }[]>`
      SELECT pu.display_name AS name, l.relationship::text AS relationship
      FROM app.students s
      JOIN app.parent_child_links l ON l.student_id = s.id
      JOIN app.users pu ON pu.id = l.parent_user_id
      WHERE s.user_id = ${userId}::uuid
      ORDER BY pu.display_name, pu.id
    `;

    await audit(tx, schoolId, actor, SUPPORT_ACTIONS.VIEW, target, null);

    const invitationStatus = invitation
      ? invitation.consumed_at
        ? ("accepted" as const)
        : invitation.revoked_at
          ? ("revoked" as const)
          : invitation.expired
            ? ("expired" as const)
            : ("pending" as const)
      : null;

    return {
      school: { id: school.id, name: school.name, status: school.status },
      userId: target.id,
      displayName: target.display_name,
      email: target.email,
      status: target.status,
      roles: target.roles ?? [],
      memberCodes: memberCodes.map((row) => row.code),
      createdAt: iso(target.created_at),
      lastLoginAt: isoOrNull(target.last_login_at),
      activated: isActivated(target),
      signIn: {
        providers: providers.map((row) => row.provider),
        memberPassword: target.has_password,
        locked: credentials?.locked ?? false,
        lockedUntil: credentials?.locked ? isoOrNull(credentials.locked_until) : null,
        failedAttempts: credentials?.failed_attempts ?? 0,
      },
      activeSessions: sessions?.count ?? 0,
      invitation:
        invitation && invitationStatus
          ? {
              status: invitationStatus,
              expiresAt: iso(invitation.expires_at),
              createdAt: iso(invitation.created_at),
            }
          : null,
      children: children.map(({ name, relationship }) => ({ name, relationship })),
      parents: parents.map(({ name, relationship }) => ({ name, relationship })),
      actionable: !isProtected(target, actor),
      isSelf: target.id === actor.userId,
    };
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Re-sends an account's invitation to its own email address. Reissues the newest unconsumed
 * invitation (revoking it, like a school admin's "regenerate"); when every earlier one was revoked
 * -- a deactivated account brought back -- issues a fresh one for the same role. The token reaches
 * the user only through the invitation email; the response carries none.
 */
export async function resendInvitation(
  deps: SupportDeps,
  schoolId: string,
  userId: string,
  reason: string,
  actor: Actor,
) {
  return withSystemTx(deps.database, async (tx) => {
    const { school, target } = await loadTarget(tx, schoolId, userId, actor);
    assertActionable(target, actor);
    if (school.status !== "active") {
      throw new HTTPException(409, { message: "The school is not active; no one can sign in yet" });
    }
    if (target.status !== "invited") {
      throw new HTTPException(409, {
        message: "Only an account that has not been activated can be re-invited",
      });
    }
    if (!target.email || !target.normalized_email) {
      throw new HTTPException(409, {
        message:
          "This account signs in with a member ID, not an email; the school issues it a setup code",
      });
    }

    const service = createInvitationService();
    const [live] = await tx<{ id: string }[]>`
      SELECT id FROM app.invitations
      WHERE normalized_email = ${target.normalized_email}
        AND revoked_at IS NULL AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `;

    let invitationId: string;
    let expiresAt: Date;
    if (live) {
      const result = await service.regenerate(tx, live.id, deps.logger);
      invitationId = result.invitationId;
      expiresAt = result.expiresAt;
    } else {
      const [previous] = await tx<{ role: Role }[]>`
        SELECT role::text AS role FROM app.invitations
        WHERE normalized_email = ${target.normalized_email}
        ORDER BY created_at DESC LIMIT 1
      `;
      const role =
        previous?.role ??
        (target.roles ?? []).find((candidate): candidate is Role =>
          INVITABLE_ROLES.includes(candidate as Role),
        );
      if (!role || !INVITABLE_ROLES.includes(role)) {
        throw new HTTPException(409, { message: "The account has no role to invite it to" });
      }
      const result = await service.create(tx, { email: target.email, role }, deps.logger);
      invitationId = result.invitationId;
      expiresAt = result.expiresAt;
    }

    await audit(tx, schoolId, actor, SUPPORT_ACTIONS.RESEND_INVITATION, target, reason, {
      invitation_id: invitationId,
    });
    return { invitationId, expiresAt: iso(expiresAt) };
  });
}

/** Ends every session the account has, on every device, and denylists their access tokens. */
export async function signOutEverywhere(
  deps: SupportDeps,
  schoolId: string,
  userId: string,
  reason: string,
  actor: Actor,
) {
  let revoked: RevokedSessionRow[] = [];
  await withSystemTx(deps.database, async (tx) => {
    const { target } = await loadTarget(tx, schoolId, userId, actor);
    assertActionable(target, actor);
    revoked = await revokeUserSessionsInTx(tx, userId);
    await audit(tx, schoolId, actor, SUPPORT_ACTIONS.SIGN_OUT_EVERYWHERE, target, reason, {
      revocation_reason: REVOCATION_REASONS.ADMIN_REVOKE_ALL_DEVICES,
      family_ids: [...new Set(revoked.map((row) => row.family_id))],
      revoked_token_count: revoked.length,
    });
  });

  const denylisted = await denylistRevoked(deps.denylist, revoked, {
    reason: REVOCATION_REASONS.ADMIN_REVOKE_ALL_DEVICES,
    subject: { targetUserId: userId },
    log: deps.logger,
  });
  return { revokedSessions: revoked.length, denylistedTokens: denylisted };
}

/** Clears a member-ID account's lockout after repeated wrong passwords. Idempotent. */
export async function unlockAccount(
  deps: SupportDeps,
  schoolId: string,
  userId: string,
  reason: string,
  actor: Actor,
) {
  return withSystemTx(deps.database, async (tx) => {
    const { target } = await loadTarget(tx, schoolId, userId, actor);
    assertActionable(target, actor);
    const result = await clearMemberLockoutInTx(tx, userId);
    await audit(tx, schoolId, actor, SUPPORT_ACTIONS.UNLOCK, target, reason, {
      was_locked: result.wasLocked,
      failed_attempts_cleared: result.failedAttempts,
    });
    return { wasLocked: result.wasLocked, failedAttemptsCleared: result.failedAttempts };
  });
}

/**
 * Deactivates an account the way a school admin does: suspended, pending invitations revoked, every
 * session ended. The operator's own account is refused -- it would lock the console out.
 */
export async function deactivateAccount(
  deps: SupportDeps,
  schoolId: string,
  userId: string,
  reason: string,
  actor: Actor,
) {
  let revoked: RevokedSessionRow[] = [];
  let invitationsRevoked = 0;
  await withSystemTx(deps.database, async (tx) => {
    const { target } = await loadTarget(tx, schoolId, userId, actor);
    assertActionable(target, actor);
    if (target.id === actor.userId) {
      throw new HTTPException(409, { message: "You cannot deactivate your own account" });
    }
    if (target.status === "suspended") {
      throw new HTTPException(409, { message: "The account is already deactivated" });
    }
    if (target.status === "archived") {
      throw new HTTPException(409, { message: "The account is archived" });
    }
    invitationsRevoked = await suspendUserInTx(tx, userId);
    revoked = await revokeUserSessionsInTx(tx, userId);
    await audit(tx, schoolId, actor, SUPPORT_ACTIONS.DEACTIVATE, target, reason, {
      old_status: target.status,
      status: "suspended",
      invitations_revoked: invitationsRevoked,
      revoked_token_count: revoked.length,
    });
  });

  await denylistRevoked(deps.denylist, revoked, {
    reason: REVOCATION_REASONS.ADMIN_REVOKE_ALL_DEVICES,
    subject: { targetUserId: userId },
    log: deps.logger,
  });
  return { status: "suspended", revokedSessions: revoked.length, invitationsRevoked };
}

/**
 * Brings a deactivated account back. It returns to `active` if it had ever been activated, and to
 * `invited` otherwise -- reactivation never skips activation; the operator re-sends the invitation.
 */
export async function reactivateAccount(
  deps: SupportDeps,
  schoolId: string,
  userId: string,
  reason: string,
  actor: Actor,
) {
  return withSystemTx(deps.database, async (tx) => {
    const { target } = await loadTarget(tx, schoolId, userId, actor);
    assertActionable(target, actor);
    if (target.status !== "suspended") {
      throw new HTTPException(409, { message: "Only a deactivated account can be reactivated" });
    }
    const status = isActivated(target) ? "active" : "invited";
    await tx`
      UPDATE app.users
      SET status = ${status}::app.user_status, updated_at = CURRENT_TIMESTAMP
      WHERE id = ${userId}::uuid AND status = 'suspended'::app.user_status
    `;
    await audit(tx, schoolId, actor, SUPPORT_ACTIONS.REACTIVATE, target, reason, {
      old_status: "suspended",
      status,
    });
    return { status, revokedSessions: 0, invitationsRevoked: 0 };
  });
}
