import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";
import { z } from "zod";

import { auditAction } from "../../../middleware/auditEmitter";
import { extractClientIp } from "../../../middleware/rateLimiter";
import { openApiValidationHook } from "../../../openapi/hook";
import { standardResponses } from "../../../openapi/responses";
import { requirePaymentProvider } from "../payment-provider-routing";
import { handleBillingWebhook } from "../webhooks/webhook-processor";

import type { Database } from "../../../db";
import type { SecurityEventSink } from "../../../lib/security/securityEventSink";
import type { Logger } from "../../../logger";
import type { AppEnv } from "../../../middleware/requestId";
import type { RedisClient } from "../../../redis";
import type { PaymentProviderRegistry } from "../payment-provider-routing";
import type { BillingEventRetryEnqueuer, FeePaymentSettler } from "../webhooks/webhook-processor";
import type { BillingProvider } from "@studafy/billing";
import type { Context } from "hono";

/**
 * The response body is deliberately thin.
 *
 * The provider reads the status code and nothing else, and the endpoint is unauthenticated -- so anything
 * richer would be a free oracle telling an unauthenticated caller whether a given event id had been
 * seen, or which school a customer maps to. `outcome` is safe because it describes what *this*
 * request did, and a caller who cannot forge a signature never gets one.
 */
const WebhookResponseSchema = z.object({
  received: z.literal(true),
  outcome: z.enum(["duplicate", "processed", "parked"]),
});

const stripeWebhookRoute = createRoute({
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

const tapWebhookRoute = createRoute({
  method: "post",
  // A literal for the same ST-065 gate reason as the Stripe route above.
  path: "/api/subscriptions/webhook/tap",
  tags: ["Subscriptions"],
  operationId: "receiveTapWebhook",
  summary: "Receive Tap Payments charge webhooks",
  description:
    "Ingests Tap charge status posts, normalizes them to the same billing events as Stripe, and " +
    "applies the resulting subscription state transitions. Authenticated by the hashstring " +
    "header (HMAC-SHA256 keyed with the Tap secret key); the charge is then re-read from Tap so " +
    "fields the hash does not cover are never trusted from the body. Deduplicated on charge id " +
    "and status, so a redelivery is a no-op. Unusable events are parked and still answer 200.",
  security: [],
  request: {},
  responses: standardResponses(
    { 200: { description: "Webhook accepted", schema: WebhookResponseSchema } },
    [400, 503],
  ),
});

/** The header each provider carries its signature in. */
const SIGNATURE_HEADERS: Readonly<Record<BillingProvider, string>> = {
  stripe: "stripe-signature",
  tap: "hashstring",
};

/**
 * The BullMQ job id for one event's retry chain.
 *
 * BullMQ rejects a custom id containing ':' unless it splits into exactly three parts ("Custom Id
 * cannot contain :"), so the separator is '-' and any ':' inside the event id -- every Tap id has
 * one -- is replaced too. The id only has to be stable per event; nothing parses it back.
 */
export function retryJobId(provider: BillingProvider, providerEventId: string): string {
  return `${provider}-${providerEventId.replaceAll(":", "-")}`;
}

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
  /** Settles one-time fee payments (ST-298). Wired by the app from the finance module. */
  settleFeePayment?: FeePaymentSettler;
}

export function webhookRoutes(
  database: Database,
  providers: PaymentProviderRegistry,
  logger: Logger,
  options: WebhookRoutesOptions = {},
): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: openApiValidationHook });

  // Constructed once per app rather than per request: a Queue holds a Redis connection, and one per
  // webhook delivery would exhaust the connection limit under ordinary provider traffic. Null when
  // Redis is absent, in which case a transient failure is still recorded on the billing_events row
  // (status 'failed') and picked up by the provider's own redelivery — degraded, not silent.
  const retryQueue = options.redis
    ? new Queue(QUEUE_NAMES.BILLING, { connection: options.redis as never })
    : null;

  const enqueueRetry: BillingEventRetryEnqueuer | undefined =
    options.enqueueRetry ??
    (retryQueue
      ? async ({ provider, providerEventId }) => {
          await retryQueue.add(
            JOB_NAMES.PROCESS_BILLING_EVENT,
            { version: 1, provider, providerEventId },
            // The job id makes re-enqueueing the same event idempotent: BullMQ refuses a duplicate,
            // so a burst of redeliveries that all fail produces one retry chain, not one per
            // delivery.
            { ...RETRY_JOB_OPTIONS, jobId: retryJobId(provider, providerEventId) },
          );
        }
      : undefined);

  // Declares the mutation for the ST-065 CI gate. The rows themselves are written by
  // webhooks/webhook-processor.ts from inside the transaction that changes the status, so a
  // transition and its audit record commit or roll back together.
  routes.use("/api/subscriptions/webhook/stripe", auditAction("update", "subscriptions"));
  routes.use("/api/subscriptions/webhook/tap", auditAction("update", "subscriptions"));

  const receive = async (c: Context<AppEnv>, providerName: BillingProvider) => {
    const { port } = requirePaymentProvider(providers, providerName);

    // arrayBuffer(), never text(): Stripe's signature covers the exact bytes it sent, and decoding
    // to a string and re-encoding is not guaranteed to reproduce them. Hono caches the parsed body,
    // so reading it here does not consume it for anyone downstream.
    const payload = Buffer.from(await c.req.arrayBuffer());

    const result = await handleBillingWebhook(
      {
        database,
        providerName,
        provider: port,
        logger,
        eventSink: options.eventSink,
        enqueueRetry,
        settleFeePayment: options.settleFeePayment,
      },
      payload,
      c.req.header(SIGNATURE_HEADERS[providerName]) ?? null,
      {
        path: c.req.path,
        clientIp: extractClientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
        requestId: c.get("requestId") ?? null,
      },
    );

    return c.json({ received: result.received, outcome: result.outcome } as const, 200);
  };

  routes.openapi(stripeWebhookRoute, (c) => receive(c, "stripe"));
  routes.openapi(tapWebhookRoute, (c) => receive(c, "tap"));

  return routes;
}
