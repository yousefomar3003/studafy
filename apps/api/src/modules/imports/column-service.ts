/**
 * Unmapped columns of a student import, and applying one to a record field later
 * (docs/modules/student-import-mapping-guide.md "Import history and unmapped columns").
 *
 * A completed import keeps the cells of the columns its mapping did not read, on the lines whose
 * student it created or updated (and whose parent it created) -- the worker records those ids as it
 * writes them. A column is applied to exactly those people: never anyone matched by a name, email,
 * phone or ID number in the file.
 *
 * Applying is two calls. The preview computes, per person, what would be written (a sensitive value
 * as its mask only) and a token over that outcome; the apply recomputes it, refuses if the token no
 * longer matches, and only then writes. Both halves are the records module's shared column writer
 * (records/column-write-service.ts), which writes through writeAnswers, so values are validated,
 * sealed, audited and counted in the missing-information lists exactly as a record edit's are. The cells are immutable once the import completed, so the token covers what can still
 * change between the two calls -- the field, and each person's current answer -- and never needs to
 * hash a value.
 */

import { ERROR_CODES } from "@studafy/constants";
import { guessColumn, normalizeHeader, unmappedColumns } from "@studafy/student-import";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import {
  columnPlanToken,
  loadSubjectNames,
  planRecordColumn,
  previewEntry,
  resolveColumnTarget,
  writeRecordColumn,
} from "../records/column-write-service";

import { getImport } from "./import-service";

import type { ImportRecord } from "./import-service";
import type {
  ColumnApplyResult,
  ColumnTargetInput,
  ImportColumnPreview,
  UnmappedColumnsResponse,
} from "./schemas";
import type { ColumnPlan, ColumnSubjectCells } from "../records/column-write-service";
import type { RecordKeyring, RecordSubjectKind } from "@studafy/records";
import type { TransactionSql } from "postgres";

/** Whether an import still holds cells to apply: it completed and they have not expired. */
function cellsApplicable(record: ImportRecord): boolean {
  return record.status === "completed" && record.cells_purged_at === null;
}

function expiryOf(record: ImportRecord): string {
  return new Date(record.created_at.getTime() + record.retention_days * 86_400_000).toISOString();
}

interface CellRow {
  line_number: number;
  student_id: string | null;
  parent_user_id: string | null;
  source: Record<string, string>;
}

/**
 * The cells a column can read: a completed import's leftover lines (each tied to the people it
 * wrote), or an unconfirmed import's staging rows, which only feed the suggestions.
 */
async function loadCells(
  tx: TransactionSql,
  schoolId: string,
  record: ImportRecord,
): Promise<CellRow[]> {
  const appliedOnly = record.status === "completed" ? tx`AND student_id IS NOT NULL` : tx``;
  return tx<CellRow[]>`
    SELECT line_number, student_id, parent_user_id, source
    FROM app.student_import_rows
    WHERE school_id = ${schoolId} AND import_id = ${record.id}::uuid
      ${appliedOnly}
    ORDER BY line_number
  `;
}

interface AppliedRow {
  position: number;
  applied_field_id: string | null;
  applied_subject_kind: Extract<RecordSubjectKind, "student" | "parent"> | null;
  applied_count: number | null;
  applied_at: Date | null;
  applied_by_name: string | null;
  label_en: string | null;
  label_ar: string | null;
}

export async function listUnmappedColumns(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
): Promise<UnmappedColumnsResponse> {
  const record = await getImport(tx, schoolId, importId);
  const cells = await loadCells(tx, schoolId, record);
  const applied = await tx<AppliedRow[]>`
    SELECT col.position, col.applied_field_id, col.applied_subject_kind, col.applied_count,
           col.applied_at, actor.display_name AS applied_by_name, field.label_en, field.label_ar
    FROM app.student_import_unmapped_columns AS col
    LEFT JOIN app.users AS actor ON actor.id = col.applied_by AND actor.school_id = col.school_id
    LEFT JOIN app.record_fields AS field
      ON field.id = col.applied_field_id AND field.school_id = col.school_id
    WHERE col.school_id = ${schoolId} AND col.import_id = ${importId}::uuid
  `;
  const appliedByPosition = new Map(applied.map((row) => [row.position, row]));
  const canApply = cellsApplicable(record) && cells.length > 0;

  return {
    import_id: record.id,
    status: record.status,
    cells_available: cells.length > 0,
    can_apply: canApply,
    cells_expire_at: record.status === "completed" && cells.length > 0 ? expiryOf(record) : null,
    columns: unmappedColumns(record.source_headers, record.column_mapping).map((column) => {
      const withValue = cells.filter((cell) => (cell.source[column.header] ?? "").trim() !== "");
      const guess = guessColumn(
        column.header,
        cells.map((cell) => cell.source[column.header] ?? ""),
      );
      const done = appliedByPosition.get(column.position);
      return {
        position: column.position,
        header: column.header,
        non_empty_count: withValue.length,
        student_count: new Set(withValue.flatMap((cell) => cell.student_id ?? [])).size,
        parent_count: new Set(withValue.flatMap((cell) => cell.parent_user_id ?? [])).size,
        suggested_field_type: guess.field_type,
        suggested_options: guess.options,
        suggested_sensitive: guess.sensitive_reason !== null,
        sensitive_reason: guess.sensitive_reason,
        applied:
          done?.applied_field_id && done.applied_subject_kind && done.applied_at
            ? {
                field_id: done.applied_field_id,
                subject_kind: done.applied_subject_kind,
                label_en: done.label_en ?? "",
                label_ar: done.label_ar ?? "",
                count: done.applied_count ?? 0,
                applied_at: done.applied_at.toISOString(),
                applied_by_name: done.applied_by_name,
              }
            : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Preview and apply
// ---------------------------------------------------------------------------

interface ColumnPlanForImport {
  record: ImportRecord;
  header: string;
  plan: ColumnPlan;
  token: string;
}

async function planColumn(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  input: ColumnTargetInput,
): Promise<ColumnPlanForImport> {
  const record = await getImport(tx, schoolId, importId);
  const column = unmappedColumns(record.source_headers, record.column_mapping).find(
    (candidate) => candidate.position === input.position,
  );
  if (!column) {
    throw new CodedHttpException(
      404,
      ERROR_CODES.IMPORT_COLUMN_NOT_FOUND,
      "That column is not an unmapped column of this import.",
    );
  }
  if (record.status !== "completed") {
    throw new CodedHttpException(
      409,
      ERROR_CODES.IMPORT_INVALID_STATE,
      `Import is ${record.status}; a column is applied once the import has completed.`,
    );
  }
  const cells = cellsApplicable(record) ? await loadCells(tx, schoolId, record) : [];
  if (cells.length === 0) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.IMPORT_CELLS_UNAVAILABLE,
      "This import's leftover cells are no longer stored.",
    );
  }
  const target = await resolveColumnTarget(tx, schoolId, input.subject_kind, input);

  // One entry per person this import wrote: the students it created or updated, or the parents
  // it created. A parent of several imported siblings has a cell on each sibling's line.
  const bySubject = new Map<string, ColumnSubjectCells>();
  for (const cell of cells) {
    const subjectId = input.subject_kind === "student" ? cell.student_id : cell.parent_user_id;
    if (!subjectId) continue;
    const entry = bySubject.get(subjectId) ?? { subjectId, line: cell.line_number, cells: [] };
    entry.cells.push(cell.source[column.header] ?? "");
    bySubject.set(subjectId, entry);
  }
  const subjects = [...bySubject.values()];
  const names = await loadSubjectNames(
    tx,
    schoolId,
    input.subject_kind,
    subjects.map((subject) => subject.subjectId),
  );
  const plan = await planRecordColumn(tx, schoolId, {
    kind: input.subject_kind,
    target,
    overwrite: input.overwrite,
    subjects,
    names,
  });
  const token = columnPlanToken(
    {
      import_id: record.id,
      position: column.position,
      subject_kind: input.subject_kind,
      overwrite: input.overwrite,
    },
    plan,
  );
  return { record, header: column.header, plan, token };
}

function toPreview(planned: ColumnPlanForImport, input: ColumnTargetInput): ImportColumnPreview {
  const { target, entries, totals } = planned.plan;
  return {
    import_id: planned.record.id,
    position: input.position,
    header: planned.header,
    subject_kind: input.subject_kind,
    field: {
      id: target.id,
      field_type: target.field_type,
      label_en: target.label_en,
      label_ar: target.label_ar,
      sensitivity: target.sensitivity,
    },
    totals,
    rows: entries.map(previewEntry) as ImportColumnPreview["rows"],
    preview_token: planned.token,
  };
}

/** What applying the column would write, person by person. Writes nothing. */
export async function previewColumn(
  tx: TransactionSql,
  schoolId: string,
  importId: string,
  input: ColumnTargetInput,
): Promise<ImportColumnPreview> {
  return toPreview(await planColumn(tx, schoolId, importId, input), input);
}

/**
 * Write a previewed column. The plan is recomputed and must match the preview token; a new field
 * is created and published in the same transaction (records/column-write-service.ts).
 */
export async function applyColumn(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  importId: string,
  input: ColumnTargetInput & { preview_token: string },
  keyring: RecordKeyring,
): Promise<ColumnApplyResult> {
  // Serializes applies of one import, so two staff cannot write the same column at once.
  await tx`
    SELECT id FROM app.student_imports
    WHERE id = ${importId}::uuid AND school_id = ${schoolId}
    FOR UPDATE
  `;
  const planned = await planColumn(tx, schoolId, importId, input);
  if (planned.token !== input.preview_token) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.IMPORT_COLUMN_PREVIEW_STALE,
      "What this column would write has changed since the preview. Preview it again.",
    );
  }

  const { fieldId, fieldCreated, written } = await writeRecordColumn(
    tx,
    schoolId,
    userId,
    input.subject_kind,
    planned.plan,
    keyring,
  );

  const header = planned.header.slice(0, 500);
  const [previous] = await tx<{ applied_field_id: string | null; applied_count: number | null }[]>`
    SELECT applied_field_id, applied_count FROM app.student_import_unmapped_columns
    WHERE school_id = ${schoolId} AND import_id = ${importId}::uuid AND position = ${input.position}
  `;
  await tx`
    INSERT INTO app.student_import_unmapped_columns (
      school_id, import_id, position, header, normalized_header, applied_field_id,
      applied_subject_kind, applied_count, applied_by, applied_at
    ) VALUES (
      ${schoolId}::uuid, ${importId}::uuid, ${input.position}, ${header},
      ${normalizeHeader(planned.header).slice(0, 500)},
      ${fieldId}::uuid, ${input.subject_kind}::app.record_subject_kind, ${written},
      ${userId}::uuid, CURRENT_TIMESTAMP
    )
    ON CONFLICT (school_id, import_id, position) DO UPDATE SET
      applied_field_id = EXCLUDED.applied_field_id,
      applied_subject_kind = EXCLUDED.applied_subject_kind,
      applied_count = EXCLUDED.applied_count,
      applied_by = EXCLUDED.applied_by,
      applied_at = EXCLUDED.applied_at
  `;
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "student_import_unmapped_columns",
    targetId: importId,
    oldValues: {
      position: input.position,
      field_id: previous?.applied_field_id ?? null,
      written: previous?.applied_count ?? null,
    },
    newValues: {
      position: input.position,
      header,
      subject_kind: input.subject_kind,
      field_id: fieldId,
      field_created: fieldCreated,
      written,
      overwrite: input.overwrite,
    },
  });

  return {
    import_id: importId,
    position: input.position,
    field_id: fieldId,
    field_created: fieldCreated,
    written,
    totals: planned.plan.totals,
  };
}
