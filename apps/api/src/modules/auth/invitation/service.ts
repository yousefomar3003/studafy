import { createHash, randomBytes } from "node:crypto";

import { DOMAIN_EVENTS } from "@studafy/constants";
import { HTTPException } from "hono/http-exception";

import { emit } from "../../../lib/events/emitter";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Logger } from "../../../logger";
import type { Role } from "@studafy/constants";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const DEFAULT_INVITATION_EXPIRY_DAYS = 7;

export interface CreateInvitationParams {
  email: string;
  role: Role;
  /** Caller-supplied expiry in days. Falls back to DEFAULT_INVITATION_EXPIRY_DAYS. */
  expiryDays?: number;
  /** ID of the user issuing the invitation. */
  invitedByUserId?: string;
}

export interface CreateInvitationResult {
  /** The raw, one-time-use invitation token. Returned to the caller exactly once. */
  token: string;
  invitationId: string;
  email: string;
  role: Role;
  expiresAt: Date;
}

export interface RevokeInvitationResult {
  invitationId: string;
  email: string;
  role: Role;
  revokedAt: Date;
}

export interface RegenerateInvitationResult {
  /** The new invitation's ID. */
  invitationId: string;
  /** The raw, one-time-use token for the new invitation. */
  token: string;
  email: string;
  role: Role;
  expiresAt: Date;
  /** The old invitation's ID that was revoked. */
  revokedInvitationId: string;
  revokedAt: Date;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random 256-bit (32-byte) invitation token, hex-encoded.
 *
 * The raw token is the sole bearer credential: anyone who presents it can accept the invitation.
 * It is never stored — only its SHA-256 digest is persisted (see `hashToken`).
 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compute the SHA-256 digest of a raw invitation token. The resulting 32-byte buffer is what
 * gets stored in `app.invitations.token_hash`.
 */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export interface InvitationServiceOptions {
  /** Default expiry in days when the caller does not override. */
  defaultExpiryDays?: number;
  /** Clock override for deterministic testing. Returns epoch ms. */
  now?: () => number;
}

/**
 * Build an invitation service scoped to a single database transaction.
 *
 * The service is transaction-scoped because the DB insert, audit log write, and outbox event
 * emission must all participate in the same atomic unit. The caller owns the transaction lifecycle
 * via `withTenantTx` (or equivalent) and passes the transaction handle in.
 */
export function createInvitationService(options: InvitationServiceOptions = {}) {
  const defaultExpiryDays = options.defaultExpiryDays ?? DEFAULT_INVITATION_EXPIRY_DAYS;

  return {
    /**
     * Create an invitation within an existing transaction.
     *
     * 1. Generates a 256-bit random token.
     * 2. Computes its SHA-256 hash.
     * 3. Inserts the hash + metadata into `app.invitations`.
     * 4. Writes an audit log entry.
     * 5. Emits `invitation.sent` into the outbox for email dispatch.
     *
     * @returns The raw token (returned once) + invitation metadata.
     * @throws HTTPException(409) if an active invitation already exists for this email+role.
     */
    async create(
      tx: TransactionSql,
      params: CreateInvitationParams,
      logger: Logger,
    ): Promise<CreateInvitationResult> {
      const expiryDays = params.expiryDays ?? defaultExpiryDays;
      if (expiryDays < 1 || expiryDays > 365) {
        throw new HTTPException(400, { message: "Expiry must be between 1 and 365 days" });
      }

      const token = generateToken();
      const tokenHash = hashToken(token);
      const normalizedEmail = params.email.toLowerCase().trim();
      const now = options.now?.() ?? Date.now();
      const expiresAt = new Date(now + expiryDays * 24 * 60 * 60 * 1000);

      // Insert the invitation, relying on the partial unique index uq_invitations_active to
      // reject duplicate active invitations for the same (school, email, role).
      const result = await tx`
        INSERT INTO app.invitations (
          school_id,
          email,
          normalized_email,
          role,
          token_hash,
          invited_by_user_id,
          expires_at
        ) VALUES (
          current_setting('app.school_id')::uuid,
          ${params.email},
          ${normalizedEmail},
          ${params.role}::app.user_role,
          ${tokenHash}::bytea,
          ${params.invitedByUserId ?? null}::uuid,
          ${expiresAt.toISOString()}::timestamptz
        )
        RETURNING id, email, role, expires_at
      `;

      if (result.length === 0) {
        throw new HTTPException(500, { message: "Failed to create invitation" });
      }

      const row = result[0]!;

      // Audit log — records the issuance. The raw token is deliberately excluded from the
      // audit payload; only the invitation id, email, and role are recorded.
      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "invitations",
        targetId: row.id,
        newValues: {
          email: params.email,
          role: params.role,
          expires_at: expiresAt.toISOString(),
        },
      });

      // Outbox event — the workers relay consumer will pick this up and dispatch the email.
      await emit(tx, DOMAIN_EVENTS.INVITATION_SENT, {
        invitationId: row.id,
        email: params.email,
        role: params.role,
        expiresAt: expiresAt.toISOString(),
        invitedByUserId: params.invitedByUserId ?? null,
      });

      logger.info(
        { invitation_id: row.id, email: params.email, role: params.role },
        "invitation created",
      );

      return {
        token,
        invitationId: row.id,
        email: params.email,
        role: params.role,
        expiresAt,
      };
    },

    /**
     * Revoke an active invitation by setting revoked_at. The invitation must exist, belong to
     * the current tenant, and not already be revoked or consumed.
     *
     * Revocation is immediate: any subsequent use of the raw token will fail because the token
     * acceptor checks for revoked_at IS NULL.
     *
     * @throws HTTPException(404) if the invitation does not exist, is already revoked, or is consumed.
     */
    async revoke(
      tx: TransactionSql,
      invitationId: string,
      logger: Logger,
    ): Promise<RevokeInvitationResult> {
      const rows = await tx`
        UPDATE app.invitations
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ${invitationId}::uuid
          AND school_id = current_setting('app.school_id')::uuid
          AND revoked_at IS NULL
          AND consumed_at IS NULL
        RETURNING id, email, role, revoked_at
      `;

      if (rows.length === 0) {
        throw new HTTPException(404, { message: "Invitation not found" });
      }

      const row = rows[0]!;

      await emitAuditLog(tx, {
        action: "update",
        targetTable: "invitations",
        targetId: row.id,
        oldValues: { revoked_at: null },
        newValues: { revoked_at: row.revoked_at },
      });

      await emit(tx, DOMAIN_EVENTS.INVITATION_REVOKED, {
        invitationId: row.id,
        email: row.email,
        role: row.role,
      });

      logger.info({ invitation_id: row.id, email: row.email }, "invitation revoked");

      return {
        invitationId: row.id,
        email: row.email,
        role: row.role,
        revokedAt: new Date(row.revoked_at),
      };
    },

    /**
     * Regenerate an invitation: atomically revoke the current one and issue a fresh token.
     *
     * This is a single transaction consisting of:
     * 1. SET revoked_at on the old invitation (invalidating the old token).
     * 2. INSERT a new invitation with the same email/role/invitedBy but a new token hash.
     *
     * The partial unique index uq_invitations_active allows the insert once the old row is revoked,
     * and the transaction ensures both writes succeed or neither does.
     *
     * @throws HTTPException(404) if the invitation does not exist, is already revoked, or is consumed.
     */
    async regenerate(
      tx: TransactionSql,
      invitationId: string,
      logger: Logger,
    ): Promise<RegenerateInvitationResult> {
      // Step 1: Revoke the old invitation.
      const revoked = await tx`
        UPDATE app.invitations
        SET revoked_at = CURRENT_TIMESTAMP
        WHERE id = ${invitationId}::uuid
          AND school_id = current_setting('app.school_id')::uuid
          AND revoked_at IS NULL
          AND consumed_at IS NULL
        RETURNING id, email, normalized_email, role, invited_by_user_id, revoked_at
      `;

      if (revoked.length === 0) {
        throw new HTTPException(404, { message: "Invitation not found" });
      }

      const old = revoked[0]!;

      // Step 2: Issue a new token and insert a fresh invitation.
      const token = generateToken();
      const tokenHash = hashToken(token);
      const now = options.now?.() ?? Date.now();
      const expiresAt = new Date(now + defaultExpiryDays * 24 * 60 * 60 * 1000);

      const created = await tx`
        INSERT INTO app.invitations (
          school_id,
          email,
          normalized_email,
          role,
          token_hash,
          invited_by_user_id,
          expires_at
        ) VALUES (
          current_setting('app.school_id')::uuid,
          ${old.email},
          ${old.normalized_email},
          ${old.role}::app.user_role,
          ${tokenHash}::bytea,
          ${old.invited_by_user_id}::uuid,
          ${expiresAt.toISOString()}::timestamptz
        )
        RETURNING id, email, role, expires_at
      `;

      const newRow = created[0]!;

      // Audit: record the revocation of the old invitation.
      await emitAuditLog(tx, {
        action: "update",
        targetTable: "invitations",
        targetId: old.id,
        oldValues: { revoked_at: null },
        newValues: { revoked_at: old.revoked_at },
      });

      // Audit: record the issuance of the new invitation.
      await emitAuditLog(tx, {
        action: "insert",
        targetTable: "invitations",
        targetId: newRow.id,
        newValues: {
          email: old.email,
          role: old.role,
          expires_at: expiresAt.toISOString(),
        },
      });

      // Domain events.
      await emit(tx, DOMAIN_EVENTS.INVITATION_REVOKED, {
        invitationId: old.id,
        email: old.email,
        role: old.role,
      });

      await emit(tx, DOMAIN_EVENTS.INVITATION_SENT, {
        invitationId: newRow.id,
        email: old.email,
        role: old.role,
        expiresAt: expiresAt.toISOString(),
        invitedByUserId: old.invited_by_user_id,
      });

      logger.info(
        { old_invitation_id: old.id, new_invitation_id: newRow.id, email: old.email },
        "invitation regenerated",
      );

      return {
        invitationId: newRow.id,
        token,
        email: old.email,
        role: old.role,
        expiresAt,
        revokedInvitationId: old.id,
        revokedAt: new Date(old.revoked_at),
      };
    },
  };
}
