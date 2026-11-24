import { z } from "@hono/zod-openapi";
import {
  MINISTRY_EXPORT_ENCODINGS,
  MINISTRY_EXPORT_EXAMPLE_KEYS,
  MINISTRY_EXPORT_FIELDS,
  MINISTRY_EXPORT_FILE_FORMATS,
  MINISTRY_EXPORT_LIMITS,
  MINISTRY_EXPORT_ROW_KINDS,
} from "@studafy/grading-engine";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

/**
 * Ministry results export (000265). What a template may hold is checked by @studafy/grading-engine
 * (validateMinistryExportTemplate) in the service, so these schemas only bound sizes and types.
 * Shared enums are referenced plainly, with no per-field description or default, and objects are
 * written out rather than extended: the mobile client generator cannot read the alternatives.
 */

export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const LIMITS = MINISTRY_EXPORT_LIMITS;

export const ministryExportTemplateIdParamSchema = z
  .object({
    templateId: z
      .string()
      .uuid()
      .openapi({
        param: { name: "templateId", in: "path" },
        description: "Ministry export template UUID.",
      }),
  })
  .openapi("MinistryExportTemplateIdParam");

export const ministryExportFileFormatSchema = z
  .enum(MINISTRY_EXPORT_FILE_FORMATS)
  .openapi("MinistryExportFileFormat", { description: "csv or xlsx." });

export const ministryExportEncodingSchema = z
  .enum(MINISTRY_EXPORT_ENCODINGS)
  .openapi("MinistryExportEncoding", {
    description:
      "A CSV's encoding: utf8, or utf8_bom (a byte-order mark first, so Excel reads Arabic). An " +
      "XLSX ignores it.",
  });

export const ministryExportRowKindSchema = z
  .enum(MINISTRY_EXPORT_ROW_KINDS)
  .openapi("MinistryExportRowKind", {
    description:
      "subject: one row per student per subject. overall: one row per student (their overall " +
      "result).",
  });

export const ministryExportFieldSchema = z
  .enum(MINISTRY_EXPORT_FIELDS)
  .openapi("MinistryExportField", {
    description:
      "What a column holds. national_id: the student record field the template names. term: the " +
      "term's name, or Annual for the year. status: pass / fail / incomplete / exempt for a " +
      "subject; promoted / supplementary / retained / incomplete overall. subject_ministry_code: " +
      "the template's code for the subject. constant: the column's constant_value on every row. " +
      "Subject fields need subject rows.",
  });

export const ministryExportIssueCodeSchema = z
  .enum([
    "national_id_source_missing",
    "missing_national_id",
    "unmapped_subject",
    "section_not_finalized",
  ])
  .openapi("MinistryExportIssueCode", {
    description:
      "national_id_source_missing: the template has a national ID column but names no record " +
      "field. missing_national_id: a student has no national ID. unmapped_subject: a subject has " +
      "no ministry code. section_not_finalized: a section has no finalized result for the period, " +
      "so its students are not in the file.",
  });

export const ministryExportIssueSeveritySchema = z
  .enum(["error", "warning"])
  .openapi("MinistryExportIssueSeverity");

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const ministryExportValueMapEntrySchema = z
  .object({ from: z.string(), to: z.string() })
  .openapi("MinistryExportValueMapEntry", {
    description: "Our value (after formatting) and what the file says instead.",
  });

export const ministryExportColumnSchema = z
  .object({
    header: z.string(),
    field: ministryExportFieldSchema,
    constant_value: z.string().nullable(),
    value_map: z.array(ministryExportValueMapEntrySchema),
  })
  .openapi("MinistryExportColumn");

export const ministryExportSubjectCodeSchema = z
  .object({
    subject_id: uuidSchema,
    subject_code: z.string(),
    subject_name: z.string(),
    code: z.string(),
  })
  .openapi("MinistryExportSubjectCode");

export const ministryExportNationalIdFieldSchema = z
  .object({
    id: uuidSchema,
    label_en: z.string(),
    label_ar: z.string(),
    sensitive: z.boolean(),
    archived: z.boolean(),
  })
  .openapi("MinistryExportNationalIdField", {
    description:
      "The student record field the national ID is read from. A sensitive one is masked in " +
      "previews and opened only for a download by someone holding studentRecord:readSensitive.",
  });

export const ministryExportTemplateSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    target: z.string(),
    file_format: ministryExportFileFormatSchema,
    encoding: ministryExportEncodingSchema,
    row_kind: ministryExportRowKindSchema,
    decimal_places: z.number().int(),
    national_id_field: ministryExportNationalIdFieldSchema.nullable(),
    columns: z.array(ministryExportColumnSchema),
    subject_codes: z.array(ministryExportSubjectCodeSchema),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("MinistryExportTemplate");

export const ministryExportTemplateListSchema = z
  .object({ templates: z.array(ministryExportTemplateSchema) })
  .openapi("MinistryExportTemplateList");

const valueText = z.string().trim().max(LIMITS.valueMaxLength);

const columnInputSchema = z
  .object({
    header: z.string().trim().min(1).max(LIMITS.headerMaxLength),
    field: ministryExportFieldSchema,
    constant_value: valueText.nullable().optional(),
    value_map: z
      .array(
        z.object({ from: valueText.min(1), to: valueText }).openapi("MinistryExportValueMapInput"),
      )
      .max(LIMITS.maxValueMapEntries)
      .optional(),
  })
  .openapi("MinistryExportColumnInput");

export const ministryExportTemplateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.nameMaxLength),
    target: z.string().trim().max(LIMITS.targetMaxLength).optional(),
    file_format: ministryExportFileFormatSchema,
    encoding: ministryExportEncodingSchema,
    row_kind: ministryExportRowKindSchema,
    decimal_places: z
      .number()
      .int()
      .min(0)
      .max(LIMITS.maxDecimalPlaces)
      .optional()
      .openapi({ description: "Default 2." }),
    national_id_field_id: uuidSchema.nullable().optional(),
    columns: z
      .array(columnInputSchema)
      .min(1)
      .max(LIMITS.maxColumns)
      .openapi({ description: "In file order. Saving replaces the template's columns." }),
    subject_codes: z
      .array(
        z
          .object({
            subject_id: uuidSchema,
            code: z.string().trim().min(1).max(LIMITS.subjectCodeMaxLength),
          })
          .openapi("MinistryExportSubjectCodeInput"),
      )
      .max(LIMITS.maxSubjectCodes)
      .optional()
      .openapi({ description: "The ministry's code per subject. Saving replaces them." }),
  })
  .openapi("MinistryExportTemplateInput");

// ---------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------

export const ministryExportExampleSchema = z
  .object({
    key: z.enum(MINISTRY_EXPORT_EXAMPLE_KEYS).openapi("MinistryExportExampleKey"),
    name_en: z.string(),
    name_ar: z.string(),
    note_en: z.string(),
    note_ar: z.string(),
    template: z
      .object({
        name: z.string(),
        target: z.string(),
        file_format: ministryExportFileFormatSchema,
        encoding: ministryExportEncodingSchema,
        row_kind: ministryExportRowKindSchema,
        decimal_places: z.number().int(),
        columns: z.array(ministryExportColumnSchema),
      })
      .openapi("MinistryExportExampleTemplate"),
  })
  .openapi("MinistryExportExample", {
    description: "An editable starting point. Not an official ministry format.",
  });

export const ministryExportExampleListSchema = z
  .object({ examples: z.array(ministryExportExampleSchema) })
  .openapi("MinistryExportExampleList");

// ---------------------------------------------------------------------------
// Running an export
// ---------------------------------------------------------------------------

export const ministryExportRunBodySchema = z
  .object({
    template_id: uuidSchema,
    academic_year_id: uuidSchema,
    term_id: uuidSchema
      .nullable()
      .openapi({ description: "The term, or null for the year's annual results." }),
    grade_level_ids: z
      .array(uuidSchema)
      .max(200)
      .optional()
      .openapi({ description: "Only these grade levels; none or empty: every grade." }),
    section_ids: z
      .array(uuidSchema)
      .max(500)
      .optional()
      .openapi({ description: "Only these sections of the year; none or empty: every section." }),
  })
  .openapi("MinistryExportRunInput");

export const ministryExportIssueSchema = z
  .object({
    code: ministryExportIssueCodeSchema,
    severity: ministryExportIssueSeveritySchema,
    count: z.number().int().openapi({ description: "Rows affected." }),
    student_id: uuidSchema.nullable(),
    student_name: z.string().nullable(),
    admission_number: z.string().nullable(),
    subject_id: uuidSchema.nullable(),
    subject_code: z.string().nullable(),
    subject_name: z.string().nullable(),
    section_id: uuidSchema.nullable(),
    section_name: z.string().nullable(),
    grade_level_name: z.string().nullable(),
  })
  .openapi("MinistryExportIssue");

export const ministryExportPreviewSchema = z
  .object({
    template_id: uuidSchema,
    file_format: ministryExportFileFormatSchema,
    total_rows: z.number().int(),
    students: z.number().int(),
    sections_included: z.number().int().openapi({
      description: "Sections with a finalized result for the period, whose results are exported.",
    }),
    header: z.array(z.string()),
    rows: z
      .array(z.object({ cells: z.array(z.string()) }).openapi("MinistryExportPreviewRow"))
      .openapi({ description: "The file's first rows, exactly as written." }),
    national_ids_masked: z.boolean().openapi({
      description:
        "The national ID field is sensitive, so the preview shows masks; the download has the " +
        "full values.",
    }),
    issues: z.array(ministryExportIssueSchema),
  })
  .openapi("MinistryExportPreview");
