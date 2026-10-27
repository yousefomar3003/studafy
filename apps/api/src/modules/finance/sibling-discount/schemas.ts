import { z } from "@hono/zod-openapi";
import { dateTimeSchema } from "@studafy/shared-schemas";

export const siblingDiscountTierSchema = z
  .object({
    child_position: z
      .number()
      .int()
      .min(2)
      .max(20)
      .openapi({
        description:
          "The child the tier starts at, eldest enrolled child first: 2 is the second child. The tier " +
          "applies to every later child too, until a higher tier takes over.",
      }),
    percentage: z
      .number()
      .gt(0)
      .max(100)
      .multipleOf(0.01)
      .openapi({ description: "Percent off the fees the rule covers." }),
  })
  .openapi("SiblingDiscountTier");

export const siblingDiscountRuleSchema = z
  .object({
    configured: z
      .boolean()
      .openapi({ description: "False until the school admin first saves a rule." }),
    is_enabled: z.boolean(),
    fee_category: z.string().nullable().openapi({
      description: "Limits the discount to invoice lines of this fee category; null for every fee.",
    }),
    tiers: z.array(siblingDiscountTierSchema).openapi({ description: "Ascending by position." }),
    updated_at: dateTimeSchema.nullable(),
    updated_by_name: z.string().nullable(),
    discounted_children: z
      .number()
      .int()
      .openapi({
        description:
          "Enrolled children who would get a sibling discount on their next invoice under this rule " +
          "as it stands. Zero while the rule is off.",
      }),
  })
  .openapi("SiblingDiscountRule");

export const updateSiblingDiscountBodySchema = z
  .object({
    is_enabled: z.boolean(),
    fee_category: z.string().trim().min(1).max(140).nullable().optional().openapi({
      description: "Limit the discount to one fee category, as named in the fee structure.",
    }),
    tiers: z
      .array(siblingDiscountTierSchema)
      .max(10)
      .refine((tiers) => new Set(tiers.map((tier) => tier.child_position)).size === tiers.length, {
        message: "Each child position may appear once",
      }),
  })
  .refine((body) => !body.is_enabled || body.tiers.length > 0, {
    message: "An enabled rule needs at least one tier",
    path: ["tiers"],
  })
  .openapi("UpdateSiblingDiscountBody");

export type UpdateSiblingDiscountBody = z.infer<typeof updateSiblingDiscountBodySchema>;
