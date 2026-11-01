/**
 * "Keep as a record field" for the staff (users) and class CSV imports
 * (docs/modules/student-records.md "Columns kept as record fields").
 *
 * Those imports run in the browser: the file is parsed there and each valid line is created through
 * the entity's own create endpoint (POST /api/users, POST /api/academics/classes). A column the
 * import does not know is offered as a record field afterwards, for the lines the import created:
 * the browser sends the column's header, and for each created line the id its create call returned
 * and the line's cell.
 *
 * The browser's word that a subject came from this import is not taken on trust. A subject is
 * written only when the audit log shows the caller inserted it (users / classes) within the last 24
 * hours, and a staff subject must hold a staff role; anything else is listed as skipped. So the
 * column reaches exactly the rows this import created, never a person matched by a name, email,
 * phone or ID number in the file -- the cell values are never used to find anyone.
 *
 * Preview, then apply, through the records module's shared column writer
 * (column-write-service.ts): nothing is written without a preview and a matching token.
 */

import { ERROR_CODES, SCHOOL_STAFF_ROLES } from "@studafy/constants";
import { guessColumn } from "@studafy/student-import";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

import {
  columnPlanToken,
  loadSubjectNames,
  planRecordColumn,
  previewEntry,
  resolveColumnTarget,
  writeRecordColumn,
} from "./column-write-service";

import type { ColumnPlan, ColumnSubjectCells, ColumnTargetInput } from "./column-write-service";
import type {
  RecordImportApplyResult,
  RecordImportColumnInput,
  RecordImportPreview,
} from "./schemas";
import type { RecordKeyring } from "@studafy/records";
import type { TransactionSql } from "postgres";

export type RecordImportKind = "staff" | "class";

/** How long after creating a row its import may still keep a column for it. */
export const RECORD_IMPORT_WINDOW_HOURS = 24;

/** The audit-log table whose insert proves the caller created the subject. */
const CREATED_IN: Readonly<Record<RecordImportKind, string>> = {
  staff: "users",
  class: "classes",
};

type SkipReason = "NOT_CREATED_BY_IMPORT" | "NOT_STAFF";

/** Of these subjects, the ones the caller itself created within the window. */
async function createdByCaller(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordImportKind,
  ids: readonly string[],
): Promise<Set<string>> {
  const rows = await tx<{ target_id: string }[]>`
    SELECT DISTINCT target_id
    FROM app.audit_logs
    WHERE school_id = ${schoolId}::uuid
      AND target_table = ${CREATED_IN[kind]}
      AND action = 'insert'
      AND target_id = ANY(${[...ids]}::uuid[])
      AND actor_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      AND created_at >= CURRENT_TIMESTAMP - make_interval(hours => ${RECORD_IMPORT_WINDOW_HOURS})
  `;
  return new Set(rows.map((row) => row.target_id));
}

async function holdingStaffRole(
  tx: TransactionSql,
  schoolId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const rows = await tx<{ user_id: string }[]>`
    SELECT DISTINCT user_id
    FROM app.user_roles
    WHERE school_id = ${schoolId}::uuid
      AND user_id = ANY(${[...ids]}::uuid[])
      AND role::text = ANY(${[...SCHOOL_STAFF_ROLES]}::text[])
  `;
  return new Set(rows.map((row) => row.user_id));
}

interface RecordImportPlan {
  plan: ColumnPlan;
  skipped: { subject_id: string; line: number; reason: SkipReason }[];
  empty: number;
  suggestedSensitive: boolean;
  sensitiveReason: "label" | "values" | null;
  token: string;
}

/** The target the request names, with a new field's type, choices and sensitivity guessed. */
function targetInput(
  kind: RecordImportKind,
  input: RecordImportColumnInput,
  guess: ReturnType<typeof guessColumn>,
): ColumnTargetInput {
  if (input.field_id) return { field_id: input.field_id };
  const draft = input.new_field!;
  const fieldType = draft.field_type ?? guess.field_type;
  return {
    new_field: {
      field_type: fieldType,
      label_en: draft.label_en,
      label_ar: draft.label_ar,
      options: draft.options ?? (fieldType === guess.field_type ? guess.options : []),
      // A suggested sensitive field starts sensitive; the school can say otherwise. A class field
      // is never sensitive.
      sensitivity:
        kind === "class"
          ? "standard"
          : (draft.sensitivity ?? (guess.sensitive_reason ? "sensitive" : "standard")),
      visibility: draft.visibility,
    },
  };
}

async function planImportColumn(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordImportKind,
  input: RecordImportColumnInput,
): Promise<RecordImportPlan> {
  // One entry per subject, in file order. A subject repeated on several lines must agree.
  const bySubject = new Map<string, ColumnSubjectCells>();
  for (const row of input.rows) {
    const entry = bySubject.get(row.subject_id) ?? {
      subjectId: row.subject_id,
      line: row.line,
      cells: [],
    };
    entry.cells.push(row.value);
    entry.line = Math.min(entry.line, row.line);
    bySubject.set(row.subject_id, entry);
  }
  const ids = [...bySubject.keys()];
  const created = await createdByCaller(tx, schoolId, kind, ids);
  const staff = kind === "staff" ? await holdingStaffRole(tx, schoolId, ids) : null;

  const eligible: ColumnSubjectCells[] = [];
  const skipped: RecordImportPlan["skipped"] = [];
  let empty = 0;
  for (const subject of bySubject.values()) {
    const reason: SkipReason | null = !created.has(subject.subjectId)
      ? "NOT_CREATED_BY_IMPORT"
      : staff && !staff.has(subject.subjectId)
        ? "NOT_STAFF"
        : null;
    if (reason === null) {
      eligible.push(subject);
    } else if (subject.cells.every((cell) => cell.trim() === "")) {
      empty++; // Nothing would be written for it either way.
    } else {
      skipped.push({ subject_id: subject.subjectId, line: subject.line, reason });
    }
  }

  // A new field's type is guessed from the cells it would hold: the eligible rows' only.
  const guess = guessColumn(
    input.header,
    eligible.flatMap((subject) => subject.cells),
  );
  const target = await resolveColumnTarget(tx, schoolId, kind, targetInput(kind, input, guess));

  const names = await loadSubjectNames(tx, schoolId, kind, ids);
  const plan = await planRecordColumn(tx, schoolId, {
    kind,
    target,
    overwrite: input.overwrite,
    subjects: eligible,
    names,
  });
  const token = columnPlanToken(
    {
      subject_kind: kind,
      header: input.header,
      overwrite: input.overwrite,
      skipped: skipped.map((entry) => entry.subject_id),
    },
    plan,
  );
  return {
    plan,
    skipped,
    empty,
    suggestedSensitive: kind !== "class" && guess.sensitive_reason !== null,
    sensitiveReason: kind === "class" ? null : guess.sensitive_reason,
    token,
  };
}

function totalsOf(planned: RecordImportPlan): RecordImportPreview["totals"] {
  return {
    ...planned.plan.totals,
    empty: planned.plan.totals.empty + planned.empty,
    skipped: planned.skipped.length,
  };
}

/** What keeping the column would write, row by row. Writes nothing. */
export async function previewRecordImportColumn(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordImportKind,
  input: RecordImportColumnInput,
): Promise<RecordImportPreview> {
  const planned = await planImportColumn(tx, schoolId, kind, input);
  const { target, entries } = planned.plan;
  const names = await loadSubjectNames(
    tx,
    schoolId,
    kind,
    planned.skipped.map((entry) => entry.subject_id),
  );
  const rows: RecordImportPreview["rows"] = [
    ...entries.map((entry) => {
      const { admission_number: _admission, ...row } = previewEntry(entry);
      return row as RecordImportPreview["rows"][number];
    }),
    ...planned.skipped.map((entry) => ({
      line_number: entry.line,
      subject_id: entry.subject_id,
      name: names.get(entry.subject_id)?.name ?? "",
      status: "skipped" as const,
      replaces_existing: false,
      value: null,
      mask: null,
      current_value: null,
      current_mask: null,
      reason: entry.reason,
    })),
  ].sort((a, b) => a.line_number - b.line_number);

  return {
    subject_kind: kind,
    header: input.header,
    field: {
      id: target.id,
      field_type: target.field_type,
      label_en: target.label_en,
      label_ar: target.label_ar,
      options: target.options,
      sensitivity: target.sensitivity,
      visibility: target.visibility,
    },
    suggested_sensitive: planned.suggestedSensitive,
    sensitive_reason: planned.sensitiveReason,
    totals: totalsOf(planned),
    rows,
    preview_token: planned.token,
  };
}

/** Write a previewed column. The plan is recomputed and must match the preview's token. */
export async function applyRecordImportColumn(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  kind: RecordImportKind,
  input: RecordImportColumnInput & { preview_token: string },
  keyring: RecordKeyring,
): Promise<RecordImportApplyResult> {
  const planned = await planImportColumn(tx, schoolId, kind, input);
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
    kind,
    planned.plan,
    keyring,
  );
  // Each answer's own audit row came from writeAnswers; this one records the column as a whole,
  // by header and counts, never a value.
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "record_answers",
    targetId: fieldId,
    newValues: {
      import_column: input.header.slice(0, 500),
      subject_kind: kind,
      field_id: fieldId,
      field_created: fieldCreated,
      written,
      skipped: planned.skipped.length,
      overwrite: input.overwrite,
    },
  });
  return {
    subject_kind: kind,
    field_id: fieldId,
    field_created: fieldCreated,
    written,
    totals: totalsOf(planned),
  };
}
