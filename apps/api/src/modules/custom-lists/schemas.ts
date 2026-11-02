import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import {
  recordColumnFieldTypeSchema,
  recordFieldOptionSchema,
  recordFieldSensitivitySchema,
  recordValueSchema,
} from "../records/schemas";

import {
  CUSTOM_LIST_AUDIENCES,
  CUSTOM_LIST_IMPORT_KEYS,
  CUSTOM_LIST_LINK_KINDS,
  MAX_COLUMNS_PER_LIST,
  MAX_IMPORT_CSV_BYTES,
  MAX_OPTIONS_PER_COLUMN,
  MAX_ROWS_PER_LIST,
} from "./limits";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const customListAudienceSchema = z
  .enum(CUSTOM_LIST_AUDIENCES)
  .openapi("CustomListAudience", {
    description:
      "Who may read and edit the list's rows: admins (ORG_ADMIN), leadership (ORG_ADMIN and " +
      "PRINCIPAL), or staff (every school staff role). Parents and students never see a list.",
  });

export const customListLinkKindSchema = z
  .enum(CUSTOM_LIST_LINK_KINDS)
  .openapi("CustomListLinkKind", { description: "What a row may point to." });

export const customListLinksSchema = z
  .object({
    student: z.boolean(),
    parent: z.boolean(),
    staff: z.boolean(),
    class: z.boolean(),
  })
  .openapi("CustomListLinks", { description: "Which kinds of link the list's rows may carry." });

export const customListImportKeySchema = z
  .enum(CUSTOM_LIST_IMPORT_KEYS)
  .openapi("CustomListImportKey", {
    description:
      "The school-issued key an import links rows by, matched exactly (surrounding spaces and " +
      "letter case aside), never partially: member_id (a Studafy member code: STU- a student, " +
      "TCH- a member of staff, PAR- a parent), admission_number (a student), employee_number (a " +
      "member of staff), class_code (a class). Never a name, email, phone or ID number.",
  });

const nameSchema = z.string().trim().min(1).max(120);
const labelSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(1000);

// ---------------------------------------------------------------------------
// Params and queries
// ---------------------------------------------------------------------------

export const listIdParamSchema = z.object({
  listId: uuidSchema.openapi({ param: { name: "listId", in: "path" } }),
});

export const columnParamSchema = z.object({
  listId: uuidSchema.openapi({ param: { name: "listId", in: "path" } }),
  columnId: uuidSchema.openapi({ param: { name: "columnId", in: "path" } }),
});

export const rowParamSchema = z.object({
  listId: uuidSchema.openapi({ param: { name: "listId", in: "path" } }),
  rowId: uuidSchema.openapi({ param: { name: "rowId", in: "path" } }),
});

export const cellParamSchema = z.object({
  listId: uuidSchema.openapi({ param: { name: "listId", in: "path" } }),
  rowId: uuidSchema.openapi({ param: { name: "rowId", in: "path" } }),
  columnId: uuidSchema.openapi({ param: { name: "columnId", in: "path" } }),
});

export const linkedParamSchema = z.object({
  subjectKind: customListLinkKindSchema.openapi({ param: { name: "subjectKind", in: "path" } }),
  subjectId: uuidSchema.openapi({ param: { name: "subjectId", in: "path" } }),
});

export const customListsQuerySchema = z.object({
  include_archived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true")
    .openapi({ param: { name: "include_archived", in: "query" }, description: "Default false." }),
});

export const customListRowsQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .openapi({
      param: { name: "q", in: "query" },
      description:
        "Free text matched against each row's non-sensitive cells (choices by their labels) and " +
        "the name of what it links to.",
    }),
  sort: z
    .string()
    .regex(
      /^(created_at|updated_at|link|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    )
    .optional()
    .openapi({
      param: { name: "sort", in: "query" },
      description:
        "created_at (default), updated_at, link, or a column id. A sensitive column cannot be " +
        "sorted by.",
    }),
  order: z
    .enum(["asc", "desc"])
    .optional()
    .openapi({ param: { name: "order", in: "query" }, description: "Default asc." }),
  filter_column: uuidSchema.optional().openapi({
    param: { name: "filter_column", in: "query" },
    description: "A column to filter on, with filter_value. Not a sensitive column.",
  }),
  filter_value: z
    .string()
    .trim()
    .max(200)
    .optional()
    .openapi({
      param: { name: "filter_value", in: "query" },
      description:
        "Text columns match it anywhere; numbers, dates (YYYY-MM-DD), yes/no and choices match " +
        "it exactly.",
    }),
  link_kind: z
    .enum([...CUSTOM_LIST_LINK_KINDS, "none"])
    .optional()
    .openapi({
      param: { name: "link_kind", in: "query" },
      description: "Only rows linked to this kind of subject, or none for unlinked rows.",
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .openapi({ param: { name: "limit", in: "query" } }),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_ROWS_PER_LIST)
    .default(0)
    .openapi({ param: { name: "offset", in: "query" } }),
});

export const linkCandidatesQuerySchema = z.object({
  // The kind of subject to find; one the list allows. No description: on a $ref it makes the Dart
  // generator emit a wrapper class that does not compile.
  kind: customListLinkKindSchema.openapi({ param: { name: "kind", in: "query" } }),
  q: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .openapi({
      param: { name: "q", in: "query" },
      description:
        "Part of a name, or of the school's own key: an admission number, employee number, " +
        "member code or class code.",
    }),
});

export const customListExportQuerySchema = z.object({
  lang: z
    .enum(["en", "ar"])
    .optional()
    .openapi({
      param: { name: "lang", in: "query" },
      description: "The language of the header row and of choice labels. Default en.",
    }),
});

// ---------------------------------------------------------------------------
// Lists and columns
// ---------------------------------------------------------------------------

export const customListColumnSchema = z
  .object({
    id: uuidSchema,
    field_type: recordColumnFieldTypeSchema,
    label_en: z.string(),
    label_ar: z.string(),
    required: z.boolean(),
    sensitivity: recordFieldSensitivitySchema,
    sort_order: z.number().int(),
    archived: z.boolean(),
    options: z.array(recordFieldOptionSchema),
  })
  .openapi("CustomListColumn");

export const customListSummarySchema = z
  .object({
    id: uuidSchema,
    name_en: z.string(),
    name_ar: z.string(),
    description: z.string().nullable(),
    audience: customListAudienceSchema,
    links: customListLinksSchema,
    archived: z.boolean(),
    row_count: z.number().int(),
    column_count: z.number().int(),
    can_manage: z
      .boolean()
      .openapi({ description: "Whether the caller may change the list and its columns." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("CustomListSummary");

export const customListListSchema = z
  .object({
    lists: z.array(customListSummarySchema),
    limits: z.object({
      lists: z.number().int(),
      columns_per_list: z.number().int(),
      rows_per_list: z.number().int(),
      rows_per_school: z.number().int(),
    }),
  })
  .openapi("CustomListList");

export const customListDetailSchema = customListSummarySchema
  .extend({
    columns: z
      .array(customListColumnSchema)
      .openapi({ description: "In display order; archived columns included, flagged." }),
  })
  .openapi("CustomListDetail");

export const newCustomListColumnSchema = z
  .object({
    field_type: recordColumnFieldTypeSchema,
    label_en: labelSchema,
    label_ar: labelSchema,
    required: z.boolean().optional(),
    sensitivity: recordFieldSensitivitySchema.optional(),
    options: z.array(recordFieldOptionSchema).max(MAX_OPTIONS_PER_COLUMN).optional(),
  })
  .openapi("NewCustomListColumn");

export const createCustomListBodySchema = z
  .object({
    name_en: nameSchema,
    name_ar: nameSchema,
    description: descriptionSchema.nullable().optional(),
    audience: customListAudienceSchema,
    links: customListLinksSchema,
    columns: z.array(newCustomListColumnSchema).max(MAX_COLUMNS_PER_LIST).optional(),
  })
  .openapi("CreateCustomListBody");

export const updateCustomListBodySchema = z
  .object({
    name_en: nameSchema.optional(),
    name_ar: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    audience: customListAudienceSchema.optional(),
    links: customListLinksSchema.optional(),
    archived: z.boolean().optional(),
  })
  .openapi("UpdateCustomListBody");

export const updateCustomListColumnBodySchema = z
  .object({
    label_en: labelSchema.optional(),
    label_ar: labelSchema.optional(),
    required: z.boolean().optional(),
    archived: z.boolean().optional(),
    options: z
      .array(recordFieldOptionSchema)
      .max(MAX_OPTIONS_PER_COLUMN)
      .optional()
      .openapi({
        description:
          "The column's full set of choices. Existing values may be relabelled and new ones " +
          "added; a choice already used by a row cannot be removed.",
      }),
  })
  .openapi("UpdateCustomListColumnBody");

export const reorderCustomListColumnsBodySchema = z
  .object({
    column_ids: z
      .array(uuidSchema)
      .min(1)
      .max(MAX_COLUMNS_PER_LIST * 4),
  })
  .openapi("ReorderCustomListColumnsBody");

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export const customListRowLinkSchema = z
  .object({
    kind: customListLinkKindSchema,
    id: uuidSchema,
    name: z.string().nullable().openapi({
      description: "Who or what it links to; null when the caller cannot see that person or class.",
    }),
  })
  .openapi("CustomListRowLink");

export const customListCellSchema = z
  .object({
    column_id: uuidSchema,
    value: recordValueSchema.nullable(),
    masked: z.boolean().openapi({ description: "A sensitive cell: value is null, mask is set." }),
    mask: z.string().nullable(),
  })
  .openapi("CustomListCell");

export const customListRowSchema = z
  .object({
    id: uuidSchema,
    link: customListRowLinkSchema.nullable(),
    cells: z
      .array(customListCellSchema)
      .openapi({ description: "One per filled cell of a column that is not archived." }),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("CustomListRow");

export const customListRowPageSchema = z
  .object({
    rows: z.array(customListRowSchema),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi("CustomListRowPage");

const rowLinkInputSchema = z
  .object({ kind: customListLinkKindSchema, id: uuidSchema })
  .openapi("CustomListRowLinkInput");

const cellInputSchema = z
  .object({ column_id: uuidSchema, value: recordValueSchema.nullable() })
  .openapi("CustomListCellInput");

export const createCustomListRowBodySchema = z
  .object({
    link: rowLinkInputSchema.nullable().optional(),
    values: z.array(cellInputSchema).max(MAX_COLUMNS_PER_LIST),
  })
  .openapi("CreateCustomListRowBody");

export const updateCustomListRowBodySchema = z
  .object({
    link: rowLinkInputSchema.nullable().optional().openapi({
      description: "Omit to keep the link, null to remove it.",
    }),
    values: z
      .array(cellInputSchema)
      .max(MAX_COLUMNS_PER_LIST)
      .optional()
      .openapi({ description: "Only the cells to change; a null value empties the cell." }),
  })
  .openapi("UpdateCustomListRowBody");

export const customListLinkCandidateSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    detail: z
      .string()
      .nullable()
      .openapi({
        description:
          "What tells two people of the same name apart: an admission number, an employee number " +
          "or member code, or a class's course.",
      }),
  })
  .openapi("CustomListLinkCandidate");

export const customListLinkCandidatesSchema = z
  .object({ candidates: z.array(customListLinkCandidateSchema) })
  .openapi("CustomListLinkCandidates");

export const revealedCustomListCellSchema = z
  .object({ column_id: uuidSchema, value: recordValueSchema.nullable() })
  .openapi("RevealedCustomListCell");

/** Named, not inline: an inline object here would generate a Dart class called List. */
export const customListRefSchema = z
  .object({ id: uuidSchema, name_en: z.string(), name_ar: z.string() })
  .openapi("CustomListRef");

export const customListLinkedEntrySchema = z
  .object({
    list: customListRefSchema,
    columns: z.array(customListColumnSchema),
    rows: z.array(customListRowSchema),
    total: z.number().int(),
  })
  .openapi("CustomListLinkedEntry");

export const customListLinkedSchema = z
  .object({ lists: z.array(customListLinkedEntrySchema) })
  .openapi("CustomListLinkedRows");

// ---------------------------------------------------------------------------
// Import: a sheet Studafy does not recognise becomes a list
// ---------------------------------------------------------------------------

export const customListImportColumnInputSchema = z
  .object({
    index: z.number().int().min(0).max(255),
    include: z.boolean(),
    label_en: labelSchema.optional(),
    label_ar: labelSchema.optional(),
    field_type: recordColumnFieldTypeSchema.optional(),
    sensitivity: recordFieldSensitivitySchema.optional(),
  })
  .openapi("CustomListImportColumnInput");

/** Named, not inline: an inline object here would generate a Dart class called List. */
export const customListImportListSchema = z
  .object({
    name_en: nameSchema,
    name_ar: nameSchema,
    description: descriptionSchema.nullable().optional(),
    audience: customListAudienceSchema,
  })
  .openapi("CustomListImportList");

export const customListImportBodySchema = z
  .object({
    csv: z.string().min(1).max(MAX_IMPORT_CSV_BYTES),
    file_name: z.string().trim().max(255).optional(),
    list: customListImportListSchema,
    columns: z
      .array(customListImportColumnInputSchema)
      .max(256)
      .optional()
      .openapi({
        description:
          "Per-column choices by position. A column left out keeps its header as label, its " +
          "guessed type and its suggested sensitivity, and is included.",
      }),
    link: z
      .object({
        column_index: z.number().int().min(0).max(255),
        key: customListImportKeySchema,
      })
      .nullable()
      .optional(),
    skip_unmatched: z
      .boolean()
      .optional()
      .openapi({ description: "Leave out rows whose key matched nothing. Default false." }),
  })
  .openapi("CustomListImportBody");

export const applyCustomListImportBodySchema = customListImportBodySchema
  .extend({ preview_token: z.string().regex(/^[0-9a-f]{64}$/) })
  .openapi("ApplyCustomListImportBody");

export const customListImportPreviewSchema = z
  .object({
    header_line: z.number().int(),
    row_count: z.number().int(),
    columns: z.array(
      z.object({
        index: z.number().int(),
        header: z.string(),
        include: z.boolean(),
        label_en: z.string(),
        label_ar: z.string(),
        field_type: recordColumnFieldTypeSchema,
        guessed_type: recordColumnFieldTypeSchema,
        sensitivity: recordFieldSensitivitySchema,
        suggested_sensitive: z.boolean(),
        options: z.array(recordFieldOptionSchema),
        sample: z
          .array(z.string())
          .openapi({ description: "Up to three values; a sensitive column's as masks." }),
        invalid_count: z.number().int(),
        invalid_lines: z.array(z.number().int()).openapi({ description: "The first 20." }),
      }),
    ),
    rows: z.array(
      z.object({
        line: z.number().int(),
        key: z.string().nullable(),
        status: z.enum(["linked", "unmatched", "no_key", "not_linked", "skipped"]),
        reason: z
          .enum(["NO_MATCH", "AMBIGUOUS"])
          .nullable()
          .openapi({
            description:
              "Why a key did not link: nothing in the school has it, or more than one does (a " +
              "class code reused across years). Nothing is ever guessed.",
          }),
        link: customListRowLinkSchema.nullable(),
      }),
    ),
    totals: z.object({
      rows: z.number().int(),
      linked: z.number().int(),
      unmatched: z.number().int(),
      skipped: z.number().int(),
      invalid_cells: z.number().int(),
    }),
    links: customListLinksSchema.openapi({
      description: "The link kinds the new list will allow.",
    }),
    preview_token: z.string(),
  })
  .openapi("CustomListImportPreview");

export const customListImportResultSchema = z
  .object({
    list_id: uuidSchema,
    rows_created: z.number().int(),
    rows_linked: z.number().int(),
    cells_left_empty: z.number().int(),
  })
  .openapi("CustomListImportResult");

export type CustomListAudience = z.infer<typeof customListAudienceSchema>;
export type CustomListLinkKind = z.infer<typeof customListLinkKindSchema>;
export type CustomListLinks = z.infer<typeof customListLinksSchema>;
export type CustomListColumnDto = z.infer<typeof customListColumnSchema>;
export type CustomListSummaryDto = z.infer<typeof customListSummarySchema>;
export type CustomListDetailDto = z.infer<typeof customListDetailSchema>;
export type CustomListRowDto = z.infer<typeof customListRowSchema>;
export type CustomListRowPageDto = z.infer<typeof customListRowPageSchema>;
export type CustomListLinkedDto = z.infer<typeof customListLinkedSchema>;
export type CreateCustomListInput = z.infer<typeof createCustomListBodySchema>;
export type UpdateCustomListInput = z.infer<typeof updateCustomListBodySchema>;
export type NewCustomListColumnInput = z.infer<typeof newCustomListColumnSchema>;
export type UpdateCustomListColumnInput = z.infer<typeof updateCustomListColumnBodySchema>;
export type LinkCandidatesQuery = z.infer<typeof linkCandidatesQuerySchema>;
export type CustomListLinkCandidatesDto = z.infer<typeof customListLinkCandidatesSchema>;
export type CustomListRowsQuery = z.infer<typeof customListRowsQuerySchema>;
export type CreateCustomListRowInput = z.infer<typeof createCustomListRowBodySchema>;
export type UpdateCustomListRowInput = z.infer<typeof updateCustomListRowBodySchema>;
export type CustomListImportInput = z.infer<typeof customListImportBodySchema>;
export type CustomListImportPreviewDto = z.infer<typeof customListImportPreviewSchema>;
export type CustomListImportResultDto = z.infer<typeof customListImportResultSchema>;
