import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

const monthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .openapi({ example: "2026-09" });

const lineStatusSchema = z.enum(["active", "released", "transferred"]);

/**
 * The Student AI line in the family view (`GET /api/finance/families/{familyId}`), which parents
 * read: the year, the months it runs and its status. Never an amount, a price or a currency -- the
 * school tells parents the price (owner, 2026-11-18). Never the licence price or the share either.
 */
const familyLineFields = {
  academic_year_id: uuidSchema,
  academic_year_name: z.string(),
  start_month: monthSchema.openapi({ description: "The first month it runs." }),
  end_month: monthSchema.openapi({ description: "The academic year's last month." }),
  late_start: z.boolean().openapi({
    description: "True when the student joined after the year's first month.",
  }),
  stopped_from: monthSchema.nullable().openapi({
    description: "The first month it no longer runs, after the seat was released or transferred.",
  }),
  status: lineStatusSchema,
};

export const familyStudentAiLineSchema = z.object(familyLineFields).openapi("FamilyStudentAiLine");

/**
 * The Student AI line on a child's fees, as school finance sees it: monthly price x months = total,
 * billed with tuition. The price is the parent-facing (school-offer) price the school tells parents;
 * never the school's licence price or the revenue share.
 */
const studentAiLineFields = {
  ...familyLineFields,
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
