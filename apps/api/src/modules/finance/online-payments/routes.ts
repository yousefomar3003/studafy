import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";

import {
  onlineFeePaymentIdParamSchema,
  onlineFeePaymentSchema,
  startOnlineFeePaymentBodySchema,
  startOnlineFeePaymentResponseSchema,
} from "./schemas";
import { getOnlineFeePayment, startOnlineFeePayment } from "./service";

import type { Database } from "../../../db/client";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../../subscriptions/payment-provider-routing";

const startRouteDef = createRoute({
  method: "post",
  path: "/api/finance/online-payments",
  tags: ["Finance"],
  operationId: "startOnlineFeePayment",
  summary: "Start an online payment for an outstanding invoice",
  description:
    "Creates a hosted payment for the invoice's full outstanding balance at the payment provider " +
    "for the school's region (Tap Payments in its MENA markets, Stripe elsewhere) and returns the " +
    "page to send the payer to. The amount comes from the invoice, never from the request. Open to " +
    "a parent linked to the student and to staff with billing:update. The payment is settled by " +
    "the provider's webhook and recorded in ERPNext; poll GET /api/finance/online-payments/{id}.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: startOnlineFeePaymentBodySchema } },
    },
  },
  responses: standardResponses(
    {
      201: {
        description: "Hosted payment created",
        schema: startOnlineFeePaymentResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 502, 503],
  ),
});

const getRouteDef = createRoute({
  method: "get",
  path: "/api/finance/online-payments/{paymentId}",
  tags: ["Finance"],
  operationId: "getOnlineFeePayment",
  summary: "Get an online fee payment",
  description: "Visible to the payer who started it and to staff with billing:read.",
  security: [{ bearerAuth: [] }],
  request: { params: onlineFeePaymentIdParamSchema },
  responses: standardResponses(
    { 200: { description: "The payment", schema: onlineFeePaymentSchema } },
    [401, 404],
  ),
});

export function onlineFeePaymentRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // The row and its audit entry are written in the service's transaction; this declares the intent.
  routes.use("/api/finance/online-payments", auditAction("insert", "online_fee_payments"));

  routes.openapi(startRouteDef, async (c) => {
    const result = await startOnlineFeePayment(
      database,
      providers,
      requireAuth(c),
      c.get("requestId"),
      c.req.valid("json"),
    );
    return c.json(result, 201);
  });

  routes.openapi(getRouteDef, async (c) => {
    const { paymentId } = c.req.valid("param");
    const payment = await getOnlineFeePayment(
      database,
      requireAuth(c),
      c.get("requestId"),
      paymentId,
    );
    return c.json(payment, 200);
  });

  return routes;
}
