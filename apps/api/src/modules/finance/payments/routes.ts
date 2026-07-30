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
  createPaymentBodySchema,
  paymentIdParamSchema,
  paymentListSchema,
  paymentQuerySchema,
  paymentSchema,
} from "./schemas";
import { createPayment, getPayment, listPayments } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { TenantErpNextFactory } from "../client/tenant-client";
import type { Context } from "hono";

function tenantFrom(c: Context<AppEnv>): {
  schoolId: string;
  userId: string;
  requestId?: string;
} {
  const auth = requireAuth(c);
  return { schoolId: auth.schoolId, userId: auth.userId, requestId: c.get("requestId") };
}

/**
 * The `Idempotency-Key` header, declared as required.
 *
 * `idempotencyMiddleware` already runs on `/api/finance/*`, but it only *honours* the header when it
 * is present — a request without one passes straight through unguarded. On every other finance
 * endpoint that is a reasonable default. On this one it would mean an unguarded payment, so the
 * header is required by the contract and enforced in the handler.
 */
const idempotencyHeaderSchema = z.object({
  "idempotency-key": z
    .string()
    .min(1)
    .max(255)
    .openapi({
      description:
        "Client-generated key making this payment safe to retry. Reusing a key with the same body " +
        "replays the original result without posting to ERPNext again; reusing it with a different " +
        "body is a 409.",
    }),
});

const createRouteDef = createRoute({
  method: "post",
  path: "/api/finance/payments",
  tags: ["Finance"],
  operationId: "createPayment",
  summary: "Record a payment against an invoice",
  description:
    "Forwards the payment to ERPNext as a submitted Payment Entry allocated to the target Sales " +
    "Invoice. Supports full and partial amounts in cash, bank transfer, or externally-captured card.\n\n" +
    "ERPNext owns every financial rule: outstanding balance, overpayment rejection, and allocation. " +
    "Its refusal is returned as an RFC 9457 problem document with ERPNext's own message rather than " +
    "being pre-empted or paraphrased here.\n\n" +
    "`Idempotency-Key` is required. The same key with the same body returns the original result and " +
    "creates exactly one Payment Entry, including after a crash mid-request; the same key with a " +
    "different body is refused with 409.\n\n" +
    'The response reports `status: "pending"` — submission is confirmed asynchronously by ERPNext\'s ' +
    "webhook, which is also what supplies `receipt_url`.",
  security: [{ bearerAuth: [] }],
  request: {
    headers: idempotencyHeaderSchema,
    body: {
      required: true,
      content: { "application/json": { schema: createPaymentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "The recorded payment, awaiting ERPNext confirmation.",
        schema: paymentSchema,
      },
      200: {
        description:
          "An earlier request with this Idempotency-Key already created this payment; its result " +
          "is replayed and no ERPNext call was made.",
        schema: paymentSchema,
      },
    },
    // 409 covers both idempotency refusals. ERPNext timeouts surface as 504, which
    // PROBLEM_STATUSES cannot express — see the note in openapi/responses.ts.
    [400, 401, 403, 404, 409, 429, 500, 503],
  ),
});

const listRouteDef = createRoute({
  method: "get",
  path: "/api/finance/payments",
  tags: ["Finance"],
  operationId: "listPayments",
  summary: "List payments",
  description:
    "Paginated payments for the caller's school from the local read model. Filter by student, " +
    "target invoice, or status; `status=pending` is the reconciliation view for payments ERPNext " +
    "has not yet confirmed.",
  security: [{ bearerAuth: [] }],
  request: { query: paymentQuerySchema },
  responses: standardResponses(
    { 200: { description: "Paginated payments.", schema: paymentListSchema } },
    [400, 401, 403, 500],
  ),
});

const getRouteDef = createRoute({
  method: "get",
  path: "/api/finance/payments/{paymentId}",
  tags: ["Finance"],
  operationId: "getPayment",
  summary: "Get a payment",
  description:
    "Returns one payment by Studafy id or ERPNext Payment Entry docname, including `receipt_url` " +
    "once ERPNext has confirmed it.",
  security: [{ bearerAuth: [] }],
  request: { params: paymentIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The requested payment.", schema: paymentSchema } },
    [400, 401, 403, 404, 500],
  ),
});

export function paymentRoutes(
  database: Database,
  erpnextFactory: TenantErpNextFactory,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // auditAction records intent on the context; the row itself is written by emitAuditLog inside the
  // service's own transaction, so it commits with the payment or not at all.
  routes.use("/api/finance/payments", auditAction("insert", "payment_cache"));

  // BILLING_UPDATE to record money, BILLING_READ to look at it. Registered narrowest-last so the
  // collection path's write permission does not leak onto the read routes.
  routes.use("/api/finance/payments", requirePermission(PERMISSIONS.BILLING_UPDATE));
  routes.use("/api/finance/payments/{paymentId}", requirePermission(PERMISSIONS.BILLING_READ));

  routes.openapi(createRouteDef, async (c) => {
    const body = c.req.valid("json");
    const idempotencyKey = c.req.header("idempotency-key")?.trim();
    const acceptLanguage = c.req.header("Accept-Language");

    if (!idempotencyKey) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.PAYMENT_IDEMPOTENCY_KEY_REQUIRED,
        "An Idempotency-Key header is required to record a payment",
      );
    }

    const { row, replayed } = await createPayment(
      database,
      erpnextFactory,
      tenantFrom(c),
      body,
      idempotencyKey,
      acceptLanguage,
    );

    // 200 rather than 201 on replay: the resource was created by the earlier request, not this one.
    return replayed ? c.json(row, 200) : c.json(row, 201);
  });

  routes.openapi(listRouteDef, async (c) => {
    const auth = requireAuth(c);
    const query = c.req.valid("query");

    const { rows, total } = await withTenantTx(database, tenantFrom(c), (tx) =>
      listPayments(tx, auth.schoolId, query),
    );

    return c.json({ payments: rows, total }, 200);
  });

  routes.openapi(getRouteDef, async (c) => {
    const auth = requireAuth(c);
    const { paymentId } = c.req.valid("param");

    const row = await withTenantTx(database, tenantFrom(c), (tx) =>
      getPayment(tx, auth.schoolId, paymentId),
    );

    return c.json(row, 200);
  });

  return routes;
}
