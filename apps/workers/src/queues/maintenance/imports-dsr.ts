/**
 * Student import files and leftover cells in the GDPR pipeline (docs/security/
 * data_retention_and_dsr_policy.md "Student import files").
 *
 * An import's original file (app.student_imports.source_storage_key) holds every person in the
 * school's upload in one object. Per person it can be neither searched nor redacted, so:
 *
 *   - a tenant closure deletes every original file and every leftover cell;
 *   - a per-person erasure deletes that person's leftover cells (they are tied to the student or
 *     parents the import wrote, app.student_import_rows.student_id / parent_user_id /
 *     parent2_user_id) and records the
 *     files as retained, with the retention period that bounds them;
 *   - a per-person export cannot include what is inside the files, and says so in knownGaps.
 *
 * Both are bounded anyway: the daily import sweep deletes files and cells once the school's import
 * retention period (180 days at most) has passed.
 */

import type { RetainedTableEntry } from "./dsr-types";
import type { SubjectIdentifiers } from "./subject-resolver";
import type { TransactionSql } from "postgres";

export const IMPORT_FILES_RETAINED_REASON =
  "original student import files hold many people's data and cannot be redacted per person; " +
  "they are deleted automatically when the school's import retention period (at most 180 days " +
  "after upload) ends, or when the school closes";

export const IMPORT_FILES_EXPORT_GAP =
  "app.student_imports: the original files schools uploaded to the student import are not " +
  "searched per person, so anything about this person inside them is not in this bundle. They " +
  "are deleted automatically at most 180 days after upload (sooner if the school set a shorter " +
  "period). Leftover cells tied to this person as a student are included under " +
  "app.student_import_rows; those tied to them as a parent are not.";

export interface ImportErasure {
  /** Leftover cell rows deleted. */
  rows: number;
  /** Original files to delete once the erasure transaction has committed. */
  storageKeys: string[];
  retained: RetainedTableEntry[];
}

export async function eraseImportData(
  tx: TransactionSql,
  schoolId: string,
  subject: SubjectIdentifiers | undefined,
): Promise<ImportErasure> {
  if (subject) {
    const deleted = await tx`
      DELETE FROM app.student_import_rows
      WHERE school_id = ${schoolId}::uuid
        AND (parent_user_id = ${subject.userId}::uuid
             OR parent2_user_id = ${subject.userId}::uuid
             ${subject.studentId ? tx`OR student_id = ${subject.studentId}::uuid` : tx``})
    `;
    const [held] = await tx<{ held: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM app.student_imports
        WHERE school_id = ${schoolId}::uuid AND source_storage_key IS NOT NULL
      ) AS held
    `;
    return {
      rows: deleted.count,
      storageKeys: [],
      retained: held?.held
        ? [{ table: "student_imports", reason: IMPORT_FILES_RETAINED_REASON }]
        : [],
    };
  }

  const files = await tx<{ storage_key: string }[]>`
    UPDATE app.student_imports AS import
    SET source_storage_key = NULL,
        source_size_bytes = NULL,
        source_removed_at = CURRENT_TIMESTAMP,
        source_removed_reason = 'erasure',
        updated_at = CURRENT_TIMESTAMP
    FROM (
      SELECT id, source_storage_key FROM app.student_imports
      WHERE school_id = ${schoolId}::uuid AND source_storage_key IS NOT NULL
      FOR UPDATE
    ) AS held
    WHERE import.school_id = ${schoolId}::uuid AND import.id = held.id
    RETURNING held.source_storage_key AS storage_key
  `;
  const deleted = await tx`
    DELETE FROM app.student_import_rows WHERE school_id = ${schoolId}::uuid
  `;
  await tx`
    UPDATE app.student_imports
    SET cells_purged_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND status = 'completed' AND cells_purged_at IS NULL
  `;
  return {
    rows: deleted.count,
    storageKeys: files.map((row) => row.storage_key),
    retained: [],
  };
}
