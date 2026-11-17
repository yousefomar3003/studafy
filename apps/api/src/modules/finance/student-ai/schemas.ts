import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .openapi({ example: "2026-09" });

/**
 * The Student AI line on a child's fees: monthly price x months = total, paid with tuition. What a
 * parent sees; it never carries the school's licence price or the revenue share.
 */
const studentAiLineFields = {
  academic_year_id: uuidSchema,
  academic_year_name: z.string(),
  currency: z.string().openapi({ description: "The school's currency (ISO 4217)." }),
  currency_minor_unit: z.number().int(),
  monthly_price: z.string().openapi({ description: "Decimal string in the currency's precision." }),
  monthly_price_minor: z.number().int(),
  months: z
    .number()
    .int()
    .openapi({
      description:
        "Months charged: from the start month to the end of the school's academic year, or to " +
        "the month before stopped_from.",
    }),
  total: z.string(),
  total_minor: z.number().int(),
  start_month: monthSchema,
  end_month: monthSchema.openapi({ description: "The academic year's last month." }),
  late_start: z.boolean().openapi({
    description: "True when the student joined after the year's first month.",
  }),
  stopped_from: monthSchema.nullable().openapi({
    description: "The first month no longer charged after the seat was released or transferred.",
  }),
  status: z.enum(["active", "released", "transferred"]),
  billing: z.enum(["auto", "outside"]).openapi({
    description:
      "auto: Studafy adds it to the fee schedule; outside: the school bills it itself. Either " +
      "way it is paid with tuition.",
  }),
  invoiced: z.string(),
  invoiced_minor: z.number().int().openapi({ description: "Already on an invoice." }),
  planned: z.string(),
  planned_minor: z.number().int().openapi({ description: "Still to be invoiced." }),
};

export const familyStudentAiLineSchema = z
  .object(studentAiLineFields)
  .openapi("FamilyStudentAiLine");

export const studentAiFinanceLineSchema = z
  .object({
    student_id: uuidSchema,
    student_name: z.string(),
    admission_number: z.string(),
    ...studentAiLineFields,
  })
  .openapi("StudentAiFinanceLine");

export const studentAiFinanceLineListSchema = z
  .object({ lines: z.array(studentAiFinanceLineSchema) })
  .openapi("StudentAiFinanceLineList");

export const studentAiLinesQuerySchema = z
  .object({ academic_year_id: uuidSchema.optional() })
  .openapi("StudentAiLinesQuery");

export const studentAiBillingSettingsSchema = z
  .object({
    auto_billing: z.boolean().openapi({
      description:
        "On by default: the Student AI line is added to each opted-in student's fee schedule. " +
        "Off: nothing is added and the school bills it itself; parents still see the line.",
    }),
    auto_billing_since: monthSchema.nullable().openapi({
      description:
        "The first month billed through Studafy after auto-billing was last switched back on; " +
        "null when it was never off.",
    }),
    updated_at: dateTimeSchema.nullable(),
  })
  .openapi("StudentAiBillingSettings");

export const updateStudentAiBillingSettingsBodySchema = z
  .object({ auto_billing: z.boolean() })
  .openapi("UpdateStudentAiBillingSettingsBody");

export const studentAiSyncSummarySchema = z
  .object({
    students: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
    unchanged: z.number().int(),
    skipped_no_price: z.number().int().openapi({
      description: "Lines not created because the licence has no parent price in the currency.",
    }),
  })
  .openapi("StudentAiSyncSummary");

export const studentAiSettingsResultSchema = z
  .object({
    settings: studentAiBillingSettingsSchema,
    sync: studentAiSyncSummarySchema,
  })
  .openapi("StudentAiSettingsResult");
