import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

export const reasonCodeSchema = z
  .enum(["overpayment", "withdrawal", "discount_adjustment", "error_correction"])
  .openapi("ReasonCode", {
    description:
      "Classification for the refund reason. ERPNext receives this as a custom field but does not " +
      "enforce it — the classification is for local reporting and audit.",
  });

export const refundStatusSchema = z
  .enum(["pending_approval", "approved", "rejected", "submitted_to_erpnext", "completed", "failed"])
  .openapi("RefundStatus", {
    description:
      "`pending_approval` — maker created, awaiting checker. " +
      "`approved` — checker approved but not yet forwarded. " +
      "`rejected` — checker declined. " +
      "`submitted_to_erpnext` — forwarded to ERPNext, awaiting its submission webhook. " +
      "`completed` — ERPNext confirmed the credit note. " +
      "`failed` — ERPNext rejected or processing failed.",
  });

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const refundIdParamSchema = z
  .object({
    refundId: uuidSchema.openapi({
      param: { name: "refundId", in: "path" },
      description: "Refund request UUID.",
    }),
  })
  .openapi("RefundIdParam");

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const initiateRefundBodySchema = z
  .object({
    student_id: uuidSchema.openapi({
      description: "Local student this refund is for.",
    }),
    erpnext_invoice_id: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .openapi({
        description:
          "ERPNext Sales Invoice document name to refund against (e.g. 'ACC-SINV-2026-00042'). " +
          "Not a UUID — ERPNext names its own documents.",
      }),
    amount: z
      .number()
      .positive()
      .openapi({
        description:
          "Decimal amount in `currency` to refund. Must not exceed the paid amount on the " +
          "target invoice; ERPNext rejects an over-refund and that refusal is passed through unchanged.",
      }),
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .default("JOD")
      .openapi({ description: "ISO 4217 code. Must exist and be active in app.currencies." }),
    reason_code: reasonCodeSchema,
    reason_notes: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .openapi({ description: "Free-text explanation for the refund reason." }),
  })
  .openapi("InitiateRefundBody");

export const approveRefundBodySchema = z.object({}).openapi("ApproveRefundBody", {
  description: "Empty body — approval is an administrative authorization, not a data submission.",
});

export const rejectRefundBodySchema = z
  .object({
    reason_notes: z.string().trim().min(1).max(1000).openapi({
      description: "Mandatory explanation for why the refund request was rejected.",
    }),
  })
  .openapi("RejectRefundBody");

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const refundQuerySchema = z
  .object({
    student_id: uuidSchema.optional().openapi({ description: "Filter by student." }),
    status: refundStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("RefundQuery");

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const refundSchema = z
  .object({
    id: uuidSchema,
    school_id: uuidSchema,
    payment_entry_id: uuidSchema.nullable(),
    erpnext_invoice_id: z.string(),
    erpnext_credit_note_id: z.string().nullable(),
    student_id: uuidSchema,
    amount: z.string().openapi({
      description: "Decimal string at the currency's precision, e.g. '125.500'.",
    }),
    amount_minor: z.number().int(),
    currency: z.string().length(3),
    currency_minor_unit: z.number().int(),
    reason_code: reasonCodeSchema,
    reason_notes: z.string().nullable(),
    status: refundStatusSchema,
    maker_id: uuidSchema,
    checker_id: uuidSchema.nullable(),
    approved_at: dateTimeSchema.nullable(),
    completed_at: dateTimeSchema.nullable(),
    created_at: dateTimeSchema,
    updated_at: dateTimeSchema,
  })
  .openapi("Refund");

export const refundListSchema = z
  .object({
    refunds: z.array(refundSchema),
    total: z.number().int(),
  })
  .openapi("RefundList");

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export const refundProcessedWebhookSchema = z
  .object({
    event_id: z.string().min(1).openapi({
      description: "ERPNext's unique id for this delivery. Used to deduplicate redeliveries.",
    }),
    doctype: z
      .string()
      .min(1)
      .default("Sales Invoice")
      .openapi({ description: "ERPNext DocType." }),
    action: z
      .string()
      .min(1)
      .openapi({ description: "ERPNext document action, e.g. 'submit' or 'on_submit'." }),
    data: z.record(z.string(), z.unknown()).openapi({
      description:
        "The ERPNext Sales Invoice document. Must carry school_id (or custom_school_id). " +
        "The payload is untenanted without it.",
    }),
  })
  .openapi("RefundProcessedWebhook");

export const webhookAcceptedSchema = z.object({ ok: z.literal(true) }).openapi("WebhookAccepted");
