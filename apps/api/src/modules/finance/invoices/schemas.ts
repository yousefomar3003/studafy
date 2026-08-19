import { z } from "@hono/zod-openapi";
import {
  dateSchema,
  dateTimeSchema,
  paginationQuerySchema,
  uuidSchema,
} from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/** The only three values `erpNextStatusFromDocstatus` (payments/projection.ts) ever produces for a
 * Sales Invoice, mirroring `KNOWN_STATUS_LABELS` in the frontend's fee-structure `labels.ts`. */
export const invoiceStatusValues = ["draft", "submitted", "cancelled"] as const;
export const invoiceStatusSchema = z.enum(invoiceStatusValues);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

export const invoiceBatchStatusValues = ["pending", "processing", "completed", "failed"] as const;
export const invoiceBatchStatusSchema = z.enum(invoiceBatchStatusValues);
export type InvoiceBatchStatus = z.infer<typeof invoiceBatchStatusSchema>;

export const invoiceBatchItemStatusValues = [
  "pending",
  "succeeded",
  "already_existed",
  "failed",
] as const;
export const invoiceBatchItemStatusSchema = z.enum(invoiceBatchItemStatusValues);
export type InvoiceBatchItemStatus = z.infer<typeof invoiceBatchItemStatusSchema>;

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const invoiceIdParamSchema = z
  .object({
    invoiceId: uuidSchema.openapi({
      param: { name: "invoiceId", in: "path" },
      description: "app.invoice_cache row id.",
    }),
  })
  .openapi("InvoiceIdParam");

export const invoiceBatchIdParamSchema = z
  .object({
    batchId: uuidSchema.openapi({
      param: { name: "batchId", in: "path" },
      description: "app.invoice_batches row id.",
    }),
  })
  .openapi("InvoiceBatchIdParam");

// ---------------------------------------------------------------------------
// Invoice list / detail
// ---------------------------------------------------------------------------

export const invoiceQuerySchema = paginationQuerySchema
  .extend({
    status: invoiceStatusSchema.optional(),
    student_id: uuidSchema.optional().openapi({ description: "Filter to one student." }),
    search: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .openapi({
        description:
          "Matched against the invoice number first (exact, indexed — the fast path for " +
          "'search by number'); only when that finds nothing does it fall back to a partial, " +
          "case-insensitive match over the student's name or admission number.",
      }),
  })
  .openapi("InvoiceQuery");

export const invoiceSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    student_id: uuidSchema,
    student_name: z.string(),
    admission_number: z.string(),
    erpnext_docname: z.string().openapi({ description: "The invoice number." }),
    erpnext_status: z.string(),
    // Strings, not numbers: minor units at the currency's own precision — see
    // `formatMinorUnits`'s doc comment in `../currency.ts` for why JOD's 3 decimals rules out a
    // float here, same reasoning `feeStructureSchema.total_amount` already documents.
    total_amount: z.string(),
    total_amount_minor: z.number().int(),
    outstanding_amount: z.string(),
    outstanding_amount_minor: z.number().int(),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    issued_date: dateSchema,
    due_date: dateSchema.nullable(),
    last_synced_at: dateTimeSchema,
  })
  .openapi("Invoice");

export const invoiceListSchema = z
  .object({
    invoices: z.array(invoiceSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi("InvoiceList");

const invoiceLineSchema = z
  .object({
    fee_category: z.string(),
    description: z.string().nullable(),
    quantity: z.number(),
    // A plain decimal number, not a minor-units string: ERPNext's own Sales Invoice Item payload
    // (`erpnext_payload.items[].rate`) already carries a decimal, so re-encoding it through
    // `formatMinorUnits` would add a conversion this data was never put through in the first
    // place. `getInvoiceDetail` (service.ts) parses it defensively — a malformed item is dropped,
    // not guessed at.
    amount: z.number(),
  })
  .openapi("InvoiceLine");

export const invoiceDetailSchema = invoiceSchema
  .extend({ lines: z.array(invoiceLineSchema) })
  .openapi("InvoiceDetail");

// ---------------------------------------------------------------------------
// Batch generation
// ---------------------------------------------------------------------------

export const createInvoiceBatchBodySchema = z
  .object({
    fee_structure_erpnext_name: z
      .string()
      .trim()
      .min(1)
      .openapi({ description: "ERPNext Fee Structure document name to invoice against." }),
    period_title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .openapi({ description: "Human-readable billing period, e.g. 'Spring 2026 Term 1'." }),
    due_date: dateSchema.optional(),
    target_class_ids: z
      .array(uuidSchema)
      .min(1)
      .max(500)
      .optional()
      .openapi({
        description:
          "Limit the batch to students actively enrolled in these classes. Omitted = every " +
          "student in the school. The resulting student list is capped at 5,000.",
      }),
  })
  .openapi("CreateInvoiceBatchBody");

export const invoiceBatchSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    created_by: uuidSchema,
    status: invoiceBatchStatusSchema,
    fee_structure_erpnext_name: z.string(),
    period_title: z.string(),
    due_date: dateSchema.nullable(),
    target_class_ids: z.array(uuidSchema).nullable(),
    total_count: z.number().int(),
    succeeded_count: z.number().int(),
    already_existed_count: z.number().int(),
    failed_count: z.number().int(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
    completed_at: dateTimeSchema.nullable(),
  })
  .openapi("InvoiceBatch");

export const invoiceBatchListQuerySchema = paginationQuerySchema.openapi("InvoiceBatchListQuery");

export const invoiceBatchListSchema = z
  .object({
    invoice_batches: z.array(invoiceBatchSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi("InvoiceBatchList");

export const invoiceBatchItemQuerySchema = paginationQuerySchema
  .extend({ status: invoiceBatchItemStatusSchema.optional() })
  .openapi("InvoiceBatchItemQuery");

export const invoiceBatchItemSchema = z
  .object({
    id: uuidSchema,
    batch_id: uuidSchema,
    student_id: uuidSchema,
    student_name: z.string(),
    admission_number: z.string(),
    status: invoiceBatchItemStatusSchema,
    erpnext_docname: z.string().nullable(),
    error_message: z.string().nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("InvoiceBatchItem");

export const invoiceBatchItemListSchema = z
  .object({
    items: z.array(invoiceBatchItemSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi("InvoiceBatchItemList");
