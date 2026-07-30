import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

export const installmentStatusSchema = z
  .enum(["pending", "partially_paid", "paid", "overdue"])
  .openapi("InstallmentStatus", {
    description:
      "`pending` — not yet due or no payment recorded. `partially_paid` — some amount paid but " +
      "outstanding remains. `paid` — fully settled. `overdue` — past due_date with outstanding balance.",
  });

export const installmentsQuerySchema = z
  .object({
    status: installmentStatusSchema
      .optional()
      .openapi({ description: "Filter by installment status." }),
    due_date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({
        description: "Include installments due on or after this date (YYYY-MM-DD).",
      }),
    due_date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({
        description: "Include installments due on or before this date (YYYY-MM-DD).",
      }),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("InstallmentsQuery");

export const installmentSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    erpnext_fee_schedule_id: z.string().openapi({
      description: "ERPNext Fee Schedule document name — the stable external identity.",
    }),
    student_id: uuidSchema,
    fee_structure_id: uuidSchema.nullable().openapi({
      description: "Local fee structure this installment is derived from, if known.",
    }),
    due_date: z.string().openapi({ description: "Installment due date (YYYY-MM-DD)." }),
    total_amount: z.string().openapi({
      description: "Decimal string at the currency's precision, e.g. '1250.500'.",
    }),
    paid_amount: z.string().openapi({
      description: "Decimal string at the currency's precision, e.g. '500.000'.",
    }),
    outstanding_amount: z.string().openapi({
      description: "Decimal string at the currency's precision, e.g. '750.500'.",
    }),
    total_amount_minor: z.number().int(),
    paid_amount_minor: z.number().int(),
    outstanding_amount_minor: z.number().int(),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int().openapi({
      description: "Decimal places for `currency`; 3 for JOD, not 2.",
    }),
    status: installmentStatusSchema,
    synced_at: dateTimeSchema,
  })
  .openapi("Installment");

export const installmentListSchema = z
  .object({
    installments: z.array(installmentSchema),
    total: z.number().int().openapi({ description: "Total matching rows." }),
  })
  .openapi("InstallmentList");

export const generateFeeScheduleBodySchema = z
  .object({
    fee_structure: z.string().min(1).openapi({
      description: "ERPNext Fee Structure document name to schedule (e.g. 'FS-2026-0001').",
    }),
    student_ids: z.array(z.string().uuid()).min(1).max(500).openapi({
      description: "Local student UUIDs to generate schedules for.",
    }),
    due_dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .min(1)
      .max(12)
      .openapi({
        description:
          "Installment due dates. One per installment; schedule type determines how " +
          "these map to ERPNext Fee Schedule rows.",
      }),
    academic_year_id: uuidSchema.optional().openapi({
      description: "Local academic year this schedule belongs to.",
    }),
    program: z.string().min(1).optional().openapi({
      description: "ERPNext Program document name.",
    }),
    schedule_type: z
      .enum(["monthly", "quarterly", "term_wise", "yearly"])
      .default("term_wise")
      .openapi({
        description:
          "How the fee structure total is divided across due_dates. ERPNext computes the " +
          "per-installment amounts from this type.",
      }),
  })
  .openapi("GenerateFeeScheduleBody");
