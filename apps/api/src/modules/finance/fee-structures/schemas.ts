import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

// ---------------------------------------------------------------------------
// Params & query
// ---------------------------------------------------------------------------

export const feeStructureIdParamSchema = z
  .object({
    feeStructureId: z
      .string()
      .min(1)
      .openapi({
        param: { name: "feeStructureId", in: "path" },
        description:
          "The ERPNext document name of the fee structure (e.g. 'FS-2026-0001'), not a UUID. " +
          "ERPNext names its documents; the crosswalk in app.erpnext_id_mappings relates them to " +
          "local ids where one exists.",
      }),
  })
  .openapi("FeeStructureIdParam");

export const feeStructureQuerySchema = z
  .object({
    academic_year_id: uuidSchema.optional().openapi({ description: "Filter by academic year." }),
    program: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "Filter by ERPNext Program document name." }),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("FeeStructureQuery");

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const feeComponentSchema = z
  .object({
    fee_category: z
      .string()
      .min(1)
      .openapi({ description: "ERPNext Fee Category document name (tuition, transport, …)." }),
    amount: z
      .number()
      .nonnegative()
      .openapi({ description: "Decimal amount in the structure's currency." }),
    description: z.string().max(500).optional(),
  })
  .openapi("FeeComponent");

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Deliberately thin.
 *
 * The gateway does not validate amounts, totals, currency compatibility, or whether a category
 * exists — ERPNext owns all of that, and duplicating it here would create a second opinion that
 * drifts. What is validated is only what the gateway itself needs to route and store the request.
 */
export const createFeeStructureBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).openapi({ description: "Fee structure name." }),
    academic_year_id: uuidSchema
      .optional()
      .openapi({ description: "Local academic year this structure belongs to." }),
    program: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "ERPNext Program document name." }),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .default("JOD")
      .openapi({ description: "ISO 4217 code. Must exist and be active in app.currencies." }),
    components: z
      .array(feeComponentSchema)
      .min(1)
      .max(50)
      .openapi({ description: "Fee categories and their amounts." }),
  })
  .openapi("CreateFeeStructureBody");

export const updateFeeStructureBodySchema = createFeeStructureBodySchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: "No fields to update" })
  .openapi("UpdateFeeStructureBody");

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const feeStructureSchema = z
  .object({
    erpnext_name: z.string().openapi({ description: "ERPNext document name — the stable id." }),
    school_id: uuidSchema,
    academic_year_id: uuidSchema.nullable(),
    program: z.string().nullable().openapi({ description: "ERPNext Program document name." }),
    title: z.string(),
    // A string, not a number: the amount is stored as an integer of minor units and JOD has three
    // of them. Serialising through a float is how 12.345 becomes 12.34.
    total_amount: z
      .string()
      .openapi({ description: "Decimal string at the currency's own precision, e.g. '1250.500'." }),
    total_amount_minor: z
      .number()
      .int()
      .openapi({ description: "Integer minor units — 1250500 for 1250.500 JOD." }),
    currency: z.string().length(3).openapi({ description: "ISO 4217 code." }),
    currency_minor_unit: z
      .number()
      .int()
      .openapi({ description: "Decimal places for this currency. JOD is 3, not 2." }),
    erpnext_status: z.string(),
    is_active: z.boolean(),
    last_synced_at: dateTimeSchema,
  })
  .openapi("FeeStructure");

export const feeStructureListSchema = z
  .object({
    fee_structures: z.array(feeStructureSchema),
    total: z.number().int().openapi({ description: "Total matching rows." }),
  })
  .openapi("FeeStructureList");
