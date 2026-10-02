/**
 * Ask AI message retention sweep (ST-309).
 *
 * Every app.ai_messages row carries a 90-day `expires_at` (AI_ASK_MESSAGE_RETENTION_DAYS in
 * apps/api/src/modules/ai/config.ts), and migration 000021 ships app.delete_expired_ai_messages()
 * to delete rows past it in batches. Nothing called that function before this sweep, so the
 * retention the privacy documentation states was never applied
 * (docs/compliance/childrens-data-dossier.md). Once a day this runs it per school, one transaction
 * per batch so a large backlog never holds locks in one long transaction.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { PurgeLogger } from "../imports";
import type { Sql } from "postgres";

/** Rows per batch: the function's own default. */
export const AI_MESSAGE_PURGE_BATCH_SIZE = 1000;

export interface PurgeExpiredAiMessagesResult {
  schools: number;
  /** Expired messages deleted across every school. */
  removed: number;
  /** Schools whose purge aborted (database error). The sweep continues with the next school. */
  failed: number;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function purgeExpiredAiMessages(
  sql: Sql,
  log: PurgeLogger = silentLogger,
): Promise<PurgeExpiredAiMessagesResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeExpiredAiMessagesResult = { schools: schoolIds.length, removed: 0, failed: 0 };

  for (const schoolId of schoolIds) {
    try {
      let deleted: number;
      do {
        deleted = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
          const [row] = await tx<{ deleted: number }[]>`
            SELECT app.delete_expired_ai_messages(${AI_MESSAGE_PURGE_BATCH_SIZE}) AS deleted
          `;
          return row!.deleted;
        });
        result.removed += deleted;
      } while (deleted === AI_MESSAGE_PURGE_BATCH_SIZE);
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "expired AI message purge failed for school; batch rolled back and school skipped",
      );
    }
  }

  return result;
}
