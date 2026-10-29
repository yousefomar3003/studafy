/**
 * Re-sealing after a records key rotation (ADR-019, decision 6). Once RECORDS_ENCRYPTION_CURRENT_KEY_ID
 * names a new key, every answer still sealed under an older one is opened and sealed again under the
 * current key, in batches, per school. Runs with the daily record retention job; an operator removes
 * an old key from the secret only after this reports zero `remaining` for it.
 */
import { openRecordValue, sealRecordValue } from "@studafy/records";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { PurgeLogger } from "../imports";
import type { RecordFieldType, RecordKeyring, RecordSubjectKind } from "@studafy/records";
import type { Sql } from "postgres";

export const RECORD_RESEAL_BATCH_SIZE = 500;

export interface ResealRecordValuesResult {
  resealed: number;
  failed: number;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function resealRecordValues(
  sql: Sql,
  keyring: RecordKeyring,
  log: PurgeLogger = silentLogger,
): Promise<ResealRecordValuesResult> {
  const result: ResealRecordValuesResult = { resealed: 0, failed: 0 };
  for (const schoolId of await loadSchoolIds(sql)) {
    try {
      let batch = 0;
      do {
        batch = await withSystemTenantTx(sql, { schoolId }, async (tx) => {
          const rows = await tx<
            {
              id: string;
              subject_kind: RecordSubjectKind;
              subject_id: string;
              field_id: string;
              field_type: RecordFieldType;
              value_ciphertext: Uint8Array;
              value_key_id: string;
              value_mask: string;
            }[]
          >`
            SELECT a.id, a.subject_kind, a.subject_id, a.field_id, fv.field_type,
                   a.value_ciphertext, a.value_key_id, a.value_mask
            FROM app.record_answers AS a
            JOIN app.record_field_versions AS fv
              ON fv.id = a.field_version_id AND fv.school_id = a.school_id
            WHERE a.school_id = ${schoolId}::uuid AND a.value_ciphertext IS NOT NULL
              AND a.value_key_id <> ${keyring.currentKeyId}
            ORDER BY a.id
            LIMIT ${RECORD_RESEAL_BATCH_SIZE}
            FOR UPDATE OF a
          `;
          for (const row of rows) {
            const context = {
              schoolId,
              subjectKind: row.subject_kind,
              subjectId: row.subject_id,
              fieldId: row.field_id,
            };
            const opened = openRecordValue(keyring, context, {
              ciphertext: row.value_ciphertext,
              keyId: row.value_key_id,
              mask: row.value_mask,
            });
            const sealed = sealRecordValue(keyring, context, row.field_type, opened.unwrap());
            await tx`
              UPDATE app.record_answers
              SET value_ciphertext = ${sealed.ciphertext}, value_key_id = ${sealed.keyId}
              WHERE school_id = ${schoolId}::uuid AND id = ${row.id}::uuid
            `;
          }
          return rows.length;
        });
        result.resealed += batch;
      } while (batch === RECORD_RESEAL_BATCH_SIZE);
    } catch (error) {
      result.failed += 1;
      // The error names the key id at most (RecordKeyUnavailableError), never a value.
      log.warn(
        { school_id: schoolId, error },
        "record re-seal failed for school; batch rolled back",
      );
    }
  }
  return result;
}
