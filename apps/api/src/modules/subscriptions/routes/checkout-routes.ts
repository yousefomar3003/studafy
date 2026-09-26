import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PERMISSIONS } from "@studafy/constants";
import { z } from "zod";

import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { requirePaymentProvider } from "../payment-provider-routing";
import {
  createSchoolCheckoutSession,
  createBillingPortalSession,
} from "../services/checkout-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderRegistry } from "../payment-provider-routing";

const CheckoutRequestSchema = z.object({
  priceId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const PortalRequestSchema = z.object({
  returnUrl: z.string().url(),
});

const CheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});

const PortalResponseSchema = z.object({
  url: z.string(),
});

const checkoutRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/checkout",
  tags: ["Subscriptions"],
  operationId: "createCheckoutSession",
  summary: "Create a Stripe Checkout session",
  description:
    "Creates a Stripe Checkout session for the authenticated school. Requires Stripe to be configured.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CheckoutRequestSchema } } },
  },
  responses: standardResponses(
    {
      200: { description: "Checkout session created", schema: CheckoutResponseSchema },
    },
    [400, 401, 403, 404, 502, 503],
  ),
});

const portalRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/portal",
  tags: ["Subscriptions"],
  operationId: "createBillingPortalSession",
  summary: "Open Stripe billing portal",
  description:
    "Creates a Stripe billing portal session so the school admin can manage their payment method. " +
    "Admin-only, web-origin only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: PortalRequestSchema } } },
  },
  responses: standardResponses(
    {
      200: { description: "Portal session created", schema: PortalResponseSchema },
    },
    [400, 401, 403, 404, 503],
  ),
});

export function checkoutRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  // Portal-session, specifically: managing the payment method on file is an admin action, unlike
  // starting a checkout, which any authenticated staff session may do today.
  app.use("/api/subscriptions/portal", requireChannel(AUTH_CHANNELS.WEB));
  app.use("/api/subscriptions/portal", requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING));

  app.openapi(checkoutRoute, async (c) => {
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const result = await createSchoolCheckoutSession(database, providers, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(result, 200);
  });

  app.openapi(portalRoute, async (c) => {
    // Stripe only: Tap has no customer billing portal.
    const { port: active } = requirePaymentProvider(providers, "stripe");
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const result = await createBillingPortalSession(
      database,
      active,
      auth.schoolId,
      body.returnUrl,
      {
        schoolId: auth.schoolId,
        userId: auth.userId,
        requestId,
      },
    );

    return c.json(result, 200);
  });

  return app;
}
