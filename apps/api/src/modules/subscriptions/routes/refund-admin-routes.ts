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
  approveRefundRequest,
  getPlatformRefundRequest,
  listPlatformRefundRequests,
  rejectRefundRequest,
} from "../services/refund-service";

import {
  approveRefundBodySchema,
  approveRefundResponseSchema,
  platformRefundDetailSchema,
  platformRefundListQuerySchema,
  platformRefundListResponseSchema,
  platformRefundParamSchema,
  platformRefundRequestSchema,
  rejectRefundBodySchema,
} from "./refund-schemas";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { PlatformActor } from "../services/refund-service";
import type { Context } from "hono";

const TAG = "Platform";

const listRoute = createRoute({
  method: "get",
  path: "/api/platform/refund-requests",
  tags: [TAG],
  operationId: "listPlatformRefundRequests",
  summary: "Every school's subscription refund requests",
  description:
    "Paged, newest first, filterable by status, scope (school plan or AI add-on), school, and a " +
    "school/requester search. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { query: platformRefundListQuerySchema },
  responses: standardResponses(
    {
      200: {
        description: "One page of refund requests.",
        schema: platformRefundListResponseSchema,
      },
    },
    [400, 401, 403, 429, 500],
  ),
});

const getRoute = createRoute({
  method: "get",
  path: "/api/platform/refund-requests/{schoolId}/{requestId}",
  tags: [TAG],
  operationId: "getPlatformRefundRequest",
  summary: "One refund request",
  description:
    "The request, and while it can still be approved the school's recent paid payments to refund " +
    "from. SUPER_ADMIN only.",
  security: [{ bearerAuth: [] }],
  request: { params: platformRefundParamSchema },
  responses: standardResponses(
    { 200: { description: "Refund request detail.", schema: platformRefundDetailSchema } },
    [400, 401, 403, 404, 429, 500],
  ),
});

const approveRoute = createRoute({
  method: "post",
  path: "/api/platform/refund-requests/{schoolId}/{requestId}/approve",
  tags: [TAG],
  operationId: "approvePlatformRefundRequest",
  summary: "Approve a refund request and issue the refund",
  description:
    "Refunds the chosen payment through its provider, in full by default or partially with " +
    "`amountMinor`. A `failed` request may be approved again. Optionally also schedules a school " +
    "plan to cancel at period end. Audited in the school and in the operator's own school.",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformRefundParamSchema,
    body: { required: true, content: { "application/json": { schema: approveRefundBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Refund issued.", schema: approveRefundResponseSchema } },
    [400, 401, 403, 404, 409, 429, 500, 501, 502, 503],
  ),
});

const rejectRoute = createRoute({
  method: "post",
  path: "/api/platform/refund-requests/{schoolId}/{requestId}/reject",
  tags: [TAG],
  operationId: "rejectPlatformRefundRequest",
  summary: "Reject a refund request",
  description:
    "Closes a pending request without refunding. The note is shown to the requester, so it is " +
    "required. Audited in the school and in the operator's own school.",
  security: [{ bearerAuth: [] }],
  request: {
    params: platformRefundParamSchema,
    body: { required: true, content: { "application/json": { schema: rejectRefundBodySchema } } },
  },
  responses: standardResponses(
    { 200: { description: "Request rejected.", schema: platformRefundRequestSchema } },
    [400, 401, 403, 404, 409, 429, 500],
  ),
});

function actorFrom(c: Context<AppEnv>): PlatformActor {
  const auth = requireAuth(c);
  return { userId: auth.userId, schoolId: auth.schoolId, requestId: c.get("requestId") };
}

/**
 * The platform console's refund queue (`/api/platform/refund-requests/*`). Lives with the rest of
 * subscription billing rather than in modules/platform, but follows that module's rules: web
 * channel only, reads on `platform:read`, decisions on `platform:manage` -- both SUPER_ADMIN only.
 */
export function refundAdminRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  routes.use("/api/platform/refund-requests", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/refund-requests", requirePermission(PERMISSIONS.PLATFORM_READ));
  routes.use("/api/platform/refund-requests/*", requireChannel(AUTH_CHANNELS.WEB));
  routes.use("/api/platform/refund-requests/*", requirePermission(PERMISSIONS.PLATFORM_READ));

  const manage = requirePermission(PERMISSIONS.PLATFORM_MANAGE);
  routes.use("/api/platform/refund-requests/:schoolId/:requestId/approve", manage);
  routes.use(
    "/api/platform/refund-requests/:schoolId/:requestId/approve",
    auditAction("update", "subscription_refund_requests"),
  );
  routes.use("/api/platform/refund-requests/:schoolId/:requestId/reject", manage);
  routes.use(
    "/api/platform/refund-requests/:schoolId/:requestId/reject",
    auditAction("update", "subscription_refund_requests"),
  );

  routes.openapi(listRoute, async (c) => {
    const query = c.req.valid("query");
    return c.json(await listPlatformRefundRequests(database, query), 200);
  });

  routes.openapi(getRoute, async (c) => {
    const { schoolId, requestId } = c.req.valid("param");
    return c.json(await getPlatformRefundRequest(database, providers, schoolId, requestId), 200);
  });

  routes.openapi(approveRoute, async (c) => {
    const { schoolId, requestId } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await approveRefundRequest(
      database,
      providers,
      schoolId,
      requestId,
      body,
      actorFrom(c),
    );
    return c.json(result, 200);
  });

  routes.openapi(rejectRoute, async (c) => {
    const { schoolId, requestId } = c.req.valid("param");
    const { note } = c.req.valid("json");
    return c.json(
      await rejectRefundRequest(database, schoolId, requestId, note, actorFrom(c)),
      200,
    );
  });

  return routes;
}
