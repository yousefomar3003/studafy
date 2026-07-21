/**
 * Account activation — the atomic onboarding transaction (ST-078).
 *
 * An invited user completes onboarding by presenting their one-time invitation token together with a
 * verified Microsoft OIDC identity. This service turns that into an account in a single database
 * transaction: it consumes the invitation, provisions (or activates) the user, grants the invited
 * role, links the `oauth_identity`, writes the audit trail, and issues the first session token pair —
 * all or nothing.
 *
 * Two properties drive the shape:
 *
 *   1. Concurrency. The invitation is a single-use bearer credential, so two parallel submissions of
 *      the same token must not both succeed. The transaction takes a `FOR UPDATE` lock on the
 *      invitation row as its first statement; the winner sets `consumed_at` and commits, every other
 *      attempt then re-reads a consumed row under the lock and is rejected with CONSUMED. No orphaned
 *      identity rows are possible because nothing is written until the lock is held and the lifecycle
 *      re-checked.
 *
 *   2. Tenant resolution. The token carries no tenant, and `app.invitations` is FORCE RLS, so the
 *      school must be resolved before a tenant transaction can exist. Like `rotateRefreshToken`, this
 *      service therefore owns its own transaction and takes a `Database`, not a `TransactionSql`. It
 *      resolves `token_hash -> (invitation_id, school_id)` through the SECURITY DEFINER seam added in
 *      migration 000033, then opens the real tenant transaction with the resolved school.
 *
 * Email divergence (the OIDC email does not match the invitation's bound email) is not an activation:
 * it records a `REQUIRES_ADMIN_APPROVAL` anomaly in the audit log and commits without consuming the
 * invitation or granting anything. The caller renders that as a problem+json response.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { emitAuditLog } from "../../../middleware/auditEmitter";
import {
  evaluateInvitationState,
  hashInvitationToken,
  INVITATION_TOKEN_PATTERN,
  maskInvitationEmail,
} from "../invitation/verification";

import { issueTokenPair } from "./session-service";

import type { DeviceContext, IssuedTokenPair, SessionTokenConfig } from "./session-service";
import type { Database } from "../../../db/client";
import type { Logger } from "../../../logger";
import type { AuthChannel } from "../channels";
import type { InvitationVerificationState } from "../invitation/verification";
import type { ErrorCode } from "@studafy/constants";

/** The only OAuth provider this activation flow links. Matches app.oauth_identities.provider. */
export const ACTIVATION_PROVIDER = "microsoft";

/** A Microsoft OIDC identity that has already been verified by the caller (ST-077). */
export interface ActivationIdentity {
  provider: typeof ACTIVATION_PROVIDER;
  /** The IdP subject (`sub`) claim — stored as app.oauth_identities.subject. */
  subject: string;
  /** The verified email from the ID token, matched against the invitation's bound email. */
  email: string;
}

export interface ActivateAccountParams {
  /** The raw invitation bearer token (64 lowercase hex chars). */
  rawToken: string;
  identity: ActivationIdentity;
  channel: AuthChannel;
  device?: DeviceContext;
  requestId?: string;
  /** Display name to seed a newly provisioned user with. Optional. */
  displayName?: string | null;
  logger?: Logger;
}

export type ActivateAccountResult =
  | {
      outcome: "ACTIVATED";
      tokens: IssuedTokenPair;
      userId: string;
      schoolId: string;
      invitationId: string;
    }
  | { outcome: "REQUIRES_ADMIN_APPROVAL"; schoolId: string; invitationId: string };

interface InvitationLockRow {
  role: string;
  email: string;
  normalizedEmail: string;
  expiresAt: Date;
  revokedAt: Date | null;
  consumedAt: Date | null;
  schoolStatus: "pending" | "active" | "suspended" | "archived";
}

const INVALID_INVITATION_MESSAGE = "Invitation is invalid.";

function lifecycleFailureCode(state: Exclude<InvitationVerificationState, "VALID">): ErrorCode {
  switch (state) {
    case "EXPIRED":
      return ERROR_CODES.EXPIRED;
    case "REVOKED":
      return ERROR_CODES.REVOKED;
    case "CONSUMED":
      return ERROR_CODES.CONSUMED;
    case "SCHOOL_SUSPENDED":
      return ERROR_CODES.SCHOOL_SUSPENDED;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Resolve the invitation token to its tenant without reading it under RLS.
 *
 * Runs in its own short transaction against the SECURITY DEFINER resolver (migration 000033). Returns
 * `null` for a token that is malformed at the digest level or does not exist — both are surfaced to
 * the caller as the same opaque INVITATION_INVALID, so a probe cannot distinguish them.
 */
async function resolveInvitationTenant(
  db: Database,
  tokenHash: Buffer,
): Promise<{ invitationId: string; schoolId: string } | null> {
  let row: { found: boolean; invitationId: string; schoolId: string } | undefined;
  await db.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE studafy_app");
    const rows = await tx<{ found: boolean; invitationId: string; schoolId: string }[]>`
      SELECT
        found,
        invitation_id AS "invitationId",
        school_id AS "schoolId"
      FROM app.resolve_invitation_for_activation(${tokenHash}::bytea)
    `;
    row = rows[0];
  });

  if (!row || !row.found) return null;
  return { invitationId: row.invitationId, schoolId: row.schoolId };
}

/**
 * Execute the account activation transaction.
 *
 * @throws CodedHttpException(400 INVITATION_INVALID) — malformed or unknown token.
 * @throws CodedHttpException(409 EXPIRED|REVOKED|CONSUMED|SCHOOL_SUSPENDED) — invitation unusable.
 * @throws CodedHttpException(409 CONFLICT_DUPLICATE_ENTRY) — the identity is already linked elsewhere.
 */
export async function activateAccount(
  db: Database,
  config: SessionTokenConfig,
  params: ActivateAccountParams,
): Promise<ActivateAccountResult> {
  const { rawToken, identity } = params;

  if (!INVITATION_TOKEN_PATTERN.test(rawToken)) {
    throw new CodedHttpException(400, ERROR_CODES.INVITATION_INVALID, INVALID_INVITATION_MESSAGE);
  }

  const tokenHash = hashInvitationToken(rawToken);
  const tenant = await resolveInvitationTenant(db, tokenHash);
  if (!tenant) {
    throw new CodedHttpException(400, ERROR_CODES.INVITATION_INVALID, INVALID_INVITATION_MESSAGE);
  }

  const { invitationId, schoolId } = tenant;

  return withTenantTx(db, { schoolId, requestId: params.requestId }, async (tx) => {
    // Authoritative lock — this is the first statement, so the invitation row is serialized across
    // all concurrent activations before any state is read or written. Losing attempts block here and
    // observe consumed_at once the winner commits.
    const [invite] = await tx<InvitationLockRow[]>`
      SELECT
        invitation.role,
        invitation.email,
        invitation.normalized_email AS "normalizedEmail",
        invitation.expires_at AS "expiresAt",
        invitation.revoked_at AS "revokedAt",
        invitation.consumed_at AS "consumedAt",
        school.status AS "schoolStatus"
      FROM app.invitations AS invitation
      INNER JOIN app.schools AS school ON school.id = invitation.school_id
      WHERE invitation.id = ${invitationId}::uuid
        AND invitation.school_id = current_setting('app.school_id')::uuid
      FOR UPDATE OF invitation
    `;

    if (!invite) {
      throw new CodedHttpException(400, ERROR_CODES.INVITATION_INVALID, INVALID_INVITATION_MESSAGE);
    }

    const state = evaluateInvitationState({
      expiresAt: invite.expiresAt,
      revokedAt: invite.revokedAt,
      consumedAt: invite.consumedAt,
      schoolStatus: invite.schoolStatus,
    });
    if (state !== "VALID") {
      throw new CodedHttpException(409, lifecycleFailureCode(state), "Invitation cannot be used.");
    }

    const oauthEmail = identity.email.trim().toLowerCase();

    // Email divergence handling — abort automatic activation. Record the anomaly and commit; the
    // invitation is deliberately left unconsumed so an administrator can still resolve it. Returning
    // (rather than throwing) is what lets the audit row persist.
    if (oauthEmail !== invite.normalizedEmail) {
      await emitAuditLog(tx, {
        action: "permission_change",
        targetTable: "invitations",
        targetId: invitationId,
        newValues: {
          outcome: "REQUIRES_ADMIN_APPROVAL",
          reason: "oauth_email_mismatch",
          provider: identity.provider,
          invitation_email: maskInvitationEmail(invite.normalizedEmail),
          oauth_email: maskInvitationEmail(oauthEmail),
        },
      });
      params.logger?.warn(
        { invitation_id: invitationId, school_id: schoolId, provider: identity.provider },
        "account activation requires admin approval (email mismatch)",
      );
      return { outcome: "REQUIRES_ADMIN_APPROVAL", schoolId, invitationId };
    }

    // Provision the user. Nothing creates the invited user row before activation, so this is a
    // create-or-activate: a fresh invitee is inserted active, a pre-existing row is flipped to active.
    const existing = await tx<{ id: string; status: string }[]>`
      SELECT id, status
      FROM app.users
      WHERE school_id = current_setting('app.school_id')::uuid
        AND normalized_email = ${invite.normalizedEmail}
      FOR UPDATE
    `;

    let userId: string;
    if (existing.length === 0) {
      const [created] = await tx<{ id: string }[]>`
        INSERT INTO app.users (
          school_id, email, normalized_email, display_name, status, email_verified_at
        ) VALUES (
          current_setting('app.school_id')::uuid,
          ${invite.email},
          ${invite.normalizedEmail},
          ${params.displayName ?? null},
          'active',
          CURRENT_TIMESTAMP
        )
        RETURNING id
      `;
      userId = created!.id;
    } else {
      userId = existing[0]!.id;
      await tx`
        UPDATE app.users
        SET status = 'active',
            email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${userId}::uuid
          AND school_id = current_setting('app.school_id')::uuid
      `;
    }

    // Actor for the audit trail and the tenant scope for issueTokenPair's role read. The user is
    // acting on their own account, so they are the actor.
    await tx`SELECT set_config('app.user_id', ${userId}, true)`.execute();

    // Grant the invited role. issueTokenPair refuses to mint a token for a user with no roles, so
    // this must land before it.
    await tx`
      INSERT INTO app.user_roles (school_id, user_id, role)
      VALUES (
        current_setting('app.school_id')::uuid,
        ${userId}::uuid,
        ${invite.role}::app.user_role
      )
      ON CONFLICT DO NOTHING
    `;

    // Link the Microsoft identity. A (provider, subject) collision means this external account is
    // already bound to some user; under the invitation lock a concurrent duplicate never reaches
    // here, so a collision is a genuine cross-account conflict rather than a race.
    let identityId: string;
    try {
      const [linked] = await tx<{ id: string }[]>`
        INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
        VALUES (
          current_setting('app.school_id')::uuid,
          ${userId}::uuid,
          ${identity.provider},
          ${identity.subject}
        )
        RETURNING id
      `;
      identityId = linked!.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CodedHttpException(
          409,
          ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
          "This Microsoft account is already linked to another user.",
        );
      }
      throw error;
    }

    // Consume the invitation. Guarded on the lifecycle predicate as a backstop; under the lock this
    // always affects the row we validated.
    const consumed = await tx<{ id: string }[]>`
      UPDATE app.invitations
      SET consumed_at = CURRENT_TIMESTAMP
      WHERE id = ${invitationId}::uuid
        AND school_id = current_setting('app.school_id')::uuid
        AND consumed_at IS NULL
        AND revoked_at IS NULL
      RETURNING id
    `;
    if (consumed.length === 0) {
      throw new CodedHttpException(409, ERROR_CODES.CONSUMED, "Invitation cannot be used.");
    }

    // Audit trail — identity link, user activation, invitation consumption. All in-transaction, so a
    // later failure rolls the audit rows back with the mutations they describe.
    await emitAuditLog(tx, {
      action: "insert",
      targetTable: "oauth_identities",
      targetId: identityId,
      newValues: { provider: identity.provider, user_id: userId },
    });
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "users",
      targetId: userId,
      oldValues: { status: existing.length === 0 ? "invited" : existing[0]!.status },
      newValues: { status: "active" },
    });
    await emitAuditLog(tx, {
      action: "update",
      targetTable: "invitations",
      targetId: invitationId,
      oldValues: { consumed_at: null },
      newValues: { consumed_at: new Date().toISOString() },
    });

    // Issue the first session token pair inside the same unit of work.
    const tokens = await issueTokenPair(tx, config, {
      userId,
      schoolId,
      channel: params.channel,
      device: params.device,
    });

    params.logger?.info(
      { invitation_id: invitationId, user_id: userId, school_id: schoolId },
      "account activated",
    );

    return { outcome: "ACTIVATED", tokens, userId, schoolId, invitationId };
  });
}
