/**
 * Writing one imported column of values into a record field, for the people (or classes) an import
 * itself created or updated (docs/modules/student-records.md "Columns kept as record fields").
 *
 * Shared by the student import's unmapped columns (modules/imports/column-service.ts) and the staff
 * and class CSV imports (record-import-service.ts). Each caller decides which subjects a column
 * may reach -- always the ones its import wrote, never anyone matched by a name, email, phone or ID
 * number -- and hands this module one entry per subject with that subject's cells. From there the
 * flow is the same:
 *
 *   - resolveColumnTarget: an existing field on the published form, or a new field to create;
 *   - planRecordColumn: per subject, what would be written (a sensitive value as its mask only),
 *     without writing anything;
 *   - columnPlanToken: a hash over the field identity and each subject's outcome -- never a value
 *     -- that the apply must present, so nothing is written that was not previewed;
 *   - writeRecordColumn: creates and publishes a new field if asked (refused while the template
 *     draft holds other changes), then writes through the records module's own writeAnswers, so
 *     values are validated, sealed, audited and counted in the missing-information lists exactly as
 *     a record edit's are.
 */

import { createHash } from "node:crypto";

import { ERROR_CODES } from "@studafy/constants";
import {
  RECORD_SUBJECT_FIELD_RULES,
  maskRecordValue,
  normalizeRecordValue,
} from "@studafy/records";

import { CodedHttpException } from "../../coded-http-exception";

import { subjectColumn, writeAnswers } from "./record-service";
import { createField, getPublishedForm, getTemplate, publishTemplate } from "./template-service";

import type {
  RecordFieldOption,
  RecordFieldSensitivity,
  RecordFieldType,
  RecordFieldVisibility,
  RecordKeyring,
  RecordSubjectKind,
  RecordValue,
} from "@studafy/records";
import type { TransactionSql } from "postgres";

/** A field to create for the column: everything but its place in the form. */
export interface NewColumnField {
  field_type: Exclude<RecordFieldType, "document">;
  label_en: string;
  label_ar: string;
  options: RecordFieldOption[];
  sensitivity: RecordFieldSensitivity;
  visibility: RecordFieldVisibility;
}

export interface ColumnTargetInput {
  field_id?: string | null;
  new_field?: NewColumnField | null;
}

/** The field a column is written to: one on the published form, or one to be created. */
export interface ColumnTargetField {
  id: string | null;
  field_version_id: string | null;
  field_type: Exclude<RecordFieldType, "document">;
  label_en: string;
  label_ar: string;
  options: RecordFieldOption[];
  sensitivity: RecordFieldSensitivity;
  visibility: RecordFieldVisibility;
}

/** One subject's cells for the column, and the first file line they came from. */
export interface ColumnSubjectCells {
  subjectId: string;
  line: number;
  cells: string[];
}

export type ColumnEntryStatus = "write" | "unchanged" | "kept" | "invalid" | "conflict";

export interface ColumnPlanEntry {
  line_number: number;
  subject_id: string;
  name: string;
  admission_number: string | null;
  status: ColumnEntryStatus;
  replaces_existing: boolean;
  value: RecordValue | null;
  mask: string | null;
  current_value: RecordValue | null;
  current_mask: string | null;
  reason: string | null;
  /** The normalized value to write; set when status is "write". Never returned to a client. */
  write_value: RecordValue | null;
}

export interface ColumnTotals {
  write: number;
  unchanged: number;
  kept: number;
  invalid: number;
  empty: number;
  conflict: number;
}

export interface ColumnPlan {
  target: ColumnTargetField;
  entries: ColumnPlanEntry[];
  totals: ColumnTotals;
}

function fieldInvalid(message: string): never {
  throw new CodedHttpException(422, ERROR_CODES.RECORD_FIELD_INVALID, message);
}

export async function resolveColumnTarget(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  input: ColumnTargetInput,
): Promise<ColumnTargetField> {
  if (input.field_id) {
    const form = await getPublishedForm(tx, schoolId, kind);
    const field = form.fields.find((candidate) => candidate.id === input.field_id);
    if (!field) {
      throw new CodedHttpException(
        404,
        ERROR_CODES.RECORD_FIELD_NOT_FOUND,
        "Field is not on the published form",
      );
    }
    if (field.field_type === "document") {
      fieldInvalid("A document field takes uploaded files, not a column of values");
    }
    return {
      id: field.id,
      field_version_id: field.field_version_id,
      field_type: field.field_type,
      label_en: field.label_en,
      label_ar: field.label_ar,
      options: field.options,
      sensitivity: field.sensitivity,
      visibility: field.visibility,
    };
  }
  const draft = input.new_field;
  if (!draft) fieldInvalid("Choose an existing field or describe a new one");
  const isChoice = draft.field_type === "single_choice" || draft.field_type === "multi_choice";
  if (isChoice && draft.options.length === 0) {
    fieldInvalid("A choice field needs at least one option");
  }
  if (!isChoice && draft.options.length > 0) fieldInvalid("Only choice fields have options");
  if (new Set(draft.options.map((option) => option.value)).size !== draft.options.length) {
    fieldInvalid("Option values must be unique");
  }
  // The template's own rules, checked here so the preview refuses what the apply would.
  const rules = RECORD_SUBJECT_FIELD_RULES[kind];
  if (!rules.visibilities.includes(draft.visibility)) {
    fieldInvalid(`A ${kind} field's visibility is one of: ${rules.visibilities.join(", ")}`);
  }
  if (!rules.sensitive && draft.sensitivity === "sensitive") {
    fieldInvalid(`A ${kind} field cannot be sensitive`);
  }
  return {
    id: null,
    field_version_id: null,
    field_type: draft.field_type,
    label_en: draft.label_en.trim(),
    label_ar: draft.label_ar.trim(),
    options: draft.options,
    sensitivity: draft.sensitivity,
    visibility: draft.visibility,
  };
}

export interface SubjectName {
  id: string;
  name: string;
  admission_number: string | null;
}

/**
 * What a preview calls each subject, read under the caller's row scope: a subject the caller cannot
 * see is absent, and the planner leaves it out.
 */
export async function loadSubjectNames(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  ids: readonly string[],
): Promise<Map<string, SubjectName>> {
  if (ids.length === 0) return new Map();
  const list = [...ids];
  const rows =
    kind === "student"
      ? await tx<SubjectName[]>`
          SELECT id, concat_ws(' ', first_name, last_name) AS name, admission_number
          FROM app.students
          WHERE school_id = ${schoolId}::uuid AND id = ANY(${list}::uuid[])
        `
      : kind === "class"
        ? await tx<SubjectName[]>`
            SELECT c.id, concat_ws(' ', c.code, co.name) AS name, NULL::text AS admission_number
            FROM app.classes AS c
            JOIN app.courses AS co ON co.id = c.course_id AND co.school_id = c.school_id
            WHERE c.school_id = ${schoolId}::uuid AND c.id = ANY(${list}::uuid[])
          `
        : await tx<SubjectName[]>`
            SELECT id, coalesce(display_name, email, '') AS name, NULL::text AS admission_number
            FROM app.users
            WHERE school_id = ${schoolId}::uuid AND id = ANY(${list}::uuid[])
          `;
  return new Map(rows.map((row) => [row.id, row]));
}

interface CurrentAnswer {
  subject_id: string;
  value: RecordValue | null;
  sealed: boolean;
  value_mask: string | null;
}

function sameValue(a: RecordValue | null, b: RecordValue | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What writing the column would do, subject by subject. A subject with no non-empty cell counts as
 * empty and is left out of the entries. A subject with several cells (a parent of imported
 * siblings) must have them agree, or nothing is written for it.
 */
export async function planRecordColumn(
  tx: TransactionSql,
  schoolId: string,
  input: {
    kind: RecordSubjectKind;
    target: ColumnTargetField;
    overwrite: boolean;
    subjects: readonly ColumnSubjectCells[];
    names: ReadonlyMap<string, SubjectName>;
  },
): Promise<ColumnPlan> {
  const { kind, target } = input;
  const subjectIds = input.subjects.map((subject) => subject.subjectId);

  const current = new Map<string, CurrentAnswer>();
  if (target.id && subjectIds.length > 0) {
    const column = tx(subjectColumn({ kind }));
    const rows = await tx<CurrentAnswer[]>`
      SELECT ${column} AS subject_id, value, value_ciphertext IS NOT NULL AS sealed, value_mask
      FROM app.record_answers
      WHERE school_id = ${schoolId}::uuid
        AND subject_kind = ${kind}::app.record_subject_kind
        AND field_id = ${target.id}::uuid
        AND ${column} = ANY(${subjectIds}::uuid[])
    `;
    for (const row of rows) current.set(row.subject_id, row);
  }

  const sensitive = target.sensitivity === "sensitive";
  const totals: ColumnTotals = {
    write: 0,
    unchanged: 0,
    kept: 0,
    invalid: 0,
    empty: 0,
    conflict: 0,
  };
  const entries: ColumnPlanEntry[] = [];
  for (const { subjectId, line, cells } of input.subjects) {
    const person = input.names.get(subjectId);
    if (!person) continue; // Not visible to this caller, or gone since the import.
    const values = cells.map((cell) => cell.trim()).filter((cell) => cell !== "");
    const previous = current.get(subjectId);
    const hasPrevious = previous !== undefined && (previous.value !== null || previous.sealed);

    let status: ColumnEntryStatus | "empty";
    let reason: string | null = null;
    let value: RecordValue | null = null;
    const normalized = values.map((raw) => normalizeRecordValue(target, raw));
    const firstInvalid = normalized.find((result) => !result.ok);
    if (values.length === 0) {
      status = "empty";
    } else if (firstInvalid && !firstInvalid.ok) {
      status = "invalid";
      reason = firstInvalid.error;
    } else {
      const okValues = normalized.flatMap((result) => (result.ok ? [result.value] : []));
      value = okValues[0] ?? null;
      if (okValues.some((candidate) => !sameValue(candidate, value))) {
        status = "conflict";
        reason = "CONFLICTING_VALUES";
        value = null;
      } else if (value === null) {
        status = "empty";
      } else if (!hasPrevious) {
        status = "write";
      } else if (!previous!.sealed && sameValue(previous!.value, value)) {
        status = "unchanged";
      } else {
        status = input.overwrite ? "write" : "kept";
      }
    }
    totals[status]++;
    if (status === "empty") continue;

    const show = status === "write" || status === "unchanged" || status === "kept";
    entries.push({
      line_number: line,
      subject_id: subjectId,
      name: person.name,
      admission_number: person.admission_number,
      status,
      replaces_existing: status === "write" && hasPrevious,
      // A sensitive value is shown as its mask only (ADR-019), here as everywhere else.
      value: show && !sensitive ? value : null,
      mask: show && sensitive && value !== null ? maskRecordValue(target.field_type, value) : null,
      current_value: hasPrevious && !previous!.sealed && !sensitive ? previous!.value : null,
      current_mask: hasPrevious
        ? (previous!.value_mask ??
          (sensitive && previous!.value !== null
            ? maskRecordValue(target.field_type, previous!.value)
            : null))
        : null,
      reason,
      write_value: status === "write" ? value : null,
    });
  }
  entries.sort((a, b) => a.line_number - b.line_number);
  return { target, entries, totals };
}

/**
 * The token a preview hands out and an apply must present. It covers the caller's scope (which
 * import, which column), the field's identity, and each subject's outcome -- what can change
 * between the two calls -- and never a value.
 */
export function columnPlanToken(scope: Record<string, unknown>, plan: ColumnPlan): string {
  const { target } = plan;
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...scope,
        field: target.id
          ? { id: target.id, version: target.field_version_id }
          : {
              field_type: target.field_type,
              options: target.options,
              sensitivity: target.sensitivity,
              visibility: target.visibility,
            },
        entries: plan.entries.map((entry) => [entry.subject_id, entry.status]),
      }),
    )
    .digest("hex");
}

/** A plan entry as a preview returns it: without the value it would write. */
export function previewEntry({
  write_value: _write,
  ...entry
}: ColumnPlanEntry): Omit<ColumnPlanEntry, "write_value"> {
  return entry;
}

/**
 * Write a previewed plan. A new field is created and published first, in the same transaction,
 * which is refused while the template draft holds other unpublished changes: publishing here must
 * publish this field and nothing else.
 */
export async function writeRecordColumn(
  tx: TransactionSql,
  schoolId: string,
  userId: string,
  kind: RecordSubjectKind,
  plan: ColumnPlan,
  keyring: RecordKeyring,
): Promise<{ fieldId: string; fieldCreated: boolean; written: number }> {
  let fieldId = plan.target.id;
  if (fieldId === null) {
    const template = await getTemplate(tx, schoolId, kind);
    if (template.has_unpublished_changes) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.IMPORT_RECORD_DRAFT_PENDING,
        "The record template has unpublished changes. Publish or undo them first.",
      );
    }
    const created = await createField(tx, schoolId, kind, userId, {
      field_type: plan.target.field_type,
      label_en: plan.target.label_en,
      label_ar: plan.target.label_ar,
      options: plan.target.options,
      sensitivity: plan.target.sensitivity,
      visibility: plan.target.visibility,
    });
    await publishTemplate(tx, schoolId, kind, userId, keyring);
    fieldId = created.id;
  }

  const writes = plan.entries.filter((entry) => entry.status === "write");
  for (const entry of writes) {
    await writeAnswers(
      tx,
      schoolId,
      { kind, id: entry.subject_id },
      userId,
      [{ field_id: fieldId, value: entry.write_value }],
      keyring,
    );
  }
  return { fieldId, fieldCreated: plan.target.id === null, written: writes.length };
}
