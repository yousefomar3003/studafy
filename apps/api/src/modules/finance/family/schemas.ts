import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import type { SupportedLocale } from "../../../middleware/locale";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .openapi({ example: "2026-07-30" });

export const familyFinancialViewParamSchema = z
  .object({
    familyId: z
      .string()
      .uuid()
      .openapi({ param: { name: "familyId", in: "path" }, description: "Local family UUID." }),
  })
  .openapi("FamilyFinancialViewParam");

const currencyTotalSchema = z
  .object({
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    total_amount: z
      .string()
      .openapi({ description: "Decimal string at the currency's precision." }),
    total_amount_minor: z.number().int(),
    paid_amount: z.string().openapi({ description: "Decimal string at the currency's precision." }),
    paid_amount_minor: z.number().int(),
    outstanding_amount: z
      .string()
      .openapi({ description: "Decimal string at the currency's precision." }),
    outstanding_amount_minor: z.number().int(),
  })
  .openapi("CurrencyTotal");

const invoiceSummarySchema = z
  .object({
    erpnext_docname: z.string().openapi({ description: "ERPNext Sales Invoice document name." }),
    erpnext_status: z.string().openapi({ description: "ERPNext's own docstatus, as a word." }),
    issued_date: dateSchema,
    due_date: dateSchema.nullable(),
    total_amount: z.string(),
    total_amount_minor: z.number().int(),
    outstanding_amount: z.string(),
    outstanding_amount_minor: z.number().int(),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    pay_online_url: z
      .string()
      .nullable()
      .openapi({
        description:
          "Entry point for the pay-online redirect, present only when the invoice still owes " +
          "money and PAYMENT_REDIRECT_BASE_URL is configured.",
      }),
    synced_at: dateTimeSchema,
  })
  .openapi("FamilyInvoiceSummary");

const installmentSummarySchema = z
  .object({
    erpnext_fee_schedule_id: z
      .string()
      .openapi({ description: "ERPNext Fee Schedule document name." }),
    fee_structure_id: uuidSchema.nullable(),
    due_date: dateSchema,
    total_amount: z.string(),
    total_amount_minor: z.number().int(),
    paid_amount: z.string(),
    paid_amount_minor: z.number().int(),
    outstanding_amount: z.string(),
    outstanding_amount_minor: z.number().int(),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    status: z.enum(["pending", "partially_paid", "paid", "overdue"]),
    synced_at: dateTimeSchema,
  })
  .openapi("FamilyInstallmentSummary");

const paymentSummarySchema = z
  .object({
    id: uuidSchema,
    erpnext_payment_entry_id: z.string().nullable(),
    erpnext_invoice_id: z.string().nullable(),
    amount: z.string(),
    amount_minor: z.number().int(),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    payment_mode: z.enum(["cash", "bank_transfer", "card_external"]).nullable(),
    status: z.enum(["pending", "confirmed", "failed"]),
    erpnext_status: z.string(),
    receipt_url: z.string().nullable(),
    payment_date: dateSchema,
    confirmed_at: dateTimeSchema.nullable(),
    last_synced_at: dateTimeSchema,
  })
  .openapi("FamilyPaymentSummary");

const familyStudentSectionSchema = z
  .object({
    student_id: uuidSchema,
    customer_ids: z
      .array(z.string())
      .openapi({ description: "ERPNext Customer names (admission numbers) for this child." }),
    invoices: z.array(invoiceSummarySchema),
    installments: z.array(installmentSummarySchema),
    payments: z.array(paymentSummarySchema),
    totals: z.array(currencyTotalSchema),
  })
  .openapi("FamilyStudentSection");

const familyFinancialViewPresentationSchema = z
  .object({
    locale: z.enum(["en", "ar"]),
    direction: z.enum(["ltr", "rtl"]),
    currency: z.literal("JOD"),
    currency_precision: z.literal(3),
  })
  .openapi("FamilyFinancialViewPresentation");

export const familyFinancialViewResponseSchema = z
  .object({
    family_id: uuidSchema,
    students: z.array(familyStudentSectionSchema),
    household_totals: z.array(currencyTotalSchema),
    data_as_of: dateTimeSchema.nullable().openapi({
      description:
        "Most recent cache sync among the rows returned; null when no finance data exists yet.",
    }),
    reconciled_at: dateTimeSchema.nullable().openapi({
      description:
        "Most recent ERPNext reconciliation run for this school; null before the first run.",
    }),
    presentation: familyFinancialViewPresentationSchema,
  })
  .openapi("FamilyFinancialView");

export type FamilyFinancialViewResponse = z.infer<typeof familyFinancialViewResponseSchema>;
export type FamilyStudentSection = z.infer<typeof familyStudentSectionSchema>;
export interface FamilyPresentation {
  locale: SupportedLocale;
  direction: "ltr" | "rtl";
  currency: "JOD";
  currency_precision: 3;
}
