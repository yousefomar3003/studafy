import { z } from "@hono/zod-openapi";
import { financeFileFormatSchema, financeReportTypeSchema } from "@studafy/finance-reporting";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-30" });

export const studentIdsSchema = z
  .string()
  .max(4_000)
  .optional()
  .openapi({ description: "Comma-separated tenant-local student UUIDs." });

export const arAgingQuerySchema = z.object({
  report_date: dateSchema.optional(),
  student_ids: studentIdsSchema,
});

export const generalLedgerQuerySchema = z.object({
  from_date: dateSchema,
  to_date: dateSchema,
  student_ids: studentIdsSchema,
  account: z.string().max(255).optional(),
  voucher_no: z.string().max(255).optional(),
  voucher_type: z.string().max(255).optional(),
});

export const collectionsQuerySchema = z.object({
  report_date: dateSchema.optional(),
  student_ids: studentIdsSchema,
});

export const familyStatementParamSchema = z.object({
  familyId: z.string().uuid(),
});

export const familyStatementQuerySchema = z.object({
  from_date: dateSchema.optional(),
  to_date: dateSchema.optional(),
});

export const joinvoiceParamSchema = z.object({
  invoiceId: z.string().min(1).max(255),
});

export const joinvoiceQuerySchema = z.object({
  format: z.enum(["xml", "json"]).default("xml"),
});

export const financeReportResponseSchema = z
  .object({
    report_name: z.string(),
    columns: z.array(z.unknown()),
    rows: z.array(z.unknown()),
    report_summary: z.array(z.unknown()),
    presentation: z.object({
      locale: z.enum(["en", "ar"]),
      direction: z.enum(["ltr", "rtl"]),
      currency: z.literal("JOD"),
      currency_precision: z.literal(3),
      currency_display: z.array(z.record(z.string(), z.string())),
    }),
  })
  .openapi("FinanceReportResponse");

export const familyStatementResponseSchema = z
  .object({
    family_id: z.string().uuid(),
    student_ids: z.array(z.string().uuid()),
    customer_ids: z.array(z.string()),
    accounts_receivable: financeReportResponseSchema,
    general_ledger: financeReportResponseSchema,
    household_totals: z.array(z.unknown()),
  })
  .openapi("FamilyStatementResponse");

export const joinvoiceJsonResponseSchema = z
  .object({ invoice: z.string() })
  .openapi("JoInvoiceJsonResponse");

const exportStudentIdsSchema = z.array(z.string().uuid()).max(1_000).optional();
const exportReportFormatSchema = z.enum(["csv", "pdf"]);

export const financeExportBodySchema = z
  .discriminatedUnion("report_type", [
    z.object({
      report_type: z.literal("ar_aging"),
      file_format: exportReportFormatSchema,
      parameters: z
        .object({ report_date: dateSchema.optional(), student_ids: exportStudentIdsSchema })
        .default({}),
    }),
    z.object({
      report_type: z.literal("general_ledger"),
      file_format: exportReportFormatSchema,
      parameters: z.object({
        from_date: dateSchema,
        to_date: dateSchema,
        student_ids: exportStudentIdsSchema,
        account: z.string().max(255).optional(),
        voucher_no: z.string().max(255).optional(),
        voucher_type: z.string().max(255).optional(),
      }),
    }),
    z.object({
      report_type: z.literal("collections_vs_due"),
      file_format: exportReportFormatSchema,
      parameters: z
        .object({ report_date: dateSchema.optional(), student_ids: exportStudentIdsSchema })
        .default({}),
    }),
    z.object({
      report_type: z.literal("family_statement"),
      file_format: exportReportFormatSchema,
      parameters: z.object({
        family_id: z.string().uuid(),
        from_date: dateSchema.optional(),
        to_date: dateSchema.optional(),
      }),
    }),
    z.object({
      report_type: z.literal("joinvoice_export"),
      file_format: z.enum(["xml", "json"]),
      parameters: z.object({ invoice_id: z.string().min(1).max(255) }),
    }),
  ])
  .openapi("FinanceExportRequest");

export const financeExportJobParamSchema = z.object({
  jobId: z.string().uuid(),
});

export const financeExportJobResponseSchema = z
  .object({
    id: z.string().uuid(),
    report_type: financeReportTypeSchema,
    file_format: financeFileFormatSchema,
    status: z.enum(["queued", "processing", "completed", "failed"]),
    polling_url: z.string(),
    download_url: z.string().nullable(),
    download_url_expires_at: z.string().datetime().nullable(),
    failure_message: z.string().nullable(),
    created_at: z.string().datetime(),
    started_at: z.string().datetime().nullable(),
    completed_at: z.string().datetime().nullable(),
  })
  .openapi("FinanceExportJob");
