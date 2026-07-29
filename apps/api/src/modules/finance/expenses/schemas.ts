import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

export const expenseDocumentTypeSchema = z
  .enum(["purchase_invoice", "expense_claim", "journal_entry"])
  .openapi("ExpenseDocumentType");

export const expenseIdParamSchema = z
  .object({
    expenseId: z
      .string()
      .min(1)
      .openapi({
        param: { name: "expenseId", in: "path" },
        description:
          "The expense id. This is either the Studafy UUID or the ERPNext docname; the service resolves either.",
      }),
  })
  .openapi("ExpenseIdParam");

export const expenseQuerySchema = z
  .object({
    document_type: expenseDocumentTypeSchema.optional().openapi({
      description: "Filter by ERPNext document type.",
    }),
    category: z.string().min(1).optional().openapi({
      description: "Filter by expense category (ERPNext account / expense claim type docname).",
    }),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({ description: "Filter expenses on or after this date (YYYY-MM-DD)." }),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({ description: "Filter expenses on or before this date (YYYY-MM-DD)." }),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("ExpenseQuery");

export const expenseSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Studafy internal id." }),
    school_id: uuidSchema,
    document_type: expenseDocumentTypeSchema,
    category: z.string().openapi({ description: "ERPNext category docname." }),
    vendor: z.string().openapi({ description: "Supplier, employee, or reference." }),
    description: z.string().nullable(),
    amount: z.string().openapi({
      description: "Decimal string at the currency's precision, e.g. '125.500'.",
    }),
    amount_minor: z.number().int().openapi({ description: "Integer minor units." }),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    erpnext_name: z.string().nullable().openapi({ description: "ERPNext document name." }),
    erpnext_status: z.string(),
    attachment_url: z.string().nullable().openapi({
      description: "Pre-signed download URL for the attachment, if one exists.",
    }),
    expense_date: z
      .string()
      .openapi({ description: "Date the expense was recorded (YYYY-MM-DD)." }),
    last_synced_at: dateTimeSchema,
  })
  .openapi("Expense");

export const expenseListSchema = z
  .object({
    expenses: z.array(expenseSchema),
    total: z.number().int(),
  })
  .openapi("ExpenseList");

export const createExpenseBodySchema = z
  .object({
    document_type: expenseDocumentTypeSchema,
    category: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .openapi({
        description:
          "ERPNext category: expense account docname (Purchase Invoice), expense claim type docname " +
          "(Expense Claim), or account docname (Journal Entry).",
      }),
    vendor: z.string().trim().min(1).max(200).openapi({
      description:
        "Supplier name (Purchase Invoice), employee (Expense Claim), or reference (Journal Entry).",
    }),
    amount: z
      .number()
      .positive()
      .openapi({ description: "Decimal amount in the expense currency." }),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .default("JOD"),
    description: z.string().max(1000).optional(),
    expense_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({ description: "Expense date in YYYY-MM-DD format. Defaults to today." }),
    attachment_storage_key: z.string().min(1).optional().openapi({
      description:
        "S3 storage key for a pre-uploaded attachment. Obtain via the upload-url endpoint.",
    }),
  })
  .openapi("CreateExpenseBody");

export const updateExpenseBodySchema = createExpenseBodySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update" })
  .openapi("UpdateExpenseBody");

export const uploadUrlBodySchema = z
  .object({
    file_name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .openapi({ description: "Desired file name for the attachment." }),
    content_type: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "MIME type of the file, e.g. image/pdf." }),
  })
  .openapi("UploadUrlBody");

export const uploadUrlResponseSchema = z
  .object({
    upload_url: z.string().openapi({ description: "Pre-signed URL for direct file upload." }),
    storage_key: z.string().openapi({ description: "Storage key to reference the uploaded file." }),
    expires_at: dateTimeSchema,
  })
  .openapi("UploadUrlResponse");

export const confirmAttachmentBodySchema = z
  .object({
    storage_key: z.string().min(1).openapi({
      description: "The storage key returned by the upload-url endpoint, now confirmed uploaded.",
    }),
  })
  .openapi("ConfirmAttachmentBody");

export const expenseSummaryQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100).openapi({
      description: "Calendar year for the summary.",
    }),
    month: z.coerce.number().int().min(1).max(12).openapi({
      description: "Calendar month (1-12).",
    }),
    document_type: expenseDocumentTypeSchema.optional(),
  })
  .openapi("ExpenseSummaryQuery");

const expenseCategorySummarySchema = z
  .object({
    category: z.string(),
    total_amount: z.string(),
    total_amount_minor: z.number().int(),
    count: z.number().int(),
  })
  .openapi("ExpenseCategorySummary");

export const expenseSummarySchema = z
  .object({
    year: z.number().int(),
    month: z.number().int(),
    categories: z.array(expenseCategorySummarySchema),
    grand_total: z.string(),
    grand_total_minor: z.number().int(),
  })
  .openapi("ExpenseSummary");
