import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ERROR_CODES, JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";
import { z } from "zod";

import { CodedHttpException } from "../../../coded-http-exception";
import { auditAction } from "../../../middleware/auditEmitter";
import { extractClientIp } from "../../../middleware/rateLimiter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { handleStripeWebhook } from "../stripe/webhook-processor";

import type { Database } from "../../../db";
import type { SecurityEventSink } from "../../../lib/security/securityEventSink";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { PaymentProviderPort } from "../ports/payment-provider";
import type { BillingEventRetryEnqueuer } from "../stripe/webhook-processor";

/**
 * The response body is deliberately thin.
 *
 * Stripe reads the status code and nothing else, and the endpoint is unauthenticated -- so anything
 * richer would be a free oracle telling an unauthenticated caller whether a given event id had been
 * seen, or which school a customer maps to. `outcome` is safe because it describes what *this*
 * request did, and a caller who cannot forge a signature never gets one.
 */
const WebhookResponseSchema = z.object({
  received: z.literal(true),
  outcome: z.enum(["duplicate", "processed", "parked"]),
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
  // Written as a literal, not a constant: the ST-065 CI gate (tests/audit-coverage.test.ts) reads
  // this file as text and matches `path: "/…"` against a string literal, so a constant here would
  // make the route invisible to the gate that is supposed to be guarding it.
  path: "/api/subscriptions/webhook/stripe",
  tags: ["Subscriptions"],
  operationId: "receiveStripeWebhook",
  summary: "Receive Stripe webhook events",
  description:
    "Ingests Stripe webhook events and applies the resulting subscription state transitions. " +
    "Authenticated by the Stripe-Signature header over the raw request body, not by a bearer " +
    "token. Deduplicated on the provider event id, so a redelivery is a no-op. Events that cannot " +
    "be attributed, mapped, or legally applied are parked for manual review and still answer 200 — " +
    "a 4xx would make Stripe redeliver them indefinitely.",
  // Explicitly empty, not omitted: this endpoint is authenticated, just not by our bearer scheme.
  security: [],
  request: {},
  responses: standardResponses(
    { 200: { description: "Webhook accepted", schema: WebhookResponseSchema } },
    [400, 503],
  ),
});

/**
 * Retry options for a transiently failed event.
 *
 * Five attempts with exponential backoff from one second, so a brief database blip is ridden out
 * without a human. `removeOnFail: false` is load-bearing: the dead-letter listener in apps/workers
 * reads `job.finishedOn` off the failed job, and a job removed on failure has nothing to read.
 */
const RETRY_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: false,
};

export interface WebhookRoutesOptions {
  eventSink?: SecurityEventSink | null;
  redis?: RedisClient | null;
  /** Overrides the Redis-backed producer. Tests pass a spy; production leaves it unset. */
  enqueueRetry?: BillingEventRetryEnqueuer;
}

export function webhookRoutes(
  database: Database,
  provider: PaymentProviderPort | null,
  logger: Logger,
  options: WebhookRoutesOptions = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Constructed once per app rather than per request: a Queue holds a Redis connection, and one per
  // webhook delivery would exhaust the connection limit under Stripe's ordinary traffic. Null when
  // Redis is absent, in which case a transient failure is still recorded on the billing_events row
  // (status 'failed') and picked up by Stripe's own redelivery — degraded, not silent.
  const retryQueue = options.redis
    ? new Queue(QUEUE_NAMES.BILLING, { connection: options.redis as never })
    : null;

  const enqueueRetry: BillingEventRetryEnqueuer | undefined =
    options.enqueueRetry ??
    (retryQueue
      ? async ({ providerEventId }) => {
          await retryQueue.add(
            JOB_NAMES.PROCESS_BILLING_EVENT,
            { version: 1, providerEventId },
            // The job id makes re-enqueueing the same event idempotent: BullMQ refuses a duplicate,
            // so a burst of redeliveries that all fail produces one retry chain, not one per
            // delivery.
            { ...RETRY_JOB_OPTIONS, jobId: `stripe:${providerEventId}` },
          );
        }
      : undefined);

  // Declares the mutation for the ST-065 CI gate. The rows themselves are written by
  // stripe/webhook-processor.ts from inside the transaction that changes the status, so a
  // transition and its audit record commit or roll back together.
  routes.use("/api/subscriptions/webhook/stripe", auditAction("update", "subscriptions"));

  routes.openapi(webhookRoute, async (c) => {
    const active = requireProvider(provider);

    // arrayBuffer(), never text(): the signature covers the exact bytes Stripe sent, and decoding to
    // a string and re-encoding is not guaranteed to reproduce them. Hono caches the parsed body, so
    // reading it here does not consume it for anyone downstream.
    const payload = Buffer.from(await c.req.arrayBuffer());

    const result = await handleStripeWebhook(
      {
        database,
        provider: active,
        logger,
        eventSink: options.eventSink,
        enqueueRetry,
      },
      payload,
      c.req.header("stripe-signature") ?? null,
      {
        path: c.req.path,
        clientIp: extractClientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      },
    );

    return c.json({ received: result.received, outcome: result.outcome } as const, 200);
  });

  return routes;
}
