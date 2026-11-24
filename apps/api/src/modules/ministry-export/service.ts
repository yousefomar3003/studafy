import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";
import {
  MINISTRY_EXPORT_EXAMPLES,
  MINISTRY_EXPORT_LIMITS,
  buildMinistryExport,
  validateMinistryExportTemplate,
} from "@studafy/grading-engine";
import {
  RecordKeyUnavailableError,
  RecordSealBrokenError,
  openRecordValue,
} from "@studafy/records";

import { CodedHttpException } from "../../coded-http-exception";
import { emitAuditLog } from "../../middleware/auditEmitter";
import { hasPermission } from "../../middleware/authz";

import type { Role } from "@studafy/constants";
import type {
  MinistryExportColumnDefinition,
  MinistryExportEncoding,
  MinistryExportField,
  MinistryExportFileFormat,
  MinistryExportIssue,
  MinistryExportRowKind,
  MinistryExportSourceRow,
  MinistryExportTemplateDefinition,
} from "@studafy/grading-engine";
import type { RecordKeyring } from "@studafy/records";
import type { TransactionSql } from "postgres";

/**
 * Ministry results export (000265): a school's export templates, and running one over finalized
 * results.
 *
 * School leadership manages templates (academicConfig:manage) and runs them (result:finalize).
 * An export reads the current finalized results (000160) of the chosen year and period (a term, or
 * the year's annual results) for the chosen grades and sections: per subject or overall, as the
 * template says, with the school's current student names and subject codes. A section with no
 * finalized result for the period is left out and reported. Everything about the layout is
 * @studafy/grading-engine's buildMinistryExport, so the preview is the file's first rows.
 *
 * THE NATIONAL ID is not a Studafy column: it is whatever student record field (000170) the
 * template names, read with the records module's rules. Reading it at all needs
 * studentRecord:read. When the field is sensitive (ADR-019) the preview shows each value's mask
 * and never decrypts; the download opens the values only for a caller holding
 * studentRecord:readSensitive, and is audited like a reveal: one `read` row on the field naming the
 * students whose values were opened, next to the `export` row of the download itself.
 */

// ---------------------------------------------------------------------------
// Views and inputs
// ---------------------------------------------------------------------------

export interface MinistryExportColumnView {
  header: string;
  field: MinistryExportField;
  constant_value: string | null;
  value_map: { from: string; to: string }[];
}

export interface MinistryExportTemplateView {
  id: string;
  name: string;
  target: string;
  file_format: MinistryExportFileFormat;
  encoding: MinistryExportEncoding;
  row_kind: MinistryExportRowKind;
  decimal_places: number;
  national_id_field: {
    id: string;
    label_en: string;
    label_ar: string;
    sensitive: boolean;
    archived: boolean;
  } | null;
  columns: MinistryExportColumnView[];
  subject_codes: { subject_id: string; subject_code: string; subject_name: string; code: string }[];
  created_at: string;
  updated_at: string;
}

export interface MinistryExportTemplateInput {
  name: string;
  target?: string | undefined;
  file_format: MinistryExportFileFormat;
  encoding: MinistryExportEncoding;
  row_kind: MinistryExportRowKind;
  decimal_places?: number | undefined;
  national_id_field_id?: string | null | undefined;
  columns: {
    header: string;
    field: MinistryExportField;
    constant_value?: string | null | undefined;
    value_map?: { from: string; to: string }[] | undefined;
  }[];
  subject_codes?: { subject_id: string; code: string }[] | undefined;
}

export interface MinistryExportRunInput {
  template_id: string;
  academic_year_id: string;
  term_id: string | null;
  grade_level_ids?: string[] | undefined;
  section_ids?: string[] | undefined;
}

export type MinistryExportIssueCodeView = MinistryExportIssue["code"] | "section_not_finalized";

export interface MinistryExportIssueView {
  code: MinistryExportIssueCodeView;
  severity: "error" | "warning";
  count: number;
  student_id: string | null;
  student_name: string | null;
  admission_number: string | null;
  subject_id: string | null;
  subject_code: string | null;
  subject_name: string | null;
  section_id: string | null;
  section_name: string | null;
  grade_level_name: string | null;
}

export interface MinistryExportPreviewView {
  template_id: string;
  file_format: MinistryExportFileFormat;
  total_rows: number;
  students: number;
  sections_included: number;
  header: string[];
  rows: { cells: string[] }[];
  national_ids_masked: boolean;
  issues: MinistryExportIssueView[];
}

export interface MinistryExportActor {
  schoolId: string;
  roles: readonly Role[];
}

const DEFAULT_DECIMAL_PLACES = 2;
/** Record field types a national ID can be kept in. */
const NATIONAL_ID_FIELD_TYPES = ["short_text", "number"] as const;

function invalid(message: string): never {
  throw new CodedHttpException(400, ERROR_CODES.VALIDATION_FAILED, message);
}

function notFound(message: string): never {
  throw new CodedHttpException(404, ERROR_CODES.RESOURCE_NOT_FOUND, message);
}

function forbidden(message: string): never {
  throw new CodedHttpException(403, ERROR_CODES.AUTHZ_FORBIDDEN, message);
}

function isPgError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === code;
}

const num = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export function listMinistryExportExamples() {
  return MINISTRY_EXPORT_EXAMPLES.map((example) => ({
    key: example.key,
    name_en: example.name.en,
    name_ar: example.name.ar,
    note_en: example.note.en,
    note_ar: example.note.ar,
    template: {
      name: example.template.name,
      target: example.template.target,
      file_format: example.template.fileFormat,
      encoding: example.template.encoding,
      row_kind: example.template.rowKind,
      decimal_places: example.template.decimalPlaces,
      columns: example.template.columns.map(columnView),
    },
  }));
}

function columnView(column: MinistryExportColumnDefinition): MinistryExportColumnView {
  return {
    header: column.header,
    field: column.field,
    constant_value: column.constantValue,
    value_map: column.valueMap.map((entry) => ({ from: entry.from, to: entry.to })),
  };
}

// ---------------------------------------------------------------------------
// Templates: reading
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  target: string;
  file_format: MinistryExportFileFormat;
  encoding: MinistryExportEncoding;
  row_kind: MinistryExportRowKind;
  decimal_places: number;
  national_id_field_id: string | null;
  field_label_en: string | null;
  field_label_ar: string | null;
  field_sensitivity: "standard" | "sensitive" | null;
  field_archived: boolean | null;
  created_at: Date;
  updated_at: Date;
}

async function loadTemplates(
  tx: TransactionSql,
  schoolId: string,
  templateId: string | null,
): Promise<MinistryExportTemplateView[]> {
  const templates = await tx<TemplateRow[]>`
    SELECT t.id, t.name, t.target, t.file_format, t.encoding, t.row_kind, t.decimal_places,
           t.national_id_field_id, f.label_en AS field_label_en, f.label_ar AS field_label_ar,
           f.sensitivity::text AS field_sensitivity, (f.archived_at IS NOT NULL) AS field_archived,
           t.created_at, t.updated_at
    FROM app.ministry_export_templates AS t
    LEFT JOIN app.record_fields AS f
      ON f.id = t.national_id_field_id AND f.school_id = t.school_id
    WHERE t.school_id = ${schoolId}::uuid
      AND (${templateId}::uuid IS NULL OR t.id = ${templateId}::uuid)
    ORDER BY t.name, t.id
  `;
  if (templates.length === 0) return [];
  const ids = templates.map((template) => template.id);

  const columns = await tx<
    {
      id: string;
      template_id: string;
      header: string;
      field: MinistryExportField;
      constant_value: string | null;
    }[]
  >`
    SELECT id, template_id, header, field, constant_value
    FROM app.ministry_export_columns
    WHERE school_id = ${schoolId}::uuid AND template_id = ANY (${ids}::uuid[])
    ORDER BY template_id, position
  `;
  const maps = await tx<{ column_id: string; from_value: string; to_value: string }[]>`
    SELECT m.column_id, m.from_value, m.to_value
    FROM app.ministry_export_value_maps AS m
    JOIN app.ministry_export_columns AS c ON c.id = m.column_id AND c.school_id = m.school_id
    WHERE m.school_id = ${schoolId}::uuid AND c.template_id = ANY (${ids}::uuid[])
    ORDER BY m.column_id, m.position
  `;
  const codes = await tx<
    {
      template_id: string;
      subject_id: string;
      subject_code: string;
      subject_name: string;
      code: string;
    }[]
  >`
    SELECT sc.template_id, sc.subject_id, s.code AS subject_code, s.name AS subject_name, sc.code
    FROM app.ministry_export_subject_codes AS sc
    JOIN app.subjects AS s ON s.id = sc.subject_id AND s.school_id = sc.school_id
    WHERE sc.school_id = ${schoolId}::uuid AND sc.template_id = ANY (${ids}::uuid[])
    ORDER BY s.name, s.code
  `;

  const mapsByColumn = new Map<string, { from: string; to: string }[]>();
  for (const map of maps) {
    const list = mapsByColumn.get(map.column_id) ?? [];
    list.push({ from: map.from_value, to: map.to_value });
    mapsByColumn.set(map.column_id, list);
  }
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    target: template.target,
    file_format: template.file_format,
    encoding: template.encoding,
    row_kind: template.row_kind,
    decimal_places: template.decimal_places,
    national_id_field:
      template.national_id_field_id === null
        ? null
        : {
            id: template.national_id_field_id,
            label_en: template.field_label_en ?? "",
            label_ar: template.field_label_ar ?? "",
            sensitive: template.field_sensitivity === "sensitive",
            archived: template.field_archived === true,
          },
    columns: columns
      .filter((column) => column.template_id === template.id)
      .map((column) => ({
        header: column.header,
        field: column.field,
        constant_value: column.constant_value,
        value_map: mapsByColumn.get(column.id) ?? [],
      })),
    subject_codes: codes
      .filter((code) => code.template_id === template.id)
      .map(({ subject_id, subject_code, subject_name, code }) => ({
        subject_id,
        subject_code,
        subject_name,
        code,
      })),
    created_at: template.created_at.toISOString(),
    updated_at: template.updated_at.toISOString(),
  }));
}

export function listMinistryExportTemplates(
  tx: TransactionSql,
  schoolId: string,
): Promise<MinistryExportTemplateView[]> {
  return loadTemplates(tx, schoolId, null);
}

export async function getMinistryExportTemplate(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
): Promise<MinistryExportTemplateView> {
  const [template] = await loadTemplates(tx, schoolId, templateId);
  if (!template) notFound("Ministry export template not found");
  return template;
}

// ---------------------------------------------------------------------------
// Templates: writing
// ---------------------------------------------------------------------------

function definitionOf(input: MinistryExportTemplateInput): MinistryExportTemplateDefinition {
  return {
    name: input.name.trim(),
    target: (input.target ?? "").trim(),
    fileFormat: input.file_format,
    encoding: input.encoding,
    rowKind: input.row_kind,
    decimalPlaces: input.decimal_places ?? DEFAULT_DECIMAL_PLACES,
    columns: input.columns.map((column) => {
      const constant = column.constant_value?.trim() ?? "";
      return {
        header: column.header.trim(),
        field: column.field,
        // A blank fixed text on another field is no fixed text at all.
        constantValue: column.field === "constant" || constant !== "" ? constant : null,
        valueMap: (column.value_map ?? []).map((entry) => ({
          from: entry.from.trim(),
          to: entry.to.trim(),
        })),
      };
    }),
  };
}

async function checkInput(
  tx: TransactionSql,
  schoolId: string,
  input: MinistryExportTemplateInput,
): Promise<MinistryExportTemplateDefinition> {
  const definition = definitionOf(input);
  const [first] = validateMinistryExportTemplate(definition);
  if (first) invalid(first.message);

  const fieldId = input.national_id_field_id ?? null;
  if (fieldId !== null) {
    const [field] = await tx<{ field_type: string; archived: boolean }[]>`
      SELECT f.field_type::text AS field_type, (f.archived_at IS NOT NULL) AS archived
      FROM app.record_fields AS f
      JOIN app.record_templates AS rt ON rt.id = f.template_id AND rt.school_id = f.school_id
      WHERE f.school_id = ${schoolId}::uuid AND f.id = ${fieldId}::uuid
        AND rt.subject_kind = 'student'
    `;
    if (!field) notFound("Student record field not found");
    if (field.archived) invalid("The national ID field is archived");
    if (!(NATIONAL_ID_FIELD_TYPES as readonly string[]).includes(field.field_type)) {
      invalid("The national ID must be a short text or number field");
    }
  }

  const subjectIds = (input.subject_codes ?? []).map((code) => code.subject_id);
  if (new Set(subjectIds).size !== subjectIds.length) {
    invalid("A subject has more than one ministry code");
  }
  if (subjectIds.length > 0) {
    const [{ found } = { found: 0 }] = await tx<{ found: number }[]>`
      SELECT count(*)::int AS found FROM app.subjects
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${subjectIds}::uuid[])
    `;
    if (found !== subjectIds.length) notFound("Subject not found");
  }
  return definition;
}

function duplicateName(name: string): never {
  throw new CodedHttpException(
    409,
    ERROR_CODES.CONFLICT_DUPLICATE_ENTRY,
    `The school already has a ministry export template named "${name}"`,
  );
}

/** Replace the template's columns (and their value maps) and subject codes with the input's. */
async function writeContents(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
  definition: MinistryExportTemplateDefinition,
  subjectCodes: readonly { subject_id: string; code: string }[],
): Promise<void> {
  // Value maps go with their columns (ON DELETE CASCADE).
  await tx`
    DELETE FROM app.ministry_export_columns
    WHERE school_id = ${schoolId}::uuid AND template_id = ${templateId}::uuid
  `;
  for (const [position, column] of definition.columns.entries()) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO app.ministry_export_columns (
        school_id, template_id, position, header, field, constant_value
      )
      VALUES (
        ${schoolId}::uuid, ${templateId}::uuid, ${position}, ${column.header}, ${column.field},
        ${column.constantValue}
      )
      RETURNING id
    `;
    if (column.valueMap.length > 0) {
      await tx`
        INSERT INTO app.ministry_export_value_maps (
          school_id, column_id, position, from_value, to_value
        )
        SELECT ${schoolId}::uuid, ${row!.id}::uuid, entry.position - 1, entry.from_value,
               entry.to_value
        FROM unnest(
          ${column.valueMap.map((entry) => entry.from)}::text[],
          ${column.valueMap.map((entry) => entry.to)}::text[]
        ) WITH ORDINALITY AS entry (from_value, to_value, position)
      `;
    }
  }
  await tx`
    DELETE FROM app.ministry_export_subject_codes
    WHERE school_id = ${schoolId}::uuid AND template_id = ${templateId}::uuid
  `;
  if (subjectCodes.length > 0) {
    await tx`
      INSERT INTO app.ministry_export_subject_codes (school_id, template_id, subject_id, code)
      SELECT ${schoolId}::uuid, ${templateId}::uuid, entry.subject_id, entry.code
      FROM unnest(
        ${subjectCodes.map((code) => code.subject_id)}::uuid[],
        ${subjectCodes.map((code) => code.code.trim())}::text[]
      ) AS entry (subject_id, code)
    `;
  }
}

function auditSummary(
  definition: MinistryExportTemplateDefinition,
  nationalIdFieldId: string | null,
  subjectCodes: readonly { subject_id: string; code: string }[],
) {
  return {
    name: definition.name,
    target: definition.target,
    file_format: definition.fileFormat,
    encoding: definition.encoding,
    row_kind: definition.rowKind,
    decimal_places: definition.decimalPlaces,
    national_id_field_id: nationalIdFieldId,
    columns: definition.columns.map(columnView),
    subject_codes: subjectCodes.map((code) => ({ subject_id: code.subject_id, code: code.code })),
  };
}

function viewSummary(view: MinistryExportTemplateView) {
  return {
    name: view.name,
    target: view.target,
    file_format: view.file_format,
    encoding: view.encoding,
    row_kind: view.row_kind,
    decimal_places: view.decimal_places,
    national_id_field_id: view.national_id_field?.id ?? null,
    columns: view.columns,
    subject_codes: view.subject_codes.map((code) => ({
      subject_id: code.subject_id,
      code: code.code,
    })),
  };
}

export async function createMinistryExportTemplate(
  tx: TransactionSql,
  schoolId: string,
  input: MinistryExportTemplateInput,
): Promise<MinistryExportTemplateView> {
  const definition = await checkInput(tx, schoolId, input);
  const fieldId = input.national_id_field_id ?? null;
  let templateId: string;
  try {
    const [row] = await tx.savepoint(
      (sp) => sp<{ id: string }[]>`
        INSERT INTO app.ministry_export_templates (
          school_id, name, target, file_format, encoding, row_kind, decimal_places,
          national_id_field_id
        )
        VALUES (
          ${schoolId}::uuid, ${definition.name}, ${definition.target}, ${definition.fileFormat},
          ${definition.encoding}, ${definition.rowKind}, ${definition.decimalPlaces},
          ${fieldId}::uuid
        )
        RETURNING id
      `,
    );
    templateId = row!.id;
  } catch (error) {
    if (isPgError(error, "23505")) duplicateName(definition.name);
    throw error;
  }
  const subjectCodes = input.subject_codes ?? [];
  await writeContents(tx, schoolId, templateId, definition, subjectCodes);
  await emitAuditLog(tx, {
    action: "insert",
    targetTable: "ministry_export_templates",
    targetId: templateId,
    newValues: auditSummary(definition, fieldId, subjectCodes),
  });
  return getMinistryExportTemplate(tx, schoolId, templateId);
}

export async function updateMinistryExportTemplate(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
  input: MinistryExportTemplateInput,
): Promise<MinistryExportTemplateView> {
  const before = await getMinistryExportTemplate(tx, schoolId, templateId);
  const definition = await checkInput(tx, schoolId, input);
  const fieldId = input.national_id_field_id ?? null;
  try {
    await tx.savepoint(
      (sp) => sp`
        UPDATE app.ministry_export_templates
        SET name = ${definition.name},
            target = ${definition.target},
            file_format = ${definition.fileFormat},
            encoding = ${definition.encoding},
            row_kind = ${definition.rowKind},
            decimal_places = ${definition.decimalPlaces},
            national_id_field_id = ${fieldId}::uuid,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${templateId}::uuid AND school_id = ${schoolId}::uuid
      `,
    );
  } catch (error) {
    if (isPgError(error, "23505")) duplicateName(definition.name);
    throw error;
  }
  const subjectCodes = input.subject_codes ?? [];
  await writeContents(tx, schoolId, templateId, definition, subjectCodes);
  await emitAuditLog(tx, {
    action: "update",
    targetTable: "ministry_export_templates",
    targetId: templateId,
    oldValues: viewSummary(before),
    newValues: auditSummary(definition, fieldId, subjectCodes),
  });
  return getMinistryExportTemplate(tx, schoolId, templateId);
}

export async function deleteMinistryExportTemplate(
  tx: TransactionSql,
  schoolId: string,
  templateId: string,
): Promise<void> {
  const before = await getMinistryExportTemplate(tx, schoolId, templateId);
  await tx`
    DELETE FROM app.ministry_export_templates
    WHERE id = ${templateId}::uuid AND school_id = ${schoolId}::uuid
  `;
  await emitAuditLog(tx, {
    action: "delete",
    targetTable: "ministry_export_templates",
    targetId: templateId,
    oldValues: viewSummary(before),
  });
}

// ---------------------------------------------------------------------------
// Running an export
// ---------------------------------------------------------------------------

interface SectionRow {
  id: string;
  name: string;
  grade_level_id: string;
  grade_level_name: string;
  archived: boolean;
  finalization_id: string | null;
}

interface Period {
  yearName: string;
  yearCode: string;
  termName: string | null;
}

async function resolvePeriod(
  tx: TransactionSql,
  schoolId: string,
  input: MinistryExportRunInput,
): Promise<Period> {
  const [year] = await tx<{ name: string; code: string }[]>`
    SELECT name, code FROM app.academic_years
    WHERE school_id = ${schoolId}::uuid AND id = ${input.academic_year_id}::uuid
  `;
  if (!year) notFound("Academic year not found");
  let termName: string | null = null;
  if (input.term_id !== null) {
    const [term] = await tx<{ name: string }[]>`
      SELECT name FROM app.terms
      WHERE school_id = ${schoolId}::uuid AND id = ${input.term_id}::uuid
        AND academic_year_id = ${input.academic_year_id}::uuid
    `;
    if (!term) notFound("Term not found in this year");
    termName = term.name;
  }
  return { yearName: year.name, yearCode: year.code, termName };
}

/** The year's sections in scope, each with its current finalization for the period (or none). */
async function resolveSections(
  tx: TransactionSql,
  schoolId: string,
  input: MinistryExportRunInput,
): Promise<SectionRow[]> {
  const gradeIds = [...new Set(input.grade_level_ids ?? [])];
  const sectionIds = [...new Set(input.section_ids ?? [])];
  if (gradeIds.length > 0) {
    const [{ found } = { found: 0 }] = await tx<{ found: number }[]>`
      SELECT count(*)::int AS found FROM app.grade_levels
      WHERE school_id = ${schoolId}::uuid AND id = ANY (${gradeIds}::uuid[])
    `;
    if (found !== gradeIds.length) notFound("Grade level not found");
  }
  if (sectionIds.length > 0) {
    const [{ found } = { found: 0 }] = await tx<{ found: number }[]>`
      SELECT count(*)::int AS found FROM app.sections
      WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${input.academic_year_id}::uuid
        AND id = ANY (${sectionIds}::uuid[])
    `;
    if (found !== sectionIds.length) notFound("Section not found in this year");
  }
  return tx<SectionRow[]>`
    SELECT s.id, s.name, s.grade_level_id, g.name AS grade_level_name,
           (s.archived_at IS NOT NULL) AS archived, f.id AS finalization_id
    FROM app.sections AS s
    JOIN app.grade_levels AS g ON g.id = s.grade_level_id AND g.school_id = s.school_id
    LEFT JOIN app.result_finalizations AS f
      ON f.school_id = s.school_id AND f.section_id = s.id AND f.status = 'finalized'
     AND f.term_id IS NOT DISTINCT FROM ${input.term_id}::uuid
    WHERE s.school_id = ${schoolId}::uuid AND s.academic_year_id = ${input.academic_year_id}::uuid
      AND (cardinality(${gradeIds}::uuid[]) = 0 OR s.grade_level_id = ANY (${gradeIds}::uuid[]))
      AND (cardinality(${sectionIds}::uuid[]) = 0 OR s.id = ANY (${sectionIds}::uuid[]))
    ORDER BY g.sort_order, g.name, s.name, s.id
  `;
}

interface ResultRow {
  student_id: string;
  section_id: string;
  admission_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  date_of_birth: string | null;
  subject_id: string | null;
  subject_code: string | null;
  subject_name: string | null;
  status: string;
  passed: boolean | null;
  mark: string | null;
  max_mark: string | null;
  percentage: string | null;
  grade_label: string | null;
  gpa: string | null;
}

/** Finalized results in section order, then by student name (and subject code per student). */
async function loadResults(
  tx: TransactionSql,
  schoolId: string,
  rowKind: MinistryExportRowKind,
  finalizationIds: readonly string[],
): Promise<ResultRow[]> {
  if (finalizationIds.length === 0) return [];
  const ids = [...finalizationIds];
  if (rowKind === "subject") {
    return tx<ResultRow[]>`
      SELECT r.student_id, f.section_id, st.admission_number, st.first_name, st.middle_name,
             st.last_name, to_char(st.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
             r.subject_id, sub.code AS subject_code, sub.name AS subject_name, r.status, r.passed,
             r.marks_obtained::text AS mark, r.max_marks::text AS max_mark,
             r.percentage::text AS percentage, r.grade_label, r.gpa_points::text AS gpa
      FROM app.student_subject_results AS r
      JOIN app.result_finalizations AS f ON f.id = r.finalization_id AND f.school_id = r.school_id
      JOIN app.students AS st ON st.id = r.student_id AND st.school_id = r.school_id
      JOIN app.subjects AS sub ON sub.id = r.subject_id AND sub.school_id = r.school_id
      WHERE r.school_id = ${schoolId}::uuid AND r.finalization_id = ANY (${ids}::uuid[])
      ORDER BY array_position(${ids}::uuid[], r.finalization_id), st.last_name, st.first_name,
               st.admission_number, sub.code, sub.id
    `;
  }
  return tx<ResultRow[]>`
    SELECT o.student_id, f.section_id, st.admission_number, st.first_name, st.middle_name,
           st.last_name, to_char(st.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
           NULL::uuid AS subject_id, NULL::text AS subject_code, NULL::text AS subject_name,
           o.academic_status AS status, NULL::boolean AS passed,
           o.total_obtained::text AS mark, o.total_max::text AS max_mark,
           o.average_percentage::text AS percentage, o.grade_label,
           CASE WHEN o.result_format = 'gpa' THEN o.result_value::text END AS gpa
    FROM app.student_overall_results AS o
    JOIN app.result_finalizations AS f ON f.id = o.finalization_id AND f.school_id = o.school_id
    JOIN app.students AS st ON st.id = o.student_id AND st.school_id = o.school_id
    WHERE o.school_id = ${schoolId}::uuid AND o.finalization_id = ANY (${ids}::uuid[])
    ORDER BY array_position(${ids}::uuid[], o.finalization_id), st.last_name, st.first_name,
             st.admission_number
  `;
}

/** A subject result's status as the file says it: pass, fail, incomplete or exempt. */
function subjectStatus(row: ResultRow): string {
  if (row.status === "complete") return row.passed ? "pass" : "fail";
  return row.status;
}

interface NationalIds {
  /** student id -> the value the file shows (full, or a mask). */
  values: Map<string, string>;
  /** Students whose value is sealed (ADR-019). */
  sealed: string[];
  masked: boolean;
}

async function loadNationalIds(
  tx: TransactionSql,
  schoolId: string,
  fieldId: string,
  studentIds: readonly string[],
  mode: { open: false } | { open: true; keyring: RecordKeyring },
): Promise<NationalIds> {
  const answers = await tx<
    {
      student_id: string;
      value_text: string | null;
      value_ciphertext: Uint8Array | null;
      value_key_id: string | null;
      value_mask: string | null;
    }[]
  >`
    SELECT a.student_id, a.value #>> '{}' AS value_text, a.value_ciphertext, a.value_key_id,
           a.value_mask
    FROM app.record_answers AS a
    WHERE a.school_id = ${schoolId}::uuid AND a.subject_kind = 'student'
      AND a.field_id = ${fieldId}::uuid AND a.student_id = ANY (${[...studentIds]}::uuid[])
  `;
  const values = new Map<string, string>();
  const sealed: string[] = [];
  let masked = false;
  for (const answer of answers) {
    if (answer.value_ciphertext === null) {
      if (answer.value_text !== null && answer.value_text.trim() !== "") {
        values.set(answer.student_id, answer.value_text.trim());
      }
      continue;
    }
    sealed.push(answer.student_id);
    if (!mode.open) {
      masked = true;
      values.set(answer.student_id, answer.value_mask ?? "••••");
      continue;
    }
    try {
      const opened = openRecordValue(
        mode.keyring,
        { schoolId, subjectKind: "student", subjectId: answer.student_id, fieldId },
        {
          ciphertext: answer.value_ciphertext,
          keyId: answer.value_key_id!,
          mask: answer.value_mask!,
        },
      ).unwrap();
      if (opened !== null && String(opened).trim() !== "") {
        values.set(answer.student_id, String(opened).trim());
      }
    } catch (error) {
      if (error instanceof RecordKeyUnavailableError || error instanceof RecordSealBrokenError) {
        throw new CodedHttpException(
          503,
          ERROR_CODES.RECORD_KEY_UNAVAILABLE,
          "A national ID cannot be opened with the configured keys",
        );
      }
      throw error;
    }
  }
  return { values, sealed, masked };
}

interface BuiltExport {
  template: MinistryExportTemplateView;
  period: Period;
  sections: SectionRow[];
  header: string[];
  rows: string[][];
  numericColumns: boolean[];
  issues: MinistryExportIssueView[];
  students: number;
  nationalIds: NationalIds | null;
}

const blankIssue = {
  student_id: null,
  student_name: null,
  admission_number: null,
  subject_id: null,
  subject_code: null,
  subject_name: null,
  section_id: null,
  section_name: null,
  grade_level_name: null,
} as const;

async function buildExport(
  tx: TransactionSql,
  actor: MinistryExportActor,
  input: MinistryExportRunInput,
  mode: { open: false } | { open: true; keyring: RecordKeyring },
): Promise<BuiltExport> {
  const schoolId = actor.schoolId;
  const template = await getMinistryExportTemplate(tx, schoolId, input.template_id);
  const usesNationalId = template.columns.some((column) => column.field === "national_id");
  const fieldId = usesNationalId ? (template.national_id_field?.id ?? null) : null;
  if (fieldId !== null) {
    if (!hasPermission(actor.roles, PERMISSIONS.STUDENT_RECORD_READ)) {
      forbidden("Reading national IDs needs access to student records");
    }
    if (
      mode.open &&
      template.national_id_field?.sensitive === true &&
      !hasPermission(actor.roles, PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE)
    ) {
      forbidden(
        "The national ID field is sensitive; downloading it needs studentRecord:readSensitive",
      );
    }
  }

  const period = await resolvePeriod(tx, schoolId, input);
  const sections = await resolveSections(tx, schoolId, input);
  const finalizationIds = sections.flatMap((section) =>
    section.finalization_id === null ? [] : [section.finalization_id],
  );
  const results = await loadResults(tx, schoolId, template.row_kind, finalizationIds);
  const studentIds = [...new Set(results.map((row) => row.student_id))];

  let nationalIds: NationalIds | null = null;
  if (fieldId !== null && studentIds.length > 0) {
    // A value sealed under a field that has since become standard is still sensitive: opening it
    // needs the same permission (checked here, once the rows are known).
    nationalIds = await loadNationalIds(tx, schoolId, fieldId, studentIds, mode);
    if (
      mode.open &&
      nationalIds.sealed.length > 0 &&
      !hasPermission(actor.roles, PERMISSIONS.STUDENT_RECORD_READ_SENSITIVE)
    ) {
      forbidden("A national ID is sensitive; downloading it needs studentRecord:readSensitive");
    }
  }

  const codes = new Map(template.subject_codes.map((code) => [code.subject_id, code.code]));
  const sectionsById = new Map(sections.map((section) => [section.id, section]));
  const source: MinistryExportSourceRow[] = results.map((row) => {
    const section = sectionsById.get(row.section_id)!;
    return {
      studentId: row.student_id,
      nationalId: nationalIds?.values.get(row.student_id) ?? null,
      admissionNumber: row.admission_number,
      firstName: row.first_name,
      middleName: row.middle_name,
      lastName: row.last_name,
      dateOfBirth: row.date_of_birth,
      gradeLevel: section.grade_level_name,
      section: section.name,
      sectionId: section.id,
      academicYear: period.yearName,
      term: period.termName,
      subject:
        row.subject_id === null
          ? null
          : { id: row.subject_id, code: row.subject_code ?? "", name: row.subject_name ?? "" },
      subjectMinistryCode: row.subject_id === null ? null : (codes.get(row.subject_id) ?? null),
      status: template.row_kind === "subject" ? subjectStatus(row) : row.status,
      mark: num(row.mark),
      maxMark: num(row.max_mark),
      percentage: num(row.percentage),
      gradeLabel: row.grade_label,
      gpa: num(row.gpa),
    };
  });

  const output = buildMinistryExport(
    {
      decimalPlaces: template.decimal_places,
      columns: template.columns.map((column) => ({
        header: column.header,
        field: column.field,
        constantValue: column.constant_value,
        valueMap: column.value_map,
      })),
    },
    source,
    { nationalIdSourceSet: fieldId !== null },
  );

  const studentRows = new Map<string, MinistryExportSourceRow>();
  const subjects = new Map<string, { id: string; code: string; name: string }>();
  for (const row of source) {
    if (!studentRows.has(row.studentId)) studentRows.set(row.studentId, row);
    if (row.subject) subjects.set(row.subject.id, row.subject);
  }
  const issues: MinistryExportIssueView[] = output.issues.map((found) => {
    const student = found.studentId ? studentRows.get(found.studentId) : undefined;
    const subject = found.subjectId ? subjects.get(found.subjectId) : undefined;
    return {
      ...blankIssue,
      code: found.code,
      severity: "error",
      count: found.count,
      ...(student
        ? {
            student_id: student.studentId,
            student_name: [student.firstName, student.lastName].join(" "),
            admission_number: student.admissionNumber,
            section_id: student.sectionId,
            section_name: student.section,
            grade_level_name: student.gradeLevel,
          }
        : {}),
      ...(subject
        ? { subject_id: subject.id, subject_code: subject.code, subject_name: subject.name }
        : {}),
    };
  });
  for (const section of sections) {
    if (section.finalization_id !== null || section.archived) continue;
    issues.push({
      ...blankIssue,
      code: "section_not_finalized",
      severity: "warning",
      count: 0,
      section_id: section.id,
      section_name: section.name,
      grade_level_name: section.grade_level_name,
    });
  }

  return {
    template,
    period,
    sections,
    header: output.header,
    rows: output.rows,
    numericColumns: output.numericColumns,
    issues,
    students: studentIds.length,
    nationalIds,
  };
}

export async function previewMinistryExport(
  tx: TransactionSql,
  actor: MinistryExportActor,
  input: MinistryExportRunInput,
): Promise<MinistryExportPreviewView> {
  const built = await buildExport(tx, actor, input, { open: false });
  return {
    template_id: built.template.id,
    file_format: built.template.file_format,
    total_rows: built.rows.length,
    students: built.students,
    sections_included: built.sections.filter((section) => section.finalization_id !== null).length,
    header: built.header,
    rows: built.rows.slice(0, MINISTRY_EXPORT_LIMITS.previewRows).map((cells) => ({ cells })),
    national_ids_masked: built.nationalIds?.masked ?? false,
    issues: built.issues,
  };
}

export interface MinistryExportFile {
  template: MinistryExportTemplateView;
  period: Period;
  header: string[];
  rows: string[][];
  numericColumns: boolean[];
}

/**
 * The whole file's rows, national IDs opened. Audited: the download itself (`export` on the
 * template), and, when sensitive values were opened, a reveal (`read` on the record field naming
 * the students), as the records module audits one.
 */
export async function runMinistryExport(
  tx: TransactionSql,
  actor: MinistryExportActor,
  input: MinistryExportRunInput,
  keyring: RecordKeyring,
): Promise<MinistryExportFile> {
  const built = await buildExport(tx, actor, input, { open: true, keyring });
  const fieldId = built.template.national_id_field?.id ?? null;
  const revealed = built.nationalIds?.sealed ?? [];
  if (fieldId !== null && revealed.length > 0) {
    await emitAuditLog(tx, {
      action: "read",
      targetTable: "record_fields",
      targetId: fieldId,
      newValues: {
        field_id: fieldId,
        subject_kind: "student",
        subject_ids: revealed,
        reveal: true,
        purpose: "ministry_export",
        template_id: built.template.id,
      },
    });
  }
  await emitAuditLog(tx, {
    action: "export",
    targetTable: "ministry_export_templates",
    targetId: built.template.id,
    newValues: {
      academic_year_id: input.academic_year_id,
      term_id: input.term_id,
      grade_level_ids: input.grade_level_ids ?? [],
      section_ids: input.section_ids ?? [],
      finalization_ids: built.sections.flatMap((section) =>
        section.finalization_id === null ? [] : [section.finalization_id],
      ),
      file_format: built.template.file_format,
      rows: built.rows.length,
      students: built.students,
      issues: built.issues.length,
      sensitive_national_ids_opened: revealed.length,
    },
  });
  return {
    template: built.template,
    period: built.period,
    header: built.header,
    rows: built.rows,
    numericColumns: built.numericColumns,
  };
}
