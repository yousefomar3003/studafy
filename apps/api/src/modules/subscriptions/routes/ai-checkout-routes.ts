import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { requireAuth } from "../../../middleware/authContext";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { createAiCheckoutSession } from "../services/checkout-service";

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

const AiCheckoutRequestSchema = z.object({
  priceId: z.string().uuid(),
  studentId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

const AiCheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});

const aiCheckoutRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/ai/checkout",
  tags: ["Subscriptions"],
  operationId: "createAiCheckoutSession",
  summary: "Create an AI subscription checkout session",
  description:
    "Creates a Stripe Checkout session for a student-level AI add-on. " +
    "Requires the school subscription to be active. Web-origin only.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: AiCheckoutRequestSchema } } },
  },
  responses: standardResponses(
    {
      200: {
        description: "Checkout session created",
        schema: AiCheckoutResponseSchema,
      },
    },
    [400, 401, 403, 404, 503],
  ),
});

export function aiCheckoutRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("/api/subscriptions/ai/checkout", requireChannel(AUTH_CHANNELS.WEB));

  app.openapi(aiCheckoutRoute, async (c) => {
    const active = requireProvider(provider);
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const result = await createAiCheckoutSession(database, active, {
      schoolId: auth.schoolId,
      priceId: body.priceId,
      studentId: body.studentId,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(result, 200);
  });

  return app;
}
