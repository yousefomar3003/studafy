import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES } from "@studafy/constants";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { standardResponses } from "../../../openapi/responses";
import { handleStripeWebhook } from "../stripe/webhook";

import type { Database } from "../../../db";
import type { Logger } from "../../../logger";
import type { PaymentProviderPort } from "../ports/payment-provider";

const WebhookResponseSchema = z.object({
  received: z.boolean(),
});

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

const webhookRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/webhook/stripe",
  tags: ["Subscriptions"],
  operationId: "receiveStripeWebhook",
  summary: "Receive Stripe webhook events",
  description:
    "Ingests Stripe webhook events (checkout.session.completed, invoice.paid, etc.). " +
    "Authenticated by the Stripe-Signature header, not a bearer token.",
  security: [],
  request: {},
  responses: standardResponses(
    {
      200: { description: "Webhook processed", schema: WebhookResponseSchema },
    },
    [400, 503],
  ),
});

export function webhookRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
  logger: Logger,
): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(webhookRoute, async (c) => {
    const active = requireProvider(provider);

    const signature = c.req.header("stripe-signature");
    if (!signature) {
      throw new CodedHttpException(
        400,
        ERROR_CODES.STRIPE_WEBHOOK_INVALID,
        "Missing stripe-signature header",
      );
    }

    const body = await c.req.arrayBuffer();
    const payload = Buffer.from(body);

    const result = await handleStripeWebhook(
      { database, provider: active, logger },
      payload,
      signature,
    );

    return c.json(result, 200);
  });

  return app;
}
