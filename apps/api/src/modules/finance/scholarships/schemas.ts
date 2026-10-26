import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

export const discountTypeSchema = z
  .enum(["percentage", "fixed"])
  .openapi("ScholarshipDiscountType", {
    description:
      "`percentage` — `percentage`% off the fees it covers. `fixed` — `amount` in `currency` off " +
      "the fees it covers, never more than those fees.",
  });

export const awardStatusSchema = z
  .enum(["pending_approval", "approved", "rejected", "revoked"])
  .openapi("ScholarshipAwardStatus", {
    description:
      "`pending_approval` — requested by finance, awaiting the school admin. " +
      "`approved` — discounts the student's invoices generated from now on. " +
      "`rejected` — declined by the school admin. " +
      "`revoked` — was approved, withdrawn by the school admin; later invoices are full price.",
  });

const currencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
  .openapi({ description: "ISO 4217 code. Must exist and be active in app.currencies." });

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const scholarshipIdParamSchema = z
  .object({
    scholarshipId: uuidSchema.openapi({
      param: { name: "scholarshipId", in: "path" },
      description: "Scholarship UUID.",
    }),
  })
  .openapi("ScholarshipIdParam");

export const awardIdParamSchema = z
  .object({
    awardId: uuidSchema.openapi({
      param: { name: "awardId", in: "path" },
      description: "Scholarship award UUID.",
    }),
  })
  .openapi("ScholarshipAwardIdParam");

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const createScholarshipBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).openapi({ description: "Unique within the school." }),
    description: z.string().trim().max(1000).optional(),
    discount_type: discountTypeSchema,
    percentage: z
      .number()
      .gt(0)
      .max(100)
      .multipleOf(0.01)
      .optional()
      .openapi({ description: "Required for `percentage`; omitted for `fixed`." }),
    amount: z
      .number()
      .positive()
      .optional()
      .openapi({ description: "Decimal amount in `currency`. Required for `fixed`." }),
    currency: currencyCodeSchema.optional().openapi({ description: "Required for `fixed`." }),
    fee_category: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .optional()
      .openapi({
        description:
          "Limit the scholarship to invoice lines of this fee category (as named in the fee " +
          "structure). Omitted, it applies to every fee.",
      }),
  })
  .superRefine((body, ctx) => {
    if (body.discount_type === "percentage") {
      if (body.percentage === undefined) {
        ctx.addIssue({ code: "custom", path: ["percentage"], message: "Required for percentage" });
      }
      if (body.amount !== undefined || body.currency !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["amount"],
          message: "A percentage scholarship takes no amount or currency",
        });
      }
    } else {
      if (body.amount === undefined) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "Required for fixed" });
      }
      if (body.currency === undefined) {
        ctx.addIssue({ code: "custom", path: ["currency"], message: "Required for fixed" });
      }
      if (body.percentage !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["percentage"],
          message: "A fixed scholarship takes no percentage",
        });
      }
    }
  })
  .openapi("CreateScholarshipBody");

export const updateScholarshipBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    is_active: z
      .boolean()
      .optional()
      .openapi({
        description:
          "An inactive scholarship cannot be awarded and stops discounting new invoices, including " +
          "for students whose award is already approved.",
      }),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to update" })
  .openapi("UpdateScholarshipBody", {
    description:
      "The discount itself (type, value, fee category) is fixed once created, so an approved " +
      "award always means what the admin approved. Deactivate it and create a new one instead.",
  });

export const createAwardBodySchema = z
  .object({
    scholarship_id: uuidSchema,
    student_id: uuidSchema,
    notes: z.string().trim().max(1000).optional().openapi({
      description: "Why the student qualifies, for the approving admin.",
    }),
  })
  .openapi("CreateScholarshipAwardBody");

export const decideAwardBodySchema = z
  .object({
    notes: z.string().trim().max(1000).optional(),
  })
  .openapi("DecideScholarshipAwardBody");

export const rejectAwardBodySchema = z
  .object({
    notes: z.string().trim().min(1).max(1000).openapi({
      description: "Mandatory explanation, shown to finance.",
    }),
  })
  .openapi("RejectScholarshipAwardBody");

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const scholarshipQuerySchema = z
  .object({
    is_active: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("ScholarshipQuery");

export const awardQuerySchema = z
  .object({
    status: awardStatusSchema.optional(),
    student_id: uuidSchema.optional(),
    scholarship_id: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("ScholarshipAwardQuery");

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const scholarshipSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    description: z.string().nullable(),
    discount_type: discountTypeSchema,
    percentage: z.string().nullable().openapi({ description: "e.g. '25.00'; null for `fixed`." }),
    amount: z.string().nullable().openapi({
      description: "Decimal string at the currency's precision; null for `percentage`.",
    }),
    amount_minor: z.number().int().nullable(),
    currency: z.string().length(3).nullable(),
    currency_minor_unit: z.number().int().nullable(),
    fee_category: z.string().nullable(),
    is_active: z.boolean(),
    approved_award_count: z.number().int(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Scholarship");

export const scholarshipListSchema = z
  .object({ scholarships: z.array(scholarshipSchema), total: z.number().int() })
  .openapi("ScholarshipList");

export const awardSchema = z
  .object({
    id: uuidSchema,
    scholarship_id: uuidSchema,
    scholarship_name: z.string(),
    scholarship_is_active: z.boolean().openapi({
      description: "An approved award of an inactive scholarship discounts nothing.",
    }),
    discount_type: discountTypeSchema,
    percentage: z.string().nullable(),
    amount: z.string().nullable(),
    currency: z.string().length(3).nullable(),
    fee_category: z.string().nullable(),
    student_id: uuidSchema,
    student_name: z.string(),
    admission_number: z.string(),
    status: awardStatusSchema,
    notes: z.string().nullable(),
    requested_by: uuidSchema,
    requested_by_name: z.string().nullable(),
    decided_by: uuidSchema.nullable(),
    decided_by_name: z.string().nullable(),
    decided_at: dateTimeSchema.nullable(),
    decision_notes: z.string().nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("ScholarshipAward");

export const awardListSchema = z
  .object({ awards: z.array(awardSchema), total: z.number().int() })
  .openapi("ScholarshipAwardList");
