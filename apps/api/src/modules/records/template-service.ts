/**
 * Record templates: the per-school, per-subject form staff build (docs/modules/student-records.md).
 *
 * Every edit is a draft on app.record_fields; publishing snapshots the non-archived fields into a
 * new app.record_template_versions row. Answers are always written against the current published
 * version and keep pointing at the field version they were given under, so a later label, choice or
 * required change never rewrites an old answer, and archiving a field drops it from the next
 * version while its answers stay.
 *
 * Two changes are refused once a field has been published: its type (an answer's shape depends on
 * it), and making a sensitive field standard again (ADR-019: once sealed, a value is never quietly
 * turned back into plaintext). Raising a field to sensitive seals its existing answers at publish.
 */

import { ERROR_CODES } from "@studafy/constants";
import {
  DEFAULT_SENSITIVE_RETENTION_MONTHS,
  labelSuggestsSensitive,
  sealRecordValue,
} from "@studafy/records";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";

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

export interface FieldDefinition {
  field_type: RecordFieldType;
  label_en: string;
  label_ar: string;
  help_en: string | null;
  help_ar: string | null;
  required: boolean;
  options: RecordFieldOption[];
  sort_order: number;
  visibility: RecordFieldVisibility;
  sensitivity: RecordFieldSensitivity;
  has_expiry: boolean;
  retention_months: number | null;
}

interface DraftFieldRow extends FieldDefinition {
  id: string;
  template_id: string;
  first_published_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** One field as published in a version: what answers are validated and displayed against. */
export interface PublishedField extends FieldDefinition {
  id: string;
  field_version_id: string;
}

export interface PublishedForm {
  version: number;
  template_version_id: string | null;
  fields: PublishedField[];
}

export interface CreateFieldInput {
  field_type: RecordFieldType;
  label_en: string;
  label_ar: string;
  help_en?: string | null;
  help_ar?: string | null;
  required?: boolean;
  options?: RecordFieldOption[];
  visibility?: RecordFieldVisibility;
  sensitivity?: RecordFieldSensitivity;
  has_expiry?: boolean;
  retention_months?: number | null;
}

export type UpdateFieldInput = Partial<CreateFieldInput> & { archived?: boolean };

const DEFINITION_COLUMNS = [
  "field_type",
  "label_en",
  "label_ar",
  "help_en",
  "help_ar",
  "required",
  "options",
  "sort_order",
  "visibility",
  "sensitivity",
  "has_expiry",
  "retention_months",
] as const;

function invalid(message: string): never {
  throw new CodedHttpException(422, ERROR_CODES.RECORD_FIELD_INVALID, message);
}

function emptyAsNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Cross-field rules a single column CHECK cannot state with a useful message. */
function assertDefinition(definition: FieldDefinition): void {
  const isChoice =
    definition.field_type === "single_choice" || definition.field_type === "multi_choice";
  if (isChoice && definition.options.length === 0) {
    invalid("A choice field needs at least one option");
  }
  if (!isChoice && definition.options.length > 0) {
    invalid("Only choice fields have options");
  }
  const values = definition.options.map((option) => option.value);
  if (new Set(values).size !== values.length) invalid("Option values must be unique");
  if (definition.has_expiry && definition.field_type !== "document") {
    invalid("Only document fields can have an expiry date");
  }
  if (definition.retention_months !== null && definition.sensitivity !== "sensitive") {
    invalid("A retention period applies to sensitive fields only");
  }
}

export function effectiveRetentionMonths(field: {
  sensitivity: RecordFieldSensitivity;
  retention_months: number | null;
}): number | null {
  if (field.sensitivity !== "sensitive") return null;
  return field.retention_months ?? DEFAULT_SENSITIVE_RETENTION_MONTHS;
}

async function findTemplate(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
): Promise<{ id: string; published_version: number } | undefined> {
  const [row] = await tx<{ id: string; published_version: number }[]>`
    SELECT id, published_version
    FROM app.record_templates
    WHERE school_id = ${schoolId}::uuid AND subject_kind = ${kind}::app.record_subject_kind
  `;
  return row;
}

async function ensureTemplate(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
): Promise<{ id: string; published_version: number }> {
  await tx`
    INSERT INTO app.record_templates (school_id, subject_kind)
    VALUES (${schoolId}::uuid, ${kind}::app.record_subject_kind)
    ON CONFLICT (school_id, subject_kind) DO NOTHING
  `;
  // FOR UPDATE serializes concurrent edits and publishes of one template.
  const [row] = await tx<{ id: string; published_version: number }[]>`
    SELECT id, published_version
    FROM app.record_templates
    WHERE school_id = ${schoolId}::uuid AND subject_kind = ${kind}::app.record_subject_kind
    FOR UPDATE
  `;
  return row!;
}

async function draftFields(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
): Promise<DraftFieldRow[]> {
  return tx<DraftFieldRow[]>`
    SELECT id, template_id, field_type, label_en, label_ar, help_en, help_ar, required, options,
           sort_order, visibility, sensitivity, has_expiry, retention_months, first_published_at,
           archived_at, created_at, updated_at
    FROM app.record_fields
    WHERE school_id = ${schoolId}::uuid AND template_id = ${templateId}::uuid
    ORDER BY sort_order, created_at, id
  `;
}

/** The fields of the template's current published version, in form order. */
export async function getPublishedForm(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
): Promise<PublishedForm> {
  const template = await findTemplate(tx, schoolId, kind);
  if (!template || template.published_version === 0) {
    return { version: 0, template_version_id: null, fields: [] };
  }
  const [version] = await tx<{ id: string }[]>`
    SELECT id FROM app.record_template_versions
    WHERE school_id = ${schoolId}::uuid AND template_id = ${template.id}::uuid
      AND version = ${template.published_version}
  `;
  const fields = await tx<PublishedField[]>`
    SELECT field_id AS id, id AS field_version_id, field_type, label_en, label_ar, help_en,
           help_ar, required, options, sort_order, visibility, sensitivity, has_expiry,
           retention_months
    FROM app.record_field_versions
    WHERE school_id = ${schoolId}::uuid AND template_version_id = ${version!.id}::uuid
    ORDER BY sort_order, field_id
  `;
  return { version: template.published_version, template_version_id: version!.id, fields };
}

function definitionOf(row: FieldDefinition): string {
  return JSON.stringify(DEFINITION_COLUMNS.map((column) => row[column]));
}

function toTemplateField(row: DraftFieldRow) {
  return {
    id: row.id,
    field_type: row.field_type,
    label_en: row.label_en,
    label_ar: row.label_ar,
    help_en: row.help_en,
    help_ar: row.help_ar,
    required: row.required,
    options: row.options,
    sort_order: row.sort_order,
    visibility: row.visibility,
    sensitivity: row.sensitivity,
    has_expiry: row.has_expiry,
    retention_months: row.retention_months,
    effective_retention_months: effectiveRetentionMonths(row),
    archived: row.archived_at !== null,
    published: row.first_published_at !== null,
    label_suggests_sensitive:
      labelSuggestsSensitive(row.label_en) || labelSuggestsSensitive(row.label_ar),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** The draft template as the editor shows it, with whether it differs from what is published. */
export async function getTemplate(tx: TransactionSql, schoolId: string, kind: RecordSubjectKind) {
  const template = await findTemplate(tx, schoolId, kind);
  if (!template) {
    return {
      subject_kind: kind,
      published_version: 0,
      published_at: null,
      has_unpublished_changes: false,
      fields: [],
    };
  }
  const fields = await draftFields(tx, schoolId, template.id);
  const published = await getPublishedForm(tx, schoolId, kind);
  const [version] = published.template_version_id
    ? await tx<{ published_at: Date }[]>`
        SELECT published_at FROM app.record_template_versions
        WHERE id = ${published.template_version_id}::uuid AND school_id = ${schoolId}::uuid
      `
    : [];

  return {
    subject_kind: kind,
    published_version: template.published_version,
    published_at: version?.published_at.toISOString() ?? null,
    has_unpublished_changes: hasChanges(fields, published.fields),
    fields: fields.map(toTemplateField),
  };
}

function hasChanges(draft: DraftFieldRow[], published: PublishedField[]): boolean {
  const live = draft.filter((field) => field.archived_at === null);
  if (live.length !== published.length) return true;
  const byId = new Map(published.map((field) => [field.id, field]));
  return live.some((field) => {
    const current = byId.get(field.id);
    return !current || definitionOf(current) !== definitionOf(field);
  });
}

async function loadDraftField(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
  fieldId: string,
): Promise<DraftFieldRow> {
  const [row] = await tx<DraftFieldRow[]>`
    SELECT id, template_id, field_type, label_en, label_ar, help_en, help_ar, required, options,
           sort_order, visibility, sensitivity, has_expiry, retention_months, first_published_at,
           archived_at, created_at, updated_at
    FROM app.record_fields
    WHERE school_id = ${schoolId}::uuid AND template_id = ${templateId}::uuid
      AND id = ${fieldId}::uuid
    FOR UPDATE
  `;
  if (!row) {
    throw new CodedHttpException(404, ERROR_CODES.RECORD_FIELD_NOT_FOUND, "Field not found");
  }
  return row;
}

export async function createField(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  actorId: string,
  input: CreateFieldInput,
) {
  const template = await ensureTemplate(tx, schoolId, kind);
  const [sortRow] = await tx<{ next_sort: number }[]>`
    SELECT coalesce(max(sort_order) + 1, 0)::int AS next_sort
    FROM app.record_fields
    WHERE school_id = ${schoolId}::uuid AND template_id = ${template.id}::uuid
  `;
  const next_sort = sortRow?.next_sort ?? 0;

  const definition: FieldDefinition = {
    field_type: input.field_type,
    label_en: input.label_en.trim(),
    label_ar: input.label_ar.trim(),
    help_en: emptyAsNull(input.help_en),
    help_ar: emptyAsNull(input.help_ar),
    required: input.required ?? false,
    options: input.options ?? [],
    sort_order: next_sort,
    visibility: input.visibility ?? "staff_only",
    sensitivity: input.sensitivity ?? "standard",
    has_expiry: input.has_expiry ?? false,
    retention_months: input.retention_months ?? null,
  };
  assertDefinition(definition);

  const [row] = await tx<DraftFieldRow[]>`
    INSERT INTO app.record_fields (
      school_id, template_id, field_type, label_en, label_ar, help_en, help_ar, required, options,
      sort_order, visibility, sensitivity, has_expiry, retention_months, created_by
    ) VALUES (
      ${schoolId}::uuid, ${template.id}::uuid, ${definition.field_type}::app.record_field_type,
      ${definition.label_en}, ${definition.label_ar}, ${definition.help_en},
      ${definition.help_ar}, ${definition.required}, ${tx.json(definition.options as never)},
      ${definition.sort_order}, ${definition.visibility}::app.record_field_visibility,
      ${definition.sensitivity}::app.record_field_sensitivity, ${definition.has_expiry},
      ${definition.retention_months}, ${actorId}::uuid
    )
    RETURNING id, template_id, field_type, label_en, label_ar, help_en, help_ar, required, options,
              sort_order, visibility, sensitivity, has_expiry, retention_months,
              first_published_at, archived_at, created_at, updated_at
  `;
  await tx`UPDATE app.record_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ${template.id}::uuid AND school_id = ${schoolId}::uuid`;

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "record_fields",
    targetId: row!.id,
    newValues: { subject_kind: kind, ...definition },
  });
  return toTemplateField(row!);
}

export async function updateField(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  fieldId: string,
  input: UpdateFieldInput,
) {
  const template = await ensureTemplate(tx, schoolId, kind);
  const current = await loadDraftField(tx, schoolId, template.id, fieldId);

  const next: FieldDefinition = {
    field_type: input.field_type ?? current.field_type,
    label_en: input.label_en?.trim() ?? current.label_en,
    label_ar: input.label_ar?.trim() ?? current.label_ar,
    help_en: input.help_en === undefined ? current.help_en : emptyAsNull(input.help_en),
    help_ar: input.help_ar === undefined ? current.help_ar : emptyAsNull(input.help_ar),
    required: input.required ?? current.required,
    options: input.options ?? current.options,
    sort_order: current.sort_order,
    visibility: input.visibility ?? current.visibility,
    sensitivity: input.sensitivity ?? current.sensitivity,
    has_expiry: input.has_expiry ?? current.has_expiry,
    retention_months:
      input.retention_months === undefined ? current.retention_months : input.retention_months,
  };
  // Dropping to standard clears a retention period that would no longer apply.
  if (next.sensitivity === "standard") next.retention_months = null;
  if (next.field_type !== "document") next.has_expiry = false;

  if (current.first_published_at !== null && next.field_type !== current.field_type) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RECORD_FIELD_LOCKED,
      "A published field's type cannot change; archive it and add a new field instead",
    );
  }
  if (next.sensitivity === "standard") {
    const [everSensitive] = await tx<{ ok: boolean }[]>`
      SELECT true AS ok FROM app.record_field_versions
      WHERE school_id = ${schoolId}::uuid AND field_id = ${fieldId}::uuid
        AND sensitivity = 'sensitive'
      LIMIT 1
    `;
    if (everSensitive) {
      throw new CodedHttpException(
        409,
        ERROR_CODES.RECORD_FIELD_LOCKED,
        "A field published as sensitive stays sensitive",
      );
    }
  }
  assertDefinition(next);

  const archivedAt =
    input.archived === undefined
      ? current.archived_at
      : input.archived
        ? (current.archived_at ?? new Date())
        : null;

  const [row] = await tx<DraftFieldRow[]>`
    UPDATE app.record_fields SET
      field_type = ${next.field_type}::app.record_field_type,
      label_en = ${next.label_en},
      label_ar = ${next.label_ar},
      help_en = ${next.help_en},
      help_ar = ${next.help_ar},
      required = ${next.required},
      options = ${tx.json(next.options as never)},
      visibility = ${next.visibility}::app.record_field_visibility,
      sensitivity = ${next.sensitivity}::app.record_field_sensitivity,
      has_expiry = ${next.has_expiry},
      retention_months = ${next.retention_months},
      archived_at = ${archivedAt},
      updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${fieldId}::uuid
    RETURNING id, template_id, field_type, label_en, label_ar, help_en, help_ar, required, options,
              sort_order, visibility, sensitivity, has_expiry, retention_months,
              first_published_at, archived_at, created_at, updated_at
  `;
  await tx`UPDATE app.record_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ${template.id}::uuid AND school_id = ${schoolId}::uuid`;

  const before = Object.fromEntries(DEFINITION_COLUMNS.map((c) => [c, current[c]]));
  const after = Object.fromEntries(DEFINITION_COLUMNS.map((c) => [c, next[c]]));
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "record_fields",
    targetId: fieldId,
    oldValues: { ...before, archived: current.archived_at !== null },
    newValues: { ...after, archived: archivedAt !== null },
  });
  return toTemplateField(row!);
}

/** Set the draft order. The listed ids come first, in order; unlisted fields keep theirs after. */
export async function reorderFields(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  fieldIds: readonly string[],
) {
  const template = await ensureTemplate(tx, schoolId, kind);
  const fields = await draftFields(tx, schoolId, template.id);
  const known = new Set(fields.map((field) => field.id));
  if (new Set(fieldIds).size !== fieldIds.length || fieldIds.some((id) => !known.has(id))) {
    invalid("field_ids must be distinct fields of this template");
  }
  const order = [...fieldIds, ...fields.map((f) => f.id).filter((id) => !fieldIds.includes(id))];
  for (const [index, id] of order.entries()) {
    await tx`
      UPDATE app.record_fields SET sort_order = ${index}, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND id = ${id}::uuid AND sort_order <> ${index}
    `;
  }
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "record_templates",
    targetId: template.id,
    oldValues: { field_order: fields.map((field) => field.id) },
    newValues: { field_order: order },
  });
  return getTemplate(tx, schoolId, kind);
}

/**
 * Publish the draft as the next version. Fields raised to sensitive have their existing plaintext
 * answers sealed here, in the same transaction, so no plaintext of a sensitive field survives the
 * publish (ADR-019).
 */
export async function publishTemplate(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  actorId: string,
  keyring: RecordKeyring,
) {
  const template = await ensureTemplate(tx, schoolId, kind);
  const fields = await draftFields(tx, schoolId, template.id);
  const previous = await getPublishedForm(tx, schoolId, kind);
  const live = fields.filter((field) => field.archived_at === null);

  if (!hasChanges(fields, previous.fields)) {
    throw new CodedHttpException(
      409,
      ERROR_CODES.RECORD_NOTHING_TO_PUBLISH,
      "The draft has no changes to publish",
    );
  }

  const version = template.published_version + 1;
  const [published] = await tx<{ id: string; published_at: Date }[]>`
    INSERT INTO app.record_template_versions (school_id, template_id, version, published_by)
    VALUES (${schoolId}::uuid, ${template.id}::uuid, ${version}, ${actorId}::uuid)
    RETURNING id, published_at
  `;
  for (const field of live) {
    await tx`
      INSERT INTO app.record_field_versions (
        school_id, template_version_id, field_id, field_type, label_en, label_ar, help_en, help_ar,
        required, options, sort_order, visibility, sensitivity, has_expiry, retention_months
      ) VALUES (
        ${schoolId}::uuid, ${published!.id}::uuid, ${field.id}::uuid,
        ${field.field_type}::app.record_field_type, ${field.label_en}, ${field.label_ar},
        ${field.help_en}, ${field.help_ar}, ${field.required}, ${tx.json(field.options as never)},
        ${field.sort_order}, ${field.visibility}::app.record_field_visibility,
        ${field.sensitivity}::app.record_field_sensitivity, ${field.has_expiry},
        ${field.retention_months}
      )
    `;
  }
  await tx`
    UPDATE app.record_fields SET first_published_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND template_id = ${template.id}::uuid
      AND archived_at IS NULL AND first_published_at IS NULL
  `;
  await tx`
    UPDATE app.record_templates
    SET published_version = ${version}, updated_at = CURRENT_TIMESTAMP
    WHERE school_id = ${schoolId}::uuid AND id = ${template.id}::uuid
  `;

  const sealed = await sealPlaintextOfSensitiveFields(
    tx,
    schoolId,
    kind,
    live.filter((field) => field.sensitivity === "sensitive"),
    keyring,
  );

  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "record_template_versions",
    targetId: published!.id,
    newValues: {
      subject_kind: kind,
      version,
      field_count: live.length,
      sealed_answer_count: sealed,
    },
  });

  return {
    subject_kind: kind,
    version,
    published_at: published!.published_at.toISOString(),
    field_count: live.length,
  };
}

async function sealPlaintextOfSensitiveFields(
  tx: TransactionSql,
  schoolId: string,
  kind: RecordSubjectKind,
  fields: DraftFieldRow[],
  keyring: RecordKeyring,
): Promise<number> {
  if (fields.length === 0) return 0;
  const types = new Map(fields.map((field) => [field.id, field.field_type]));
  const rows = await tx<{ id: string; subject_id: string; field_id: string; value: RecordValue }[]>`
    SELECT id, subject_id, field_id, value
    FROM app.record_answers
    WHERE school_id = ${schoolId}::uuid AND subject_kind = ${kind}::app.record_subject_kind
      AND field_id = ANY(${fields.map((field) => field.id)}::uuid[])
      AND value IS NOT NULL
  `;
  for (const row of rows) {
    const seal = sealRecordValue(
      keyring,
      { schoolId, subjectKind: kind, subjectId: row.subject_id, fieldId: row.field_id },
      types.get(row.field_id)!,
      row.value,
    );
    await tx`
      UPDATE app.record_answers
      SET value = NULL, value_ciphertext = ${seal.ciphertext}, value_key_id = ${seal.keyId},
          value_mask = ${seal.mask}, updated_at = CURRENT_TIMESTAMP
      WHERE school_id = ${schoolId}::uuid AND id = ${row.id}::uuid
    `;
  }
  return rows.length;
}
