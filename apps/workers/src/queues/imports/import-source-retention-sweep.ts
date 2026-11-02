/**
 * Student import retention sweep (docs/security/data_retention_and_dsr_policy.md "Student import
 * files").
 *
 * An import's original file and its leftover cells (the unmapped columns a completed import keeps,
 * see worker.ts) hold many people's data in one place, and a per-person erasure cannot redact
 * inside a file. So they are kept a fixed time only: the school's app.student_import_settings
 * period, 180 days when it has set none (and never longer), counted from the upload. Once a day, per
 * school, in the same IMPORTS job as the abandoned-import purge: files past it are deleted from
 * storage and forgotten on the import row (which, with its summary and history, stays), and the
 * leftover cells of imports past it are deleted.
 */

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { PurgeLogger } from "./abandoned-import-sweep";
import type { Sql } from "postgres";

/** Must match apps/api's DEFAULT_SOURCE_RETENTION_DAYS (modules/imports/source-service.ts). */
export const DEFAULT_IMPORT_SOURCE_RETENTION_DAYS = 180;

export interface ImportSourceRemover {
  remove(key: string): Promise<void>;
}

export interface PurgeExpiredImportSourcesResult {
  schools: number;
  /** Original files deleted across every school. */
  files: number;
  /** Imports whose leftover cells were deleted. */
  cellImports: number;
  /** Schools whose sweep aborted (database error); the sweep continues with the next school. */
  failed: number;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

async function sweepSchool(
  sql: Sql,
  schoolId: string,
  now: Date,
): Promise<{ keys: string[]; cellImports: number }> {
  return withSystemTenantTx(sql, { schoolId }, async (tx) => {
    const [settings] = await tx<{ days: number }[]>`
      SELECT least(
        coalesce(
          (SELECT source_retention_days FROM app.student_import_settings
           WHERE school_id = ${schoolId}::uuid),
          ${DEFAULT_IMPORT_SOURCE_RETENTION_DAYS}
        ),
        ${DEFAULT_IMPORT_SOURCE_RETENTION_DAYS}
      )::int AS days
    `;
    const cutoff = new Date(now.getTime() - settings!.days * 86_400_000);

    const files = await tx<{ id: string; storage_key: string; size_bytes: string }[]>`
      SELECT id, source_storage_key AS storage_key, source_size_bytes::text AS size_bytes
      FROM app.student_imports
      WHERE school_id = ${schoolId}::uuid
        AND source_storage_key IS NOT NULL
        AND source_uploaded_at <= ${cutoff}
      FOR UPDATE
    `;
    if (files.length > 0) {
      await tx`
        UPDATE app.student_imports
        SET source_storage_key = NULL,
            source_size_bytes = NULL,
            source_removed_at = ${now},
            source_removed_reason = 'retention',
            updated_at = ${now}
        WHERE school_id = ${schoolId}::uuid AND id = ANY(${files.map((file) => file.id)}::uuid[])
      `;
      const bytes = files.reduce((total, file) => total + Number(file.size_bytes), 0);
      if (bytes > 0) await tx`SELECT app.add_storage_usage(${-bytes})`;
    }

    // Only a completed import keeps leftover cells past the 48-hour abandoned-import window.
    const purged = await tx<{ import_id: string }[]>`
      DELETE FROM app.student_import_rows AS cell
      USING app.student_imports AS import
      WHERE cell.school_id = ${schoolId}::uuid
        AND import.school_id = cell.school_id
        AND import.id = cell.import_id
        AND import.status = 'completed'
        AND import.created_at <= ${cutoff}
      RETURNING cell.import_id
    `;
    const cellImports = [...new Set(purged.map((row) => row.import_id))];
    if (cellImports.length > 0) {
      await tx`
        UPDATE app.student_imports
        SET cells_purged_at = ${now}, updated_at = ${now}
        WHERE school_id = ${schoolId}::uuid AND id = ANY(${cellImports}::uuid[])
      `;
    }
    return { keys: files.map((file) => file.storage_key), cellImports: cellImports.length };
  });
}

export async function purgeExpiredImportSources(
  sql: Sql,
  storage: ImportSourceRemover | null,
  now: Date = new Date(),
  log: PurgeLogger = silentLogger,
): Promise<PurgeExpiredImportSourcesResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: PurgeExpiredImportSourcesResult = {
    schools: schoolIds.length,
    files: 0,
    cellImports: 0,
    failed: 0,
  };
  for (const schoolId of schoolIds) {
    try {
      const swept = await sweepSchool(sql, schoolId, now);
      result.files += swept.keys.length;
      result.cellImports += swept.cellImports;
      // After commit: a failed delete leaves an unreferenced object, which storage-quota
      // reconciliation reports; a delete before commit could lose a file the row still names.
      for (const key of swept.keys) {
        try {
          await storage?.remove(key);
        } catch {
          // Unreferenced now; see above.
        }
      }
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "import source retention sweep failed for school; rolled back and skipped",
      );
    }
  }
  return result;
}
