import { z } from "@hono/zod-openapi";

import { REFUND_REASONS, REFUND_SCOPES, REFUND_STATUSES } from "../services/refund-service";

/**
 * Request/response contracts for subscription refund requests: the requester's own routes
 * (refund-routes.ts) and the platform console's review queue (refund-admin-routes.ts).
 * camelCase, matching the rest of the subscriptions and platform surfaces.
 */

const isoDateTime = z.string().datetime();

export const refundScopeSchema = z.enum(REFUND_SCOPES).openapi("SubscriptionRefundScope");
export const refundReasonSchema = z.enum(REFUND_REASONS).openapi("SubscriptionRefundReason");
export const refundStatusSchema = z.enum(REFUND_STATUSES).openapi("SubscriptionRefundStatus");

const detailsSchema = z.string().trim().max(2000).optional();

export const createSchoolRefundBodySchema = z.object({
  /** A paid invoice id as `GET /api/subscriptions/current/invoices` lists it. Optional. */
  paymentReference: z.string().trim().min(1).max(255).optional(),
  reason: refundReasonSchema,
  details: detailsSchema,
});

export const createAiRefundBodySchema = z.object({
  studentId: z.string().uuid(),
  reason: refundReasonSchema,
  details: detailsSchema,
});

export const refundRequestSchema = z
  .object({
    id: z.string().uuid(),
    scope: refundScopeSchema,
    status: refundStatusSchema,
    reason: refundReasonSchema,
    details: z.string().nullable(),
    paymentReference: z.string().nullable(),
    amountMinor: z.number().int().nullable(),
    currencyCode: z.string().nullable(),
    /** What was refunded, once it was. */
    refundedAmountMinor: z.number().int().nullable(),
    /** The reviewer's note; always present on a rejection. */
    reviewNote: z.string().nullable(),
    reviewedAt: isoDateTime.nullable(),
    refundedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
  })
  .openapi("SubscriptionRefundRequest");

export const refundRequestListSchema = z
  .object({ requests: z.array(refundRequestSchema) })
  .openapi("SubscriptionRefundRequestList");

// ---------------------------------------------------------------------------
// Platform console
// ---------------------------------------------------------------------------

export const platformRefundRequestSchema = refundRequestSchema
  .extend({
    schoolId: z.string().uuid(),
    schoolName: z.string(),
    subscriptionId: z.string().uuid(),
    provider: z.enum(["stripe", "tap"]),
    requester: z.object({ id: z.string().uuid(), name: z.string(), email: z.string() }),
    /** The student an AI add-on request is for; null for a school plan. */
    studentName: z.string().nullable(),
    reviewedBy: z.string().uuid().nullable(),
    providerRefundId: z.string().nullable(),
    failureMessage: z.string().nullable(),
    updatedAt: isoDateTime,
  })
  .openapi("PlatformRefundRequest");

export const platformRefundListQuerySchema = z.object({
  status: refundStatusSchema.optional(),
  scope: refundScopeSchema.optional(),
  schoolId: z.string().uuid().optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const platformRefundListResponseSchema = z
  .object({
    requests: z.array(platformRefundRequestSchema),
    total: z.number().int().nonnegative(),
    /** Unfiltered count of `pending` requests, for the console's badge. */
    pendingCount: z.number().int().nonnegative(),
  })
  .openapi("PlatformRefundRequestList");

export const platformRefundParamSchema = z.object({
  schoolId: z.string().uuid(),
  requestId: z.string().uuid(),
});

export const platformRefundPaymentSchema = z
  .object({
    id: z.string(),
    amountPaid: z.number().int(),
    currency: z.string(),
    created: isoDateTime,
    periodStart: isoDateTime,
    periodEnd: isoDateTime,
  })
  .openapi("PlatformRefundPayment");

export const platformRefundDetailSchema = z
  .object({
    request: platformRefundRequestSchema,
    /**
     * The school's recent paid payments while the request can still be approved; null when it
     * cannot, or when the payment provider could not be reached.
     */
    payments: z.array(platformRefundPaymentSchema).nullable(),
  })
  .openapi("PlatformRefundRequestDetail");

export const approveRefundBodySchema = z.object({
  /** Defaults to the whole payment. */
  amountMinor: z.number().int().positive().optional(),
  paymentReference: z.string().trim().min(1).max(255).optional(),
  /** School plans only. */
  cancelSubscription: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
});

export const approveRefundResponseSchema = z
  .object({
    request: platformRefundRequestSchema,
    cancellation: z.enum(["not_requested", "scheduled", "already_scheduled", "failed"]),
  })
  .openapi("PlatformRefundApproval");

export const rejectRefundBodySchema = z.object({
  note: z.string().trim().min(1).max(2000),
});
