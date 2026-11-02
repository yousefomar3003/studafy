import { z } from "@hono/zod-openapi";
import { dateSchema, dateTimeSchema, uuidSchema } from "@studafy/shared-schemas";

import { paymentModeSchema, paymentSchema } from "../payments/schemas";

// ---------------------------------------------------------------------------
// Shared parts
// ---------------------------------------------------------------------------

const currencyCodeSchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/)
  .openapi({ description: "ISO 4217 code. Must exist and be active in app.currencies." });

export const familyIdParamSchema = z
  .object({
    familyId: uuidSchema.openapi({
      param: { name: "familyId", in: "path" },
      description: "Family UUID.",
    }),
  })
  .openapi("FinanceFamilyIdParam");

export const familyGuardianSchema = z
  .object({
    user_id: uuidSchema,
    name: z.string(),
    email: z.string(),
    is_primary: z.boolean().openapi({
      description: "The family's primary contact (app.families.primary_parent_user_id).",
    }),
  })
  .openapi("FinanceFamilyGuardian");

export const familyChildSchema = z
  .object({
    student_id: uuidSchema,
    name: z.string(),
    admission_number: z.string(),
    status: z
      .string()
      .openapi({ description: "Enrollment status; only `enrolled` children rank." }),
    child_position: z
      .number()
      .int()
      .nullable()
      .openapi({
        description:
          "Place among the family's enrolled children, eldest first (1 = eldest). Null when the child " +
          "is not enrolled.",
      }),
    sibling_discount_percentage: z
      .number()
      .nullable()
      .openapi({
        description:
          "The sibling discount the school's rule gives this child's next invoice; null for none " +
          "(the rule is off, the child is the eldest, or no tier reaches their position).",
      }),
  })
  .openapi("FinanceFamilyChild");

export const familyBalanceSchema = z
  .object({
    currency: z.string(),
    currency_minor_unit: z.number().int(),
    billed: z.string(),
    billed_minor: z.number().int(),
    outstanding: z.string(),
    outstanding_minor: z.number().int(),
    overdue: z.string(),
    overdue_minor: z.number().int(),
  })
  .openapi("FinanceFamilyBalance", {
    description:
      "One currency's totals across the family's issued invoices (drafts and cancelled excluded). " +
      "`overdue` is the outstanding amount past its due date.",
  });

export const financeFamilySchema = z
  .object({
    id: uuidSchema,
    display_name: z.string(),
    guardians: z.array(familyGuardianSchema),
    children: z.array(familyChildSchema),
    balances: z.array(familyBalanceSchema),
    overdue_invoice_count: z.number().int(),
    last_payment_date: dateSchema.nullable(),
    last_reminder_at: dateTimeSchema.nullable(),
  })
  .openapi("FinanceFamily");

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const familyListQuerySchema = z
  .object({
    search: z.string().trim().max(120).optional().openapi({
      description: "Matches the family name, a child's name or a guardian's name or email.",
    }),
    min_children: z.coerce.number().int().min(1).max(20).optional().openapi({
      description: "Only families with at least this many children (2 lists sibling families).",
    }),
    balance: z.enum(["outstanding", "overdue"]).optional().openapi({
      description: "Only families that owe money (`outstanding`) or owe it past due (`overdue`).",
    }),
    sort: z.enum(["name", "outstanding"]).default("name").openapi({
      description: "`outstanding` puts the largest balance first.",
    }),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("FinanceFamilyListQuery");

export const familyListSchema = z
  .object({
    families: z.array(financeFamilySchema),
    total: z.number().int(),
  })
  .openapi("FinanceFamilyList");

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export const communicationKindSchema = z
  .enum(["invoice_issued", "payment_received", "payment_reminder", "statement"])
  .openapi("FinanceCommunicationKind");

export const financeCommunicationSchema = z
  .object({
    id: uuidSchema,
    kind: communicationKindSchema,
    student_id: uuidSchema.nullable(),
    reference: z.string().nullable().openapi({
      description: "The ERPNext invoice or payment the notice is about; null for family messages.",
    }),
    recipient_user_id: uuidSchema,
    recipient_name: z.string(),
    delivered: z.boolean().openapi({
      description: "False when the guardian has turned this notification type off.",
    }),
    sent_by: uuidSchema.nullable().openapi({ description: "Null when the system sent it." }),
    sent_by_name: z.string().nullable(),
    created_at: dateTimeSchema,
  })
  .openapi("FinanceCommunication");

export const familyProfileSchema = financeFamilySchema
  .extend({ communications: z.array(financeCommunicationSchema) })
  .openapi("FinanceFamilyProfile");

// ---------------------------------------------------------------------------
// Family payment
// ---------------------------------------------------------------------------

export const familyPaymentAllocationSchema = z
  .object({
    invoice_id: z.string().trim().min(1).max(140).openapi({
      description:
        "ERPNext Sales Invoice docname. Must be an invoice of one of the family's children.",
    }),
    amount: z
      .number()
      .positive()
      .openapi({ description: "Decimal amount in the payment's currency." }),
  })
  .openapi("FamilyPaymentAllocation");

export const createFamilyPaymentBodySchema = z
  .object({
    amount: z.number().positive().openapi({
      description: "The whole amount the family paid, as a decimal in `currency`.",
    }),
    currency: currencyCodeSchema,
    payment_mode: paymentModeSchema,
    posting_date: dateSchema.optional(),
    reference_no: z.string().trim().min(1).max(140).optional(),
    reference_date: dateSchema.optional(),
    remarks: z.string().trim().max(500).optional(),
    allocations: z
      .array(familyPaymentAllocationSchema)
      .min(1)
      .max(50)
      .optional()
      .openapi({
        description:
          "How to split the amount across invoices. Omitted, it pays the oldest-due invoices first. " +
          "Given, the amounts must add up to `amount` and none may exceed what its invoice owes.",
      }),
  })
  .openapi("CreateFamilyPaymentBody");

export const familyPaymentResultSchema = z
  .object({
    invoice_id: z.string(),
    student_id: uuidSchema,
    amount: z.string(),
    status: z.enum(["recorded", "replayed", "failed"]).openapi({
      description:
        "`recorded` — a Payment Entry was posted. `replayed` — an earlier request with this key " +
        "already posted it. `failed` — ERPNext refused or could not be reached; see `error`.",
    }),
    payment: paymentSchema.nullable(),
    error: z.string().nullable(),
  })
  .openapi("FamilyPaymentResult");

export const familyPaymentResponseSchema = z
  .object({
    outcome: z.enum(["completed", "partial", "failed"]).openapi({
      description:
        "`partial` means some invoices were paid and some were not. Retrying with the same " +
        "Idempotency-Key and body replays the paid ones and retries only the rest.",
    }),
    currency: z.string(),
    results: z.array(familyPaymentResultSchema),
  })
  .openapi("FamilyPaymentResponse");

export const idempotencyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(200)
    .openapi({
      description:
        "Client-generated key making the whole family payment safe to retry. Each invoice's share is " +
        "posted under a key derived from this one, so a retry never pays an invoice twice.",
    }),
});

// ---------------------------------------------------------------------------
// Reminders and statements
// ---------------------------------------------------------------------------

export const familySendResultSchema = z
  .object({
    status: z.enum(["sent", "nothing_overdue", "recently_reminded", "no_guardians"]).openapi({
      description:
        "`sent` — guardians were notified. `nothing_overdue` — the family owes nothing past due. " +
        "`recently_reminded` — a reminder went out in the last 24 hours. `no_guardians` — no active " +
        "guardian is linked to the family.",
    }),
    delivered: z.number().int().openapi({ description: "Guardians who received it." }),
    suppressed: z
      .number()
      .int()
      .openapi({ description: "Guardians who have this notification turned off." }),
    last_reminder_at: dateTimeSchema.nullable(),
  })
  .openapi("FamilySendResult");

export const bulkReminderBodySchema = z
  .object({
    family_ids: z.array(uuidSchema).min(1).max(500).optional().openapi({
      description: "The families to remind. Omitted, every family with an overdue balance.",
    }),
  })
  .openapi("BulkReminderBody");

export const bulkReminderResultSchema = z
  .object({
    families: z.number().int().openapi({ description: "Families considered." }),
    sent: z.number().int(),
    recently_reminded: z.number().int(),
    nothing_overdue: z.number().int(),
    no_guardians: z.number().int(),
    delivered: z.number().int().openapi({ description: "Guardians notified in total." }),
  })
  .openapi("BulkReminderResult");

export type FamilyListQuery = z.infer<typeof familyListQuerySchema>;
export type CreateFamilyPaymentBody = z.infer<typeof createFamilyPaymentBodySchema>;
