import { emitAuditLog } from "../../../middleware/auditEmitter";

import { AI_DATA_SHARING_DISCLOSURE } from "./disclosure";

import type { TransactionSql } from "postgres";

/**
 * Consent store for third-party AI data sharing (ST-305), over app.ai_data_sharing_consents
 * (migration 000117). Every function runs inside the caller's tenant transaction, so RLS scopes it
 * to the school and each write's audit row commits or rolls back with it.
 */

const TABLE = "ai_data_sharing_consents";

export interface AiDataSharingConsent {
  id: string;
  disclosureVersion: string;
  provider: string;
  dataCategories: string[];
  grantedAt: string;
}

interface ConsentRow {
  id: string;
  disclosure_version: string;
  provider: string;
  data_categories: string[];
  granted_at: Date;
}

function toConsent(row: ConsentRow): AiDataSharingConsent {
  return {
    id: row.id,
    disclosureVersion: row.disclosure_version,
    provider: row.provider,
    dataCategories: row.data_categories,
    grantedAt: row.granted_at.toISOString(),
  };
}

async function findLiveRow(tx: TransactionSql, userId: string): Promise<ConsentRow | null> {
  const [row] = await tx<ConsentRow[]>`
    SELECT id, disclosure_version, provider, data_categories, granted_at
    FROM app.ai_data_sharing_consents
    WHERE user_id = ${userId}::uuid AND withdrawn_at IS NULL
  `;
  return row ?? null;
}

async function withdrawRow(tx: TransactionSql, row: ConsentRow): Promise<void> {
  const [updated] = await tx<{ withdrawn_at: Date }[]>`
    UPDATE app.ai_data_sharing_consents
    SET withdrawn_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}::uuid AND withdrawn_at IS NULL
    RETURNING withdrawn_at
  `;
  if (!updated) return;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: TABLE,
    targetId: row.id,
    oldValues: { withdrawn_at: null },
    newValues: { withdrawn_at: updated.withdrawn_at.toISOString() },
  });
}

/**
 * The user's consent for the disclosure currently served, or null. A live row granted against an
 * older disclosure version does not count: the user never agreed to what is disclosed now.
 */
export async function findCurrentConsent(
  tx: TransactionSql,
  userId: string,
): Promise<AiDataSharingConsent | null> {
  const row = await findLiveRow(tx, userId);
  return row && row.disclosure_version === AI_DATA_SHARING_DISCLOSURE.version
    ? toConsent(row)
    : null;
}

/**
 * Record consent to the current disclosure. Idempotent: an existing current consent is returned
 * unchanged. A live consent to an older version is withdrawn first, so history shows it superseded.
 */
export async function grantConsent(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  userAgent: string | null,
): Promise<AiDataSharingConsent> {
  const live = await findLiveRow(tx, userId);
  if (live?.disclosure_version === AI_DATA_SHARING_DISCLOSURE.version) return toConsent(live);
  if (live) await withdrawRow(tx, live);

  const { version, provider, dataCategories } = AI_DATA_SHARING_DISCLOSURE;
  const [row] = await tx<ConsentRow[]>`
    INSERT INTO app.ai_data_sharing_consents
      (school_id, user_id, disclosure_version, provider, data_categories)
    VALUES
      (${schoolId}::uuid, ${userId}::uuid, ${version}, ${provider.id}, ${[...dataCategories]}::text[])
    ON CONFLICT (school_id, user_id) WHERE withdrawn_at IS NULL DO NOTHING
    RETURNING id, disclosure_version, provider, data_categories, granted_at
  `;
  // A concurrent grant (a double tap) won the live slot first; its row is the answer.
  if (!row) return toConsent((await findLiveRow(tx, userId))!);
  const consent = toConsent(row);

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: TABLE,
    targetId: consent.id,
    newValues: {
      user_id: userId,
      disclosure_version: consent.disclosureVersion,
      provider: consent.provider,
      data_categories: consent.dataCategories,
    },
    userAgent,
  });

  return consent;
}

/** Withdraw the user's live consent, if any. Idempotent: nothing live means nothing to record. */
export async function withdrawConsent(tx: TransactionSql, userId: string): Promise<void> {
  const live = await findLiveRow(tx, userId);
  if (live) await withdrawRow(tx, live);
}
