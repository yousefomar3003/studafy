/**
 * OAuth provider linking — link and unlink external identity providers for lockout resilience (R-03).
 *
 * An authenticated user can link a second OAuth provider (Google or Microsoft) so that if one
 * provider is unavailable, they can still log in via the other. Admins can unlink a user's provider
 * with the same safety guard: unlinking the last provider is always refused.
 *
 * All mutations are audited inside the caller's tenant transaction.
 */

import { ERROR_CODES } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { emitAuditLog } from "../../../middleware/auditEmitter";

import type { Logger } from "../../../logger";
import type { TransactionSql } from "postgres";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LinkedProvider {
  provider: string;
  linkedAt: Date;
}

export interface ListLinkedProvidersResult {
  providers: LinkedProvider[];
}

export interface LinkProviderParams {
  userId: string;
  schoolId: string;
  provider: string;
  subject: string;
  email: string;
  requestId?: string;
  logger?: Logger;
}

export interface UnlinkProviderParams {
  userId: string;
  schoolId: string;
  provider: string;
  requestId?: string;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ReadonlySet<string> = new Set(["microsoft", "google"]);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

// ---------------------------------------------------------------------------
// List linked providers
// ---------------------------------------------------------------------------

/**
 * Return every OAuth provider linked to the user.
 *
 * Read-only, runs inside the caller's tenant transaction.
 */
export async function listLinkedProviders(
  tx: TransactionSql,
  userId: string,
): Promise<ListLinkedProvidersResult> {
  const rows = await tx<{ provider: string; created_at: Date }[]>`
    SELECT provider, created_at
      FROM app.oauth_identities
     WHERE user_id = ${userId}
       AND school_id = current_setting('app.school_id')::uuid
     ORDER BY created_at
  `;

  return {
    providers: rows.map((row) => ({
      provider: row.provider,
      linkedAt: row.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Complete provider link
// ---------------------------------------------------------------------------

/**
 * Link an external OAuth identity to an existing user account.
 *
 * Validates the provider name, checks the user doesn't already have this provider, inserts the
 * identity row, and writes an audit trail. Runs inside the caller's tenant transaction.
 *
 * @throws CodedHttpException(400) if the provider name is invalid.
 * @throws CodedHttpException(409 OAUTH_IDENTITY_EXISTS) if the identity is already linked to
 *   another user.
 * @throws CodedHttpException(409 CONFLICT_DUPLICATE_ENTRY) if the user already has this provider.
 */
export async function completeProviderLink(
  tx: TransactionSql,
  params: LinkProviderParams,
): Promise<void> {
  const { userId, provider, subject, email, logger } = params;

  if (!VALID_PROVIDERS.has(provider)) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Invalid OAuth provider.");
  }

  // Check if the user already has this provider linked.
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM app.oauth_identities
     WHERE user_id = ${userId}
       AND school_id = current_setting('app.school_id')::uuid
       AND provider = ${provider}
     LIMIT 1
  `;

  if (existing.length > 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
      "This provider is already linked to your account.",
    );
  }

  // Insert the identity. A unique violation on (provider, subject) means this external account
  // is already bound to a different user.
  let identityId: string;
  try {
    const [linked] = await tx<{ id: string }[]>`
      INSERT INTO app.oauth_identities (school_id, user_id, provider, subject)
      VALUES (
        current_setting('app.school_id')::uuid,
        ${userId}::uuid,
        ${provider},
        ${subject}
      )
      RETURNING id
    `;
    identityId = linked!.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.OAUTH_IDENTITY_EXISTS,
        "This external account is already linked to another user.",
      );
    }
    throw error;
  }

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "oauth_identities",
    targetId: identityId,
    newValues: { provider, user_id: userId, email },
  });

  logger?.info(
    { user_id: userId, school_id: params.schoolId, provider, identity_id: identityId },
    "provider linked",
  );
}

// ---------------------------------------------------------------------------
// Unlink provider
// ---------------------------------------------------------------------------

/**
 * Remove an OAuth provider from a user's account.
 *
 * Safety guard: refuses if this is the user's last provider, which would leave them with no
 * way to authenticate. Runs inside the caller's tenant transaction.
 *
 * @throws CodedHttpException(404) if the provider is not linked to this user.
 * @throws CodedHttpException(409 OAUTH_LAST_PROVIDER) if this is the last linked provider.
 */
export async function unlinkProvider(
  tx: TransactionSql,
  params: UnlinkProviderParams,
): Promise<void> {
  const { userId, provider, logger } = params;

  if (!VALID_PROVIDERS.has(provider)) {
    throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, "Invalid OAuth provider.");
  }

  // Count total linked providers for this user.
  const countResult = await tx<{ cnt: string }[]>`
    SELECT count(*)::text AS cnt FROM app.oauth_identities
     WHERE user_id = ${userId}
       AND school_id = current_setting('app.school_id')::uuid
  `;
  const totalCount = Number(countResult[0]!.cnt);

  if (totalCount <= 1) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.OAUTH_LAST_PROVIDER,
      "Cannot unlink the last provider. Link another provider first.",
    );
  }

  // Delete the identity row.
  const deleted = await tx<{ id: string; subject: string }[]>`
    DELETE FROM app.oauth_identities
     WHERE user_id = ${userId}
       AND school_id = current_setting('app.school_id')::uuid
       AND provider = ${provider}
     RETURNING id, subject
  `;

  if (deleted.length === 0) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "Provider not linked.");
  }

  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "oauth_identities",
    targetId: deleted[0]!.id,
    oldValues: { provider, user_id: userId },
  });

  logger?.info({ user_id: userId, school_id: params.schoolId, provider }, "provider unlinked");
}
