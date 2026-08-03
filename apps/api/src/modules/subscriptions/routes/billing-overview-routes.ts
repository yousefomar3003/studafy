import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";

import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { getBillingOverview } from "../services/billing-overview-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";

const BillingOverviewResponseSchema = z
  .object({
    subscription: z.object({
      id: z.string(),
      status: z.string(),
      currentPeriodStart: z.string().datetime(),
      currentPeriodEnd: z.string().datetime(),
      cancelAtPeriodEnd: z.boolean(),
      cancellationRequestedAt: z.string().datetime().nullable(),
      cancellationReason: z.string().nullable(),
      retentionState: z.string(),
    }),
    plan: z.object({
      id: z.string(),
      code: z.string(),
      displayName: z.string(),
    }),
    seats: z.object({
      used: z.number(),
      cap: z.number(),
    }),
  })
  .openapi("BillingOverview");

const getBillingOverviewRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/current",
  tags: ["Subscriptions"],
  operationId: "getBillingOverview",
  summary: "Get the school's billing overview",
  description:
    "Current plan, subscription lifecycle state (including any pending cancellation and retention " +
    "state), and seat usage against the plan's cap. Admin-only, web-origin only.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    { 200: { description: "Billing overview.", schema: BillingOverviewResponseSchema } },
    [401, 403, 404, 429, 500],
  ),
});

/**
 * The school billing portal's read surface: current plan, seats, and subscription lifecycle state.
 * Admin-only (ORGANIZATION_MANAGE_BILLING), web-channel only -- same posture as the school settings
 * admin panel this mirrors.
 */
export function billingOverviewRoutes(database: Database): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();
  const basePath = "/api/subscriptions/current";

  app.use(basePath, requireChannel(AUTH_CHANNELS.WEB));
  app.use(basePath, requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING));

  app.openapi(getBillingOverviewRoute, async (c) => {
    const auth = requireAuth(c);
    const requestId = c.get("requestId");

    const overview = await getBillingOverview(database, auth.schoolId, {
      schoolId: auth.schoolId,
      userId: auth.userId,
      requestId,
    });

    return c.json(
      {
        subscription: {
          ...overview.subscription,
          currentPeriodStart: overview.subscription.currentPeriodStart.toISOString(),
          currentPeriodEnd: overview.subscription.currentPeriodEnd.toISOString(),
          cancellationRequestedAt:
            overview.subscription.cancellationRequestedAt?.toISOString() ?? null,
        },
        plan: overview.plan,
        seats: overview.seats,
      },
      200,
    );
  });

  return app;
}
