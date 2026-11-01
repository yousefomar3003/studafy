/**
 * Records the unmapped columns of imports that have none recorded (docs/modules/
 * student-import-mapping-guide.md "Product signal").
 *
 * The API writes app.student_import_unmapped_columns at upload and re-map. Imports uploaded before
 * migration 000174 -- or by an API instance still running the previous release during a deploy --
 * have no rows, so the platform's cross-school unmapped-header count would miss them. Once a day, in
 * the same IMPORTS job as the abandoned-import purge, this computes their unmapped columns from the
 * stored header row and mapping snapshot with the same function the API uses and inserts them.
 * Header text only: no cell is read.
 *
 * Idempotent: an import that already has rows is never touched, and the insert ignores conflicts.
 * An import whose every column was mapped legitimately has no rows and is re-checked each day; that
 * is one small query per school and pure computation on header text.
 */

import { unmappedColumns } from "@studafy/student-import";

import { withSystemTenantTx } from "../../db/tenant-tx";
import { loadSchoolIds } from "../notifications/email/schools";

import type { PurgeLogger } from "./abandoned-import-sweep";
import type { ColumnMapping } from "@studafy/student-import";
import type { JSONValue, Sql } from "postgres";

export interface BackfillUnmappedColumnsResult {
  schools: number;
  /** Imports that gained unmapped-column rows. */
  imports: number;
  failed: number;
}

const silentLogger: PurgeLogger = { warn: () => undefined };

export async function backfillUnmappedColumns(
  sql: Sql,
  log: PurgeLogger = silentLogger,
): Promise<BackfillUnmappedColumnsResult> {
  const schoolIds = await loadSchoolIds(sql);
  const result: BackfillUnmappedColumnsResult = {
    schools: schoolIds.length,
    imports: 0,
    failed: 0,
  };

  for (const schoolId of schoolIds) {
    try {
      result.imports += await withSystemTenantTx(sql, { schoolId }, async (tx) => {
        const candidates = await tx<
          { id: string; source_headers: string[]; column_mapping: ColumnMapping }[]
        >`
          SELECT import.id, import.source_headers, import.column_mapping
          FROM app.student_imports AS import
          WHERE import.school_id = ${schoolId}::uuid
            AND NOT EXISTS (
              SELECT 1 FROM app.student_import_unmapped_columns AS col
              WHERE col.school_id = import.school_id AND col.import_id = import.id
            )
        `;
        let filled = 0;
        for (const candidate of candidates) {
          const columns = unmappedColumns(
            Array.isArray(candidate.source_headers) ? candidate.source_headers : [],
            candidate.column_mapping ?? {},
          ).map((column) => ({
            position: column.position,
            header: column.header.slice(0, 500),
            normalized_header: column.normalized_header.slice(0, 500),
          }));
          if (columns.length === 0) continue;
          await tx`
            INSERT INTO app.student_import_unmapped_columns
              (school_id, import_id, position, header, normalized_header)
            SELECT ${schoolId}::uuid, ${candidate.id}::uuid, col.position, col.header,
                   col.normalized_header
            FROM jsonb_to_recordset(${tx.json(columns as unknown as JSONValue)}::jsonb)
              AS col (position int, header text, normalized_header text)
            ON CONFLICT (school_id, import_id, position) DO NOTHING
          `;
          filled++;
        }
        return filled;
      });
    } catch (error) {
      result.failed += 1;
      log.warn(
        { school_id: schoolId, error },
        "unmapped column backfill failed for school; rolled back and skipped",
      );
    }
  }
  return result;
}
