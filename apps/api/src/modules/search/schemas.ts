import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { userStatusSchema } from "../../openapi/components";
import {
  academicYearStatusSchema,
  catalogStatusSchema,
  classStatusSchema,
  materialIngestStatusSchema,
  roomTypeSchema,
} from "../academics/schemas";
import {
  disciplineIncidentStatusSchema,
  disciplineIncidentTypeSchema,
  disciplineSeveritySchema,
} from "../discipline/schemas";
import { studentStatusSchema } from "../users/schemas";

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_OFFSET,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  SEARCH_TYPES,
} from "./service";

// ---------------------------------------------------------------------------
// Type enum
// ---------------------------------------------------------------------------

export const searchTypeSchema = z.enum(SEARCH_TYPES).openapi("SearchType", {
  description:
    "A record type global search can return. Each one is a section of the response, gated by " +
    "the permission that type's own list endpoint requires.",
});

/**
 * `types` arrives as a string for `?types=a` and as a string[] for `?types=a&types=b` (Hono's query
 * validator collapses single values); a comma-separated `?types=a,b` is accepted too. Normalized to
 * a de-duplicated array before validation, so OpenAPI documents it as a plain array.
 */
const searchTypesParamSchema = z
  .preprocess((value) => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((part) =>
      typeof part === "string" ? part.split(",") : [part],
    );
    const trimmed = parts.map((part) => (typeof part === "string" ? part.trim() : part));
    return [...new Set(trimmed.filter((part) => part !== ""))];
  }, z.array(searchTypeSchema).min(1).max(SEARCH_TYPES.length).optional())
  .openapi({
    param: { style: "form", explode: true },
    description:
      "Which types to search. Omitted: every type. Repeat the parameter (`types=classes&types=" +
      "rooms`) or comma-separate it. A type the caller may not read is still accepted and comes " +
      "back empty with a zero total.",
  });

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export const searchQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(
        SEARCH_QUERY_MIN_LENGTH,
        `Search phrase must be at least ${SEARCH_QUERY_MIN_LENGTH} characters`,
      )
      .max(SEARCH_QUERY_MAX_LENGTH)
      .openapi({
        description:
          "Search phrase. Normalized (case, Arabic diacritics, tatweel and letter forms), split into " +
          "letter/digit words, and matched as all of them with the last one as a prefix: `oma` " +
          "finds Omar, `inv-00` finds INV-0012. Sections with names fall back to typo-tolerant " +
          "trigram matching when nothing matches exactly.",
        example: "ahmad",
      }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SEARCH_MAX_LIMIT)
      .default(SEARCH_DEFAULT_LIMIT)
      .openapi({
        description: "Maximum hits per section -- not a total cap across all sections combined.",
      }),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(SEARCH_MAX_OFFSET)
      .default(0)
      .openapi({
        description:
          "Hits to skip in every searched section, for paging one type on a full results page " +
          "(pair it with a single `types` value). `totals` gives the number to page through.",
      }),
    types: searchTypesParamSchema,
  })
  .openapi("SearchQuery");

export type SearchQuery = z.infer<typeof searchQuerySchema>;

// ---------------------------------------------------------------------------
// Per-type hits
// ---------------------------------------------------------------------------

const rankSchema = z
  .number()
  .openapi({ description: "Relevance: ts_rank, or trigram word similarity for a typo match." });

export const studentSearchHitSchema = z
  .object({
    id: uuidSchema,
    first_name: z.string(),
    last_name: z.string(),
    preferred_name: z.string().nullable(),
    admission_number: z.string(),
    status: studentStatusSchema,
    rank: rankSchema,
  })
  .openapi("StudentSearchHit");

export const userSearchHitSchema = z
  .object({
    id: uuidSchema,
    display_name: z.string().nullable(),
    email: z.string().nullable(),
    status: userStatusSchema,
    rank: rankSchema,
  })
  .openapi("UserSearchHit");

export const invoiceSearchHitSchema = z
  .object({
    id: uuidSchema,
    erpnext_docname: z.string().openapi({ description: "The invoice number." }),
    erpnext_status: z.string(),
    total_amount: z.string(),
    total_amount_minor: z.number().int(),
    currency: z.string().length(3),
    student_id: uuidSchema,
    student_name: z
      .string()
      .nullable()
      .openapi({
        description:
          "Null when the caller cannot read the linked student record under row-level security " +
          "(e.g. a FINANCE caller with no admin or teaching relationship to that student). The " +
          "invoice itself still appears.",
      }),
    rank: rankSchema,
  })
  .openapi("InvoiceSearchHit");

export const materialSearchHitSchema = z
  .object({
    id: uuidSchema,
    class_id: uuidSchema,
    title: z.string(),
    description: z.string().nullable(),
    ingest_status: materialIngestStatusSchema,
    rank: rankSchema,
  })
  .openapi("MaterialSearchHit");

export const classSearchHitSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    course_id: uuidSchema,
    course_name: z.string().nullable(),
    status: classStatusSchema,
    academic_year_id: uuidSchema,
    term_id: uuidSchema,
    section_id: uuidSchema.nullable(),
    rank: rankSchema,
  })
  .openapi("ClassSearchHit");

export const sectionSearchHitSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    grade_level_id: uuidSchema,
    grade_level_name: z.string(),
    academic_year_id: uuidSchema,
    archived: z.boolean(),
    rank: rankSchema,
  })
  .openapi("SectionSearchHit");

export const subjectSearchHitSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    status: catalogStatusSchema,
    rank: rankSchema,
  })
  .openapi("SubjectSearchHit");

export const gradeLevelSearchHitSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    archived: z.boolean(),
    rank: rankSchema,
  })
  .openapi("GradeLevelSearchHit");

export const academicYearSearchHitSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    status: academicYearStatusSchema,
    starts_on: dateSchema,
    ends_on: dateSchema,
    rank: rankSchema,
  })
  .openapi("AcademicYearSearchHit");

export const termSearchHitSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    academic_year_id: uuidSchema,
    academic_year_name: z.string(),
    status: academicYearStatusSchema,
    starts_on: dateSchema,
    ends_on: dateSchema,
    rank: rankSchema,
  })
  .openapi("TermSearchHit");

export const roomSearchHitSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    building: z.string().nullable(),
    room_type: roomTypeSchema,
    is_active: z.boolean(),
    rank: rankSchema,
  })
  .openapi("RoomSearchHit");

export const familySearchHitSchema = z
  .object({
    id: uuidSchema.openapi({ description: "The family id (the `familyId` of family pages)." }),
    display_name: z.string(),
    primary_parent_user_id: uuidSchema,
    primary_parent_name: z.string().nullable(),
    rank: rankSchema,
  })
  .openapi("FamilySearchHit");

export const announcementSearchHitSchema = z
  .object({
    id: uuidSchema,
    title: z.string(),
    status: z.enum(["scheduled", "published"]),
    audience_type: z.enum(["school", "role", "class"]),
    scheduled_at: dateTimeSchema,
    published_at: dateTimeSchema.nullable(),
    rank: rankSchema,
  })
  .openapi("AnnouncementSearchHit");

export const eventSearchHitSchema = z
  .object({
    id: uuidSchema,
    title: z.string(),
    kind: z.enum(["holiday", "event", "meeting", "exam_period"]),
    starts_on: dateSchema,
    ends_on: dateSchema,
    rank: rankSchema,
  })
  .openapi("EventSearchHit");

export const incidentSearchHitSchema = z
  .object({
    id: uuidSchema,
    title: z.string(),
    incident_type: disciplineIncidentTypeSchema,
    severity: disciplineSeveritySchema,
    status: disciplineIncidentStatusSchema,
    incident_at: dateTimeSchema,
    student_id: uuidSchema,
    student_name: z.string().nullable(),
    class_id: uuidSchema.nullable(),
    rank: rankSchema,
  })
  .openapi("IncidentSearchHit");

export const evaluationSearchHitSchema = z
  .object({
    id: uuidSchema,
    teacher_id: uuidSchema,
    teacher_user_id: uuidSchema,
    teacher_name: z.string().nullable(),
    evaluation_type: z.string(),
    status: z.string(),
    evaluated_at: dateTimeSchema,
    class_id: uuidSchema.nullable(),
    rank: rankSchema,
  })
  .openapi("EvaluationSearchHit");

export const feeStructureSearchHitSchema = z
  .object({
    id: uuidSchema,
    title: z.string(),
    erpnext_name: z.string(),
    erpnext_status: z.string(),
    is_active: z.boolean(),
    total_amount: z.string(),
    total_amount_minor: z.number().int(),
    currency: z.string().length(3),
    academic_year_id: uuidSchema.nullable(),
    academic_year_name: z.string().nullable(),
    rank: rankSchema,
  })
  .openapi("FeeStructureSearchHit");

export const scholarshipSearchHitSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    discount_type: z.enum(["percentage", "fixed"]),
    percentage: z.string().nullable(),
    amount: z.string().nullable(),
    amount_minor: z.number().int().nullable(),
    currency: z.string().length(3).nullable(),
    fee_category: z.string().nullable(),
    is_active: z.boolean(),
    rank: rankSchema,
  })
  .openapi("ScholarshipSearchHit");

export const expenseSearchHitSchema = z
  .object({
    id: uuidSchema,
    vendor: z.string(),
    category: z.string(),
    document_type: z.string(),
    erpnext_docname: z.string(),
    erpnext_status: z.string(),
    amount: z.string(),
    amount_minor: z.number().int(),
    currency: z.string().length(3),
    expense_date: dateSchema,
    rank: rankSchema,
  })
  .openapi("ExpenseSearchHit");

export const notificationSearchHitSchema = z
  .object({
    id: uuidSchema,
    title: z.string(),
    notification_type: z.string(),
    read_at: dateTimeSchema.nullable(),
    created_at: dateTimeSchema,
    rank: rankSchema,
  })
  .openapi("NotificationSearchHit");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const globalSearchResultsSchema = z
  .object({
    students: z.array(studentSearchHitSchema),
    users: z.array(userSearchHitSchema),
    invoices: z.array(invoiceSearchHitSchema),
    materials: z.array(materialSearchHitSchema),
    classes: z.array(classSearchHitSchema),
    sections: z.array(sectionSearchHitSchema),
    subjects: z.array(subjectSearchHitSchema),
    grade_levels: z.array(gradeLevelSearchHitSchema),
    academic_years: z.array(academicYearSearchHitSchema),
    terms: z.array(termSearchHitSchema),
    rooms: z.array(roomSearchHitSchema),
    families: z.array(familySearchHitSchema),
    announcements: z.array(announcementSearchHitSchema),
    events: z.array(eventSearchHitSchema),
    incidents: z.array(incidentSearchHitSchema),
    evaluations: z.array(evaluationSearchHitSchema),
    fee_structures: z.array(feeStructureSearchHitSchema),
    scholarships: z.array(scholarshipSearchHitSchema),
    expenses: z.array(expenseSearchHitSchema),
    notifications: z.array(notificationSearchHitSchema),
  })
  .openapi("GlobalSearchResults", {
    description:
      "One array per type, always all of them. A type that was not requested, or that the " +
      "caller's role may not read, is an empty array, never omitted.",
  });

const totalSchema = z.number().int().min(0);

export const globalSearchTotalsSchema = z
  .object({
    students: totalSchema,
    users: totalSchema,
    invoices: totalSchema,
    materials: totalSchema,
    classes: totalSchema,
    sections: totalSchema,
    subjects: totalSchema,
    grade_levels: totalSchema,
    academic_years: totalSchema,
    terms: totalSchema,
    rooms: totalSchema,
    families: totalSchema,
    announcements: totalSchema,
    events: totalSchema,
    incidents: totalSchema,
    evaluations: totalSchema,
    fee_structures: totalSchema,
    scholarships: totalSchema,
    expenses: totalSchema,
    notifications: totalSchema,
  })
  .openapi("GlobalSearchTotals", {
    description:
      'Total matches per type the caller can see (for paging and "See all N"), independent of ' +
      "`limit` and `offset`. 0 for a type not requested or not permitted.",
  });

export const globalSearchResultSchema = z
  .object({
    query: z.string(),
    types: z.array(searchTypeSchema).openapi({
      description: "The types requested (every type when `types` was omitted), in canonical order.",
    }),
    results: globalSearchResultsSchema,
    totals: globalSearchTotalsSchema,
  })
  .openapi("GlobalSearchResult");
