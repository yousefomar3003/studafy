import { z } from "@hono/zod-openapi";
import { uuidSchema, dateTimeSchema } from "@studafy/shared-schemas";

export const paymentModeSchema = z
  .enum(["cash", "bank_transfer", "card_external"])
  .openapi("PaymentMode", {
    description:
      "How the money was collected. `card_external` means a card payment captured outside " +
      "Studafy — the gateway records it, it does not process cards.",
  });

export const paymentStatusSchema = z
  .enum(["pending", "confirmed", "failed"])
  .openapi("PaymentStatus", {
    description:
      "`pending` — forwarded to ERPNext and accepted, awaiting the submission webhook. " +
      "`confirmed` — ERPNext confirmed submission and a receipt exists. " +
      "`failed` — ERPNext ultimately rejected or cancelled the entry.",
  });

export const paymentIdParamSchema = z
  .object({
    paymentId: z
      .string()
      .min(1)
      .openapi({
        param: { name: "paymentId", in: "path" },
        description:
          "Either the Studafy UUID or the ERPNext Payment Entry docname; the service resolves either.",
      }),
  })
  .openapi("PaymentIdParam");

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Deliberately thin, on the same principle as `createFeeStructureBodySchema`.
 *
 * There is no `remaining_balance` field, no check that `amount` fits within what the invoice still
 * owes, and no allocation across invoices. ERPNext owns every one of those, and a second opinion
 * here would be a copy of rules we do not control that drifts the moment they change. What is
 * validated is only what the gateway needs in order to route the request and store the result:
 * a resolvable student, a target document name, a positive amount, and a mode we can map.
 *
 * `amount` is a decimal in the payment's own currency — a *partial* payment is simply an amount
 * smaller than the invoice total, which needs no flag and no special path.
 */
export const createPaymentBodySchema = z
  .object({
    student_id: uuidSchema.openapi({
      description: "Local student this payment is for. Used to scope and project the cache row.",
    }),
    invoice_id: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .openapi({
        description:
          "ERPNext Sales Invoice document name to pay against (e.g. 'ACC-SINV-2026-00042'). " +
          "Not a UUID — ERPNext names its own documents.",
      }),
    amount: z
      .number()
      .positive()
      .openapi({
        description:
          "Decimal amount in `currency`. May be less than the invoice total for a partial payment; " +
          "ERPNext rejects an overpayment and that rejection is passed through unchanged.",
      }),
    payment_mode: paymentModeSchema,
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .default("JOD")
      .openapi({ description: "ISO 4217 code. Must exist and be active in app.currencies." }),
    reference_no: z
      .string()
      .trim()
      .min(1)
      .max(140)
      .optional()
      .openapi({
        description:
          "Bank or terminal reference. ERPNext requires one for non-cash modes; its refusal when " +
          "absent is forwarded rather than pre-empted here.",
      }),
    reference_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({ description: "Date on the bank/terminal reference (YYYY-MM-DD)." }),
    posting_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .openapi({ description: "ERPNext posting date (YYYY-MM-DD). Defaults to today." }),
    remarks: z.string().trim().max(500).optional(),
  })
  .openapi("CreatePaymentBody");

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * `amount`, `amount_minor`, and `currency` are three separate fields, not one formatted string.
 *
 * `currency.ts` documents the reason: the currency code's *placement* relative to the number differs
 * between Arabic and English, so concatenating them server-side would bake one locale's word order
 * into the API. The client composes them, which is what makes the RTL rendering its decision rather
 * than ours. `currency_minor_unit` is included so a client can round consistently with the server
 * without hardcoding that JOD has three decimal places.
 */
export const paymentSchema = z
  .object({
    id: uuidSchema.openapi({ description: "Studafy internal id." }),
    school_id: uuidSchema,
    student_id: uuidSchema,
    erpnext_payment_entry_id: z
      .string()
      .nullable()
      .openapi({ description: "ERPNext Payment Entry document name." }),
    erpnext_invoice_id: z
      .string()
      .nullable()
      .openapi({ description: "The Sales Invoice this payment was posted against, as requested." }),
    amount: z
      .string()
      .openapi({ description: "Decimal string at the currency's precision, e.g. '125.500'." }),
    amount_minor: z.number().int().openapi({ description: "Integer minor units." }),
    currency: z.string().length(3),
    currency_minor_unit: z
      .number()
      .int()
      .openapi({ description: "Decimal places for `currency`; 3 for JOD, not 2." }),
    payment_mode: paymentModeSchema.nullable().openapi({
      description: "Null for a payment projected from ERPNext that this gateway did not forward.",
    }),
    status: paymentStatusSchema,
    erpnext_status: z.string().openapi({ description: "ERPNext's own docstatus, as a word." }),
    receipt_url: z
      .string()
      .nullable()
      .openapi({
        description:
          "ERPNext-generated receipt link, available once confirmed. Never a signed or " +
          "credential-bearing URL.",
      }),
    payment_date: z.string().openapi({ description: "ERPNext posting date (YYYY-MM-DD)." }),
    confirmed_at: dateTimeSchema
      .nullable()
      .openapi({ description: "When ERPNext's submission webhook confirmed this payment." }),
    last_synced_at: dateTimeSchema,
  })
  .openapi("Payment");

export const paymentListSchema = z
  .object({
    payments: z.array(paymentSchema),
    total: z.number().int(),
  })
  .openapi("PaymentList");

export const paymentQuerySchema = z
  .object({
    student_id: uuidSchema.optional().openapi({ description: "Filter by student." }),
    invoice_id: z
      .string()
      .min(1)
      .optional()
      .openapi({ description: "Filter by target ERPNext Sales Invoice docname." }),
    status: paymentStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("PaymentQuery");

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * The ERPNext `Payment Entry` submission callback.
 *
 * Shaped after the generic receiver's body in `erpnext/webhook.ts` so one ERPNext webhook
 * configuration can target either endpoint. `data` stays a loose record: it is ERPNext's document,
 * an external payload we do not own, and pinning its fields here would reject a payload that merely
 * grew a column.
 */
export const paymentConfirmedWebhookSchema = z
  .object({
    event_id: z.string().min(1).openapi({
      description: "ERPNext's unique id for this delivery. Used to deduplicate redeliveries.",
    }),
    doctype: z
      .string()
      .min(1)
      .default("Payment Entry")
      .openapi({ description: "ERPNext DocType. Anything but 'Payment Entry' is ignored." }),
    action: z
      .string()
      .min(1)
      .openapi({ description: "ERPNext document action, e.g. 'submitted' or 'on_submit'." }),
    data: z.record(z.string(), z.unknown()).openapi({
      description:
        "The ERPNext Payment Entry document. Must carry school_id (or custom_school_id) — the " +
        "payload is otherwise untenanted and cannot be routed to a tenant.",
    }),
  })
  .openapi("PaymentConfirmedWebhook");

export const webhookAcceptedSchema = z
  .object({ ok: z.literal(true) })
  .openapi("PaymentWebhookAccepted");
