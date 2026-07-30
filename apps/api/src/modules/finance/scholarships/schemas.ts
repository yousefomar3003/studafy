import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const scholarshipDiscountQuerySchema = z
  .object({
    is_active: z
      .enum(["true", "false"])
      .optional()
      .openapi({ description: "Filter by active status." }),
    scope: z
      .enum(["global", "fee_category"])
      .optional()
      .openapi({ description: "Filter by scope." }),
    fee_category: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "Filter by ERPNext Fee Category docname." }),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("ScholarshipDiscountQuery");

export const awardIdParamSchema = z
  .object({
    awardId: uuidSchema.openapi({
      param: { name: "awardId", in: "path" },
      description: "Award cache UUID.",
    }),
  })
  .openapi("AwardIdParam");

export const awardQuerySchema = z
  .object({
    student_id: uuidSchema.optional().openapi({ description: "Filter by student." }),
    status: z
      .enum(["pending", "confirmed", "cancelled"])
      .optional()
      .openapi({ description: "Filter by award status." }),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("AwardQuery");

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const createAwardBodySchema = z
  .object({
    student_id: uuidSchema.openapi({
      description: "The student to award the scholarship/discount to.",
    }),
    scholarship_discount_id: uuidSchema.openapi({
      description: "The scholarship/discount cache entry id.",
    }),
  })
  .openapi("CreateAwardBody");

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const scholarshipDiscountSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    erpnext_docname: z.string().openapi({ description: "ERPNext document name." }),
    erpnext_status: z.string(),
    title: z.string(),
    discount_type: z
      .enum(["percentage", "fixed"])
      .openapi({ description: "Percentage or fixed amount." }),
    amount: z.number().openapi({ description: "Percentage value or fixed amount." }),
    scope: z
      .enum(["global", "fee_category"])
      .openapi({ description: "Global or per fee category." }),
    fee_category: z
      .string()
      .nullable()
      .openapi({ description: "ERPNext Fee Category docname when scoped." }),
    currency: z.string().length(3).nullable(),
    currency_minor_unit: z.number().int().nullable(),
    is_active: z.boolean(),
    last_synced_at: dateTimeSchema,
  })
  .openapi("ScholarshipDiscount");

export const scholarshipDiscountListSchema = z
  .object({
    scholarship_discounts: z.array(scholarshipDiscountSchema),
    total: z.number().int(),
  })
  .openapi("ScholarshipDiscountList");

export const awardSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    student_id: uuidSchema,
    scholarship_discount_id: uuidSchema,
    scholarship_discount_title: z
      .string()
      .openapi({ description: "Denormalized title from the discount cache." }),
    award_status: z.enum(["pending", "confirmed", "cancelled"]),
    awarded_by: uuidSchema,
    confirmed_by: uuidSchema.nullable(),
    confirmed_at: dateTimeSchema.nullable(),
    erpnext_docname: z.string().nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Award");

export const awardListSchema = z
  .object({
    awards: z.array(awardSchema),
    total: z.number().int(),
  })
  .openapi("AwardList");
