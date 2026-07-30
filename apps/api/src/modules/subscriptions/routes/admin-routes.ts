import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { standardResponses } from "../../../openapi/responses";
import { syncPlanPrices } from "../services/price-sync-service";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderPort } from "../ports/payment-provider";

function requireProvider(provider: PaymentProviderPort | null): PaymentProviderPort {
  if (!provider) {
    throw new CodedHttpException(
      503,
      ERROR_CODES.STRIPE_NOT_CONFIGURED,
      "Stripe billing is not configured for this deployment",
    );
  }
  return provider;
}

const SyncResponseSchema = z.object({
  syncedPlans: z.number(),
  syncedPrices: z.number(),
});

const syncPricesRoute = createRoute({
  method: "post",
  path: "/api/admin/subscriptions/sync-prices",
  tags: ["Subscriptions", "Admin"],
  operationId: "syncPlanPrices",
  summary: "Sync plans and prices with Stripe",
  description:
    "Creates or updates Stripe Products and Prices to match the local plans and plan_prices table. " +
    "Admin-only endpoint. Requires Stripe to be configured.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Price sync completed",
        schema: SyncResponseSchema,
      },
    },
    [401, 403, 500, 503],
  ),
});

export function adminSubscriptionRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
  logger: Logger,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.openapi(syncPricesRoute, async (c) => {
    const active = requireProvider(provider);
    const result = await syncPlanPrices(database, active, logger);
    return c.json({ syncedPlans: result.syncedPlans, syncedPrices: result.syncedPrices }, 200);
  });

  return app;
}
