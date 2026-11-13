import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

const feeCategorySchema = z.string().trim().min(1).max(140);

export const taxSettingsSchema = z
  .object({
    configured: z.boolean().openapi({ description: "False until a school admin first saves." }),
    is_enabled: z.boolean().openapi({
      description: "Off by default. When on, every invoice generated from now on carries the tax.",
    }),
    tax_name: z.string().openapi({ description: "What invoices call it, e.g. 'VAT'." }),
    rate: z.number().openapi({ description: "Percent, e.g. 5 or 15." }),
    erpnext_account_head: z.string().nullable().openapi({
      description: "The ERPNext Account the tax posts to, e.g. 'VAT 5% - SCH'.",
    }),
    registration_number: z.string().nullable().openapi({
      description: "The school's tax registration number, printed on invoices and receipts.",
    }),
    prices_include_tax: z.boolean().openapi({
      description: "True when fee amounts already include the tax; false adds it on top.",
    }),
    exempt_fee_categories: z.array(z.string()).openapi({
      description: "Fee categories (ERPNext Item codes) the rate does not apply to.",
    }),
    updated_by: uuidSchema.nullable(),
    updated_at: dateTimeSchema.nullable(),
  })
  .openapi("TaxSettings");

export const updateTaxSettingsBodySchema = z
  .object({
    is_enabled: z.boolean(),
    tax_name: z.string().trim().min(1).max(60).default("VAT"),
    rate: z.number().min(0).max(100).multipleOf(0.01),
    erpnext_account_head: z.string().trim().min(1).max(140).nullable().default(null),
    registration_number: z.string().trim().min(1).max(40).nullable().default(null),
    prices_include_tax: z.boolean().default(false),
    exempt_fee_categories: z.array(feeCategorySchema).max(200).default([]),
  })
  .refine((body) => !body.is_enabled || body.rate > 0, {
    message: "A rate above 0 is required to turn tax on",
    path: ["rate"],
  })
  .refine((body) => !body.is_enabled || body.erpnext_account_head !== null, {
    message: "The ERPNext tax account is required to turn tax on",
    path: ["erpnext_account_head"],
  })
  .openapi("UpdateTaxSettingsBody");

export type TaxSettings = z.infer<typeof taxSettingsSchema>;
export type UpdateTaxSettingsBody = z.infer<typeof updateTaxSettingsBodySchema>;
