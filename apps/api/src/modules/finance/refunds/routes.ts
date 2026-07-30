import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { withTenantTx } from "../../../db/tenant-tx";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  approveRefundBodySchema,
  initiateRefundBodySchema,
  refundIdParamSchema,
  refundListSchema,
  refundQuerySchema,
  refundSchema,
  rejectRefundBodySchema,
} from "./schemas";
import {
  approveRefund,
  getRefund,
  initiateRefund,
  listRefunds,
  rejectRefund,
  type RefundRow,
} from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

function toRefundResponse(row: RefundRow) {
  return {
    id: row.id,
    school_id: row.school_id,
    payment_entry_id: row.payment_entry_id,
    erpnext_invoice_id: row.erpnext_invoice_id,
    erpnext_credit_note_id: row.erpnext_credit_note_id,
    student_id: row.student_id,
    amount: row.amount,
    amount_minor: row.amount_minor,
    currency: row.currency,
    currency_minor_unit: row.currency_minor_unit,
    reason_code: row.reason_code,
    reason_notes: row.reason_notes,
    status: row.status,
    maker_id: row.maker_id,
    checker_id: row.checker_id,
    approved_at: row.approved_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const idempotencyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(255)
    .openapi({
      description:
        "Client-generated key making this refund safe to retry. Reusing a key with the same body " +
        "replays the original result without posting to ERPNext again; reusing it with a different " +
        "body is a 409.",
    }),
});

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const listRouteDef = createRoute({
  method: "get",
  path: "/api/finance/refunds",
  tags: ["Finance"],
  operationId: "listRefunds",
  summary: "List refund requests",
  description:
    "Paginated refund requests for the caller's school from the local read model. " +
    "Filter by student or status.",
  security: [{ bearerAuth: [] }],
  request: { query: refundQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated refund requests.", schema: refundListSchema } },
    [400, 401, 403, 500],
  ),
});

const getRouteDef = createRoute({
  method: "get",
  path: "/api/finance/refunds/{refundId}",
  tags: ["Finance"],
  operationId: "getRefund",
  summary: "Get a refund request",
  description: "Returns one refund request by Studafy id.",
  security: [{ bearerAuth: [] }],
  request: { params: refundIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The requested refund.", schema: refundSchema } },
    [400, 401, 403, 404, 500],
  ),
});

const initiateRouteDef = createRoute({
  method: "post",
  path: "/api/finance/refunds/initiate",
  tags: ["Finance"],
  operationId: "initiateRefund",
  summary: "Initiate a refund request (maker step)",
  description:
    "Creates a pending refund request with the given reason code. A second user must approve " +
    "the refund via the approve endpoint before it is forwarded to ERPNext. The initiator and " +
    "approver must be different users.\n\n" +
    "`Idempotency-Key` is required. The same key with the same body returns the original result " +
    "and creates exactly one refund request; the same key with a different body is refused with 409.\n\n" +
    "ERPNext validates that the refund amount does not exceed the paid amount on the target " +
    "invoice. Its refusal is returned as an RFC 9457 problem document.",
  security: [{ bearerAuth: [] }],
  request: {
    headers: idempotencyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: initiateRefundBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The created refund request, awaiting checker approval.",
        schema: refundSchema,
      },
      200: {
        description:
          "An earlier request with this Idempotency-Key already created this refund; its result " +
          "is replayed and no ERPNext call was made.",
        schema: refundSchema,
      },
    },
    [400, 401, 403, 409, 429, 500, 503],
  ),
});

const approveRouteDef = createRoute({
  method: "post",
  path: "/api/finance/refunds/{refundId}/approve",
  tags: ["Finance"],
  operationId: "approveRefund",
  summary: "Approve a refund request (checker step)",
  description:
    "Approves a pending refund request and forwards it to ERPNext as a Credit Note (return " +
    "Sales Invoice). The approving user must differ from the initiating user. " +
    "ERPNext validates that the refund amount does not exceed the net paid amount.",
  security: [{ bearerAuth: [] }],
  request: {
    params: refundIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: approveRefundBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The approved and forwarded refund.", schema: refundSchema } },
    [400, 401, 403, 404, 409, 429, 500, 503],
  ),
});

const rejectRouteDef = createRoute({
  method: "post",
  path: "/api/finance/refunds/{refundId}/reject",
  tags: ["Finance"],
  operationId: "rejectRefund",
  summary: "Reject a refund request (checker step)",
  description:
    "Rejects a pending refund request with mandatory rejection notes. The rejecting user must " +
    "differ from the initiating user. Releases the idempotency key so the caller can correct " +
    "and retry.",
  security: [{ bearerAuth: [] }],
  request: {
    params: refundIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: rejectRefundBodySchema } },
    },
  },
  responses: standardResponses(
    { 200: { description: "The rejected refund request.", schema: refundSchema } },
    [400, 401, 403, 404, 409, 500],
  ),
});

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function refundRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/finance/refunds/initiate", auditAction("insert", "refund_requests"));
  routes.use("/api/finance/refunds/{refundId}/approve", auditAction("update", "refund_requests"));
  routes.use("/api/finance/refunds/{refundId}/reject", auditAction("update", "refund_requests"));

  routes.use("/api/finance/refunds*", requirePermission(PERMISSIONS.BILLING_READ));
  routes.use("/api/finance/refunds/initiate", requirePermission(PERMISSIONS.BILLING_UPDATE));
  routes.use(
    "/api/finance/refunds/{refundId}/approve",
    requirePermission(PERMISSIONS.BILLING_REFUND),
  );
  routes.use(
    "/api/finance/refunds/{refundId}/reject",
    requirePermission(PERMISSIONS.BILLING_REFUND),
  );

  // --- List refunds ---

  routes.openapi(listRouteDef, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listRefunds(tx, auth.schoolId, query),
    );

    return c.json({ refunds: rows.map(toRefundResponse), total }, 200);
  });

  // --- Get refund by id ---

  routes.openapi(getRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { refundId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getRefund(tx, auth.schoolId, refundId),
    );

    return c.json(toRefundResponse(row), 200);
  });

  // --- Initiate refund (maker) ---

  routes.openapi(initiateRouteDef, async (c) => {
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("idempotency-key")?.trim();

    if (!idempotencyKey) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.REFUND_IDEMPOTENCY_KEY_REQUIRED,
        "An Idempotency-Key header is required to initiate a refund",
      );
    }

    const { row, replayed } = await initiateRefund(database, tenantFrom(c), body, idempotencyKey);

    return replayed ? c.json(toRefundResponse(row), 200) : c.json(toRefundResponse(row), 201);
  });

  // --- Approve refund (checker) ---

  routes.openapi(approveRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { refundId } = c.req.valid("param");
    const acceptLanguage = c.req.header("Accept-Language") ?? undefined;

    const row = await withTenantTx(database, tenantFrom(c), async (tx) => {
      const erpnext = await erpnextFactory.forSchool(tx, auth.schoolId);
      return approveRefund(tx, erpnext, auth.schoolId, auth.userId, refundId, acceptLanguage);
    });

    return c.json(toRefundResponse(row), 200);
  });

  // --- Reject refund (checker) ---

  routes.openapi(rejectRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { refundId } = c.req.valid("param");
    const body = c.req.valid("json");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      rejectRefund(tx, auth.schoolId, auth.userId, refundId, body.reason_notes),
    );

    return c.json(toRefundResponse(row), 200);
  });

  return routes;
}
