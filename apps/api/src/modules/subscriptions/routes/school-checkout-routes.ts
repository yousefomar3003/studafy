import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { z } from "zod";

import { returnUrlSchema } from "../../../lib/security/return-url";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { createTieredSchoolCheckoutSession } from "../services/checkout-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";

const SchoolCheckoutRequestSchema = z.object({
  planId: z.string().uuid(),
  successUrl: returnUrlSchema,
  cancelUrl: returnUrlSchema,
});

const SchoolCheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});

const schoolCheckoutRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/school/checkout",
  tags: ["Subscriptions"],
  operationId: "createSchoolCheckoutSession",
  summary: "Create a tiered school checkout session",
  description:
    "Computes the enrolled student count and creates a hosted checkout for the selected plan at the " +
    "payment provider for the school's region (Stripe, or Tap Payments in MENA). Web-origin only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: SchoolCheckoutRequestSchema } } },
  },
  responses: standardResponses(
    {
      200: {
        description: "Checkout session created with seat-based quantity",
        schema: SchoolCheckoutResponseSchema,
      },
    },
    [400, 401, 403, 502, 503],
  ),
});

export function schoolCheckoutRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("/api/subscriptions/school/checkout", requireChannel(AUTH_CHANNELS.WEB));
  // Billing administrators only (QA-013): see checkout-routes.ts.
  app.use(
    "/api/subscriptions/school/checkout",
    requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING),
  );

  app.openapi(schoolCheckoutRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const result = await createTieredSchoolCheckoutSession(database, providers, {
      schoolId: auth.schoolId,
      planId: body.planId,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(result, 200);
  });

  return app;
}
