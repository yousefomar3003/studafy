import { z } from "@hono/zod-openapi";
import { uuidSchema } from "@studafy/shared-schemas";

import { userStatusSchema } from "../../openapi/components";
import { materialIngestStatusSchema } from "../academics/schemas";
import { studentStatusSchema } from "../users/schemas";

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
} from "./service";

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
        description: "Search phrase. Runs through websearch_to_tsquery per section.",
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
  })
  .openapi("SearchQuery");

export type SearchQuery = z.infer<typeof searchQuerySchema>;

// ---------------------------------------------------------------------------
// Per-type hits
// ---------------------------------------------------------------------------

export const studentSearchHitSchema = z
  .object({
    id: uuidSchema,
    first_name: z.string(),
    last_name: z.string(),
    preferred_name: z.string().nullable(),
    admission_number: z.string(),
    status: studentStatusSchema,
    rank: z.number().openapi({ description: "ts_rank score against this row's search_tsv." }),
  })
  .openapi("StudentSearchHit");

export const userSearchHitSchema = z
  .object({
    id: uuidSchema,
    display_name: z.string().nullable(),
    email: z.string(),
    status: userStatusSchema,
    rank: z.number(),
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
    rank: z.number(),
  })
  .openapi("InvoiceSearchHit");

export const materialSearchHitSchema = z
  .object({
    id: uuidSchema,
    class_id: uuidSchema,
    title: z.string(),
    description: z.string().nullable(),
    ingest_status: materialIngestStatusSchema,
    rank: z.number(),
  })
  .openapi("MaterialSearchHit");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export const globalSearchResultSchema = z
  .object({
    query: z.string(),
    results: z
      .object({
        students: z.array(studentSearchHitSchema),
        users: z.array(userSearchHitSchema),
        invoices: z.array(invoiceSearchHitSchema),
        materials: z.array(materialSearchHitSchema),
      })
      .openapi({
        description:
          "One array per type. A type the caller's role has no read permission for is always " +
          "present as an empty array, never omitted.",
      }),
  })
  .openapi("GlobalSearchResult");
