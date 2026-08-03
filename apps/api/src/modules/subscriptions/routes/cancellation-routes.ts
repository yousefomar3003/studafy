import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { ERROR_CODES, PERMISSIONS } from "@studafy/constants";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { requireAuth } from "../../../middleware/authContext";
import { requirePermission } from "../../../middleware/authz";
import { requireChannel } from "../../../middleware/channelGuard";
import { standardResponses } from "../../../openapi/responses";
import { AUTH_CHANNELS } from "../../auth/channels";
import { reverseCancellation, scheduleCancellation } from "../services/cancellation-service";

import type { Database } from "../../../db";
import type { AppEnv } from "../../../middleware/requestId";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { SchoolSubscription } from "../services/subscription-service";

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

const CancelRequestSchema = z.object({
  reason: z.string().max(1000).optional(),
  retentionOfferShown: z.boolean().optional(),
});

const CancellationStateResponseSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    cancelAtPeriodEnd: z.boolean(),
    cancellationRequestedAt: z.string().datetime().nullable(),
    cancellationReason: z.string().nullable(),
    retentionState: z.string(),
    currentPeriodEnd: z.string().datetime(),
  })
  .openapi("SubscriptionCancellationState");

type CancellationState = z.infer<typeof CancellationStateResponseSchema>;

function toCancellationState(sub: SchoolSubscription): CancellationState {
  return {
    id: sub.id,
    status: sub.status,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancellationRequestedAt: sub.cancellationRequestedAt?.toISOString() ?? null,
    cancellationReason: sub.cancellationReason,
    retentionState: sub.retentionState,
    currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
  };
}

const cancelRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/current/cancel",
  tags: ["Subscriptions"],
  operationId: "cancelSubscription",
  summary: "Schedule the subscription to cancel at period end",
  description:
    "Schedules cancellation for the end of the current billing period; access and billing continue " +
    "until then. Records the reason and whether a retention offer was shown. Admin-only, " +
    "web-origin only, audited.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: CancelRequestSchema } } },
  },
  responses: standardResponses(
    {
      200: {
        description: "Cancellation scheduled.",
        schema: CancellationStateResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 503],
  ),
});

const reverseCancelRoute = createRoute({
  method: "post",
  path: "/api/subscriptions/current/cancel/reverse",
  tags: ["Subscriptions"],
  operationId: "reverseSubscriptionCancellation",
  summary: "Undo a pending end-of-period cancellation",
  description:
    "Reverses a previously scheduled cancellation and marks the retention state as won-back. " +
    "Admin-only, web-origin only, audited.",
  security: [{ bearerAuth: [] }],
  responses: standardResponses(
    {
      200: {
        description: "Cancellation reversed.",
        schema: CancellationStateResponseSchema,
      },
    },
    [400, 401, 403, 404, 409, 429, 503],
  ),
});

/**
 * Cancellation flow for the school billing portal. Both routes mutate `app.subscriptions` and are
 * therefore named `routes` (not `app`) so the audit- and permission-guard CI coverage scanners see
 * them -- see apps/api/tests/audit-coverage.test.ts's header for why the naming matters.
 */
export function cancellationRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.use("/api/subscriptions/current/cancel", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/subscriptions/current/cancel",
    requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING),
  );
  routes.use("/api/subscriptions/current/cancel", auditAction("update", "subscriptions"));

  routes.use("/api/subscriptions/current/cancel/reverse", requireChannel(AUTH_CHANNELS.WEB));
  routes.use(
    "/api/subscriptions/current/cancel/reverse",
    requirePermission(PERMISSIONS.ORGANIZATION_MANAGE_BILLING),
  );
  routes.use("/api/subscriptions/current/cancel/reverse", auditAction("update", "subscriptions"));

  routes.openapi(cancelRoute, async (c) => {
    const active = requireProvider(provider);
    const auth = requireAuth(c);
    const body = c.req.valid("json");
    const requestId = c.get("requestId");

    const sub = await scheduleCancellation(database, active, {
      schoolId: auth.schoolId,
      reason: body.reason,
      retentionOfferShown: body.retentionOfferShown,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(toCancellationState(sub), 200);
  });

  routes.openapi(reverseCancelRoute, async (c) => {
    const active = requireProvider(provider);
    const auth = requireAuth(c);
    const requestId = c.get("requestId");

    const sub = await reverseCancellation(database, active, {
      schoolId: auth.schoolId,
      tenantContext: { schoolId: auth.schoolId, userId: auth.userId, requestId },
    });

    return c.json(toCancellationState(sub), 200);
  });

  return routes;
}
