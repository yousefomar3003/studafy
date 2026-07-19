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
  };
}
