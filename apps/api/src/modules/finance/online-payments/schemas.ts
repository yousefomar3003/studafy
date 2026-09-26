import { z } from "@hono/zod-openapi";
import { dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

export const startOnlineFeePaymentBodySchema = z
  .object({
    student_id: uuidSchema,
    invoice_id: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .openapi({ description: "The ERPNext Sales Invoice name, as in the pay-online link." }),
    success_url: z
      .string()
      .url()
      .openapi({ description: "Where the payer returns after paying. Not proof of payment." }),
    cancel_url: z.string().url().openapi({
      description: "Where the payer returns on cancel (Stripe only; Tap has one URL).",
    }),
  })
  .openapi("StartOnlineFeePaymentRequest");

export const onlineFeePaymentSchema = z
  .object({
    id: uuidSchema,
    student_id: uuidSchema,
    invoice_id: z.string(),
    provider: z.enum(["stripe", "tap"]),
    amount_minor: z
      .number()
      .int()
      .openapi({ description: "The invoice's outstanding balance when payment started." }),
    currency: z.string(),
    status: z.enum(["pending", "succeeded", "failed"]).openapi({
      description:
        "`pending` until the provider's webhook settles it. `succeeded` once the payment is " +
        "recorded in ERPNext (`erpnext_payment_entry_id`). `failed` for a declined, expired or " +
        "abandoned payment.",
    }),
    erpnext_payment_entry_id: z.string().nullable(),
    created_at: dateTimeSchema,
    settled_at: dateTimeSchema.nullable(),
  })
  .openapi("OnlineFeePayment");

export const startOnlineFeePaymentResponseSchema = z
  .object({
    payment: onlineFeePaymentSchema,
    checkout_url: z
      .string()
      .url()
      .openapi({ description: "The provider's hosted payment page. Redirect the payer here." }),
  })
  .openapi("StartOnlineFeePaymentResponse");

export const onlineFeePaymentIdParamSchema = z.object({
  paymentId: uuidSchema.openapi({ param: { name: "paymentId", in: "path" } }),
});
