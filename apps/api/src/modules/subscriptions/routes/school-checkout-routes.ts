import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { createTieredSchoolCheckoutSession } from "../services/checkout-service";

import type { Database } from "../../../db";
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

const SchoolCheckoutRequestSchema = z.object({
  planId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
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
    "Computes the enrolled student count and creates a Stripe Checkout session for the selected plan. Web-origin only.",
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
    [400, 401, 403, 503],
  ),
});

export function schoolCheckoutRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("/api/subscriptions/school/checkout", requireChannel(AUTH_CHANNELS.WEB));

  app.openapi(schoolCheckoutRoute, async (c) => {
    const active = requireProvider(provider);
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const result = await createTieredSchoolCheckoutSession(database, active, {
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
