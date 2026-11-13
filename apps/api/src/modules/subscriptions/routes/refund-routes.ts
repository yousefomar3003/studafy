import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import {
  createAiRefundRequest,
  createSchoolRefundRequest,
  listMyAiRefundRequests,
  listSchoolRefundRequests,
} from "../services/refund-service";

import {
  createAiRefundBodySchema,
  createSchoolRefundBodySchema,
  refundRequestListSchema,
  refundRequestSchema,
} from "./refund-schemas";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";

const listSchoolRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/current/refund-requests",
  tags: ["Subscriptions"],
  operationId: "listSchoolRefundRequests",
  summary: "The school plan's refund requests",
  description: "Newest first. Billing admins only, web-origin only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Refund requests.", schema: refundRequestListSchema } },
    [401, 403, 429, 503],
  ),
});

const createSchoolRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/current/refund-requests",
  tags: ["Subscriptions"],
  operationId: "createSchoolRefundRequest",
  summary: "Ask Studafy to refund a payment for the school plan",
  description:
    "Files a refund request for Studafy staff to review. `paymentReference`, when given, must be a " +
    "paid invoice from `GET /api/subscriptions/current/invoices`. One open request per " +
    "subscription. Billing admins only, web-origin only, audited.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createSchoolRefundBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Refund requested.", schema: refundRequestSchema } },
    [400, 401, 403, 404, 409, 429, 502, 503],
  ),
});

const listAiRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/ai/refund-requests",
  tags: ["Subscriptions"],
  operationId: "listAiRefundRequests",
  summary: "The AI add-on refund requests the caller filed",
  description: "Newest first. Web-origin only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Refund requests.", schema: refundRequestListSchema } },
    [401, 403, 429, 503],
  ),
});

const createAiRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/ai/refund-requests",
  tags: ["Subscriptions"],
  operationId: "createAiRefundRequest",
  summary: "Ask Studafy to refund a student's AI add-on",
  description:
    "Files a refund request for Studafy staff to review. The caller must be the student or a " +
    "parent linked to them; anyone else gets 404. One open request per subscription. Web-origin " +
    "only, audited.",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createAiRefundBodySchema } },
    },
  },
  responses: standardResponses(
    { 201: { description: "Refund requested.", schema: refundRequestSchema } },
    [400, 401, 403, 404, 409, 429, 503],
  ),
});

/**
 * Refund requests, requester side. Web channel only, like every route that manages a paid digital
 * subscription (see store-payment-channel.test.ts). Named `routes` so the audit- and
 * permission-guard CI scanners see the mutating routes.
 *
 * The school plan's routes need `organization:manage_billing`, the permission cancellation uses.
 * The AI add-on's routes have no route-time permission: who may ask is "the student, or a parent of
 * this student", which depends on the body, so createAiRefundRequest checks it.
 */
export function refundRequestRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/subscriptions/current/refund-requests", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/subscriptions/current/refund-requests",
    requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING),
  );
  routes.use(
    "/api/subscriptions/current/refund-requests",
    auditAction("insert", "subscription_refund_requests"),
  );

  routes.use("/api/subscriptions/ai/refund-requests", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/subscriptions/ai/refund-requests",
    auditAction("insert", "subscription_refund_requests"),
  );

  routes.openapi(listSchoolRoute, async (c) => {
    const auth = requireAuth(c);
    const requests = await listSchoolRefundRequests(database, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
    });
    return c.json({ requests }, 200);
  });

  routes.openapi(createSchoolRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const request = await createSchoolRefundRequest(database, providers, {
      ...body,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(request, 201);
  });

  routes.openapi(listAiRoute, async (c) => {
    const auth = requireAuth(c);
    const requests = await listMyAiRefundRequests(database, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId: c.get("requestId"),
    });
    return c.json({ requests }, 200);
  });

  routes.openapi(createAiRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const request = await createAiRefundRequest(database, {
      ...body,
      tenantContext: {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      },
    });
    return c.json(request, 201);
  });

  return routes;
}
