import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import { standardResponses } from "../../../openapi/responses";
import { getActivePlans } from "../services/subscription-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";

const PriceSchema = z.object({
  id: z.string(),
  currencyCode: z.string(),
  billingInterval: z.string(),
  amountMinor: z.number(),
  stripePriceId: z.string().nullable(),
});

const PlanSchema = z.object({
  id: z.string(),
  code: z.string(),
  displayName: z.string(),
  description: z.string().nullable(),
  prices: z.array(PriceSchema),
});

const PlanListResponseSchema = z.array(PlanSchema);

const listPlansRoute = createRoute({
  method: "get",
  path: "/api/subscriptions/plans",
  tags: ["Subscriptions"],
  operationId: "listSubscriptionPlans",
  summary: "List available subscription plans",
  description: "Returns all active plans with their prices for the authenticated school.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "List of active plans with prices",
        schema: PlanListResponseSchema,
      },
    },
    [401, 403, 500],
  ),
});

export function planRoutes(database: Database): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(listPlansRoute, async (c) => {
    const plans = await getActivePlans(database);
    return c.json(plans, 200);
  });

  return app;
}
