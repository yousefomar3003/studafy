/**
 * Recording a user's acceptance of the Terms of Service and the Privacy Policy (000188).
 *
 * The client names the versions it showed; they must be the current ones (LEGAL_DOCUMENT_VERSIONS),
 * so an acceptance can only ever be recorded for the text the person could actually read. The
 * session that accepted still carries `legal_acceptance_pending` until the client refreshes it:
 * refresh re-reads the user row and mints a token without the claim.
 */

import { ERROR_CODES, LEGAL_DOCUMENT_VERSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../coded-http-exception";

import type { TransactionSql } from "postgres";

export interface LegalAcceptanceStatus {
  /** Whether the user still has to accept the current versions. */
  required: boolean;
  /** The current versions: what the user must accept. */
  termsVersion: string;
  privacyVersion: string;
  /** When the user last accepted any version; null if never. */
  acceptedAt: Date | null;
}

export function legalAcceptanceStatus(row: {
  terms_version: string | null;
  privacy_version: string | null;
  legal_accepted_at: Date | null;
}): LegalAcceptanceStatus {
  return {
    required:
      row.terms_version !== LEGAL_DOCUMENT_VERSIONS.terms ||
      row.privacy_version !== LEGAL_DOCUMENT_VERSIONS.privacy,
    termsVersion: LEGAL_DOCUMENT_VERSIONS.terms,
    privacyVersion: LEGAL_DOCUMENT_VERSIONS.privacy,
    acceptedAt: row.legal_accepted_at,
  };
}

/**
 * Records that the caller accepted `termsVersion` and read `privacyVersion`. Runs in the caller's
 * tenant transaction. Refuses versions that are not current with LEGAL_VERSION_OUTDATED; accepting
 * again is harmless and moves the timestamp on.
 */
export async function acceptLegalDocuments(
  tx: TransactionSql,
  userId: string,
  versions: { termsVersion: string; privacyVersion: string },
): Promise<{ termsVersion: string; privacyVersion: string; acceptedAt: Date }> {
  if (
    versions.termsVersion !== LEGAL_DOCUMENT_VERSIONS.terms ||
    versions.privacyVersion !== LEGAL_DOCUMENT_VERSIONS.privacy
  ) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.LEGAL_VERSION_OUTDATED,
      "The Terms of Service or the Privacy Policy has changed. Read the current version and accept again.",
    );
  }
  const [row] = await tx<{ legal_accepted_at: Date }[]>`
    UPDATE app.users
       SET terms_version = ${versions.termsVersion},
           privacy_version = ${versions.privacyVersion},
           legal_accepted_at = CURRENT_TIMESTAMP
     WHERE id = ${userId}::uuid
    RETURNING legal_accepted_at
  `;
  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, "User not found.");
  }
  return { ...versions, acceptedAt: row.legal_accepted_at };
}
