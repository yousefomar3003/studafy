/**
 * Billing boundary telemetry: payment-provider webhook signature failures (ST-132).
 *
 * This is deliberately the ST-082 alerting path and not a second one. `emitRateLimitBlock` and
 * `emitTokenReuseDetected` in modules/auth/auth-anomaly-events.ts established the shape -- a
 * structured log line at ERROR level whose `event` field is the discriminator monitoring builds
 * counters on, plus a row through the async `SecurityEventSink` for queryable history -- and a
 * webhook arriving with a forged or absent signature is the same class of fact: unauthenticated,
 * pre-tenant, and interesting precisely because it arrived.
 *
 * Both halves are non-throwing and neither is awaited by the sink, which matters here: the request
 * has already been correctly refused, and telemetry about a rejection must never escalate into a
 * second failure.
 *
 * @see db/migrations/000079_add_stripe_webhook_security_event.sql
 */

import type { SecurityEventSink, SecurityEventType } from "../../lib/security/securityEventSink";
import type { Logger } from "../../logger";
import type { BillingProvider } from "@studafy/billing";

const SIGNATURE_FAILURE_EVENT_TYPES: Readonly<Record<BillingProvider, SecurityEventType>> = {
  stripe: "stripe_webhook_signature_invalid",
  tap: "tap_webhook_signature_invalid",
};

export interface WebhookSignatureFailureEvent {
  /** Whose signature failed -- a rotated Stripe secret and a rotated Tap key page different people. */
  provider: BillingProvider;
  /** The request path that was rejected. */
  path: string;
  /** Why verification failed, as far as we can say without trusting the body. */
  reason: "missing_signature" | "verification_failed";
  /** The client IP that sent it. */
  clientIp?: string | null;
  /** Request ID for log correlation. */
  requestId?: string | null;
  /** User-Agent header. */
  userAgent?: string | null;
}

/**
 * Record a rejected payment-provider webhook.
 *
 * Carries no part of the request body and no part of the signature header. A body that failed
 * signature verification is attacker-controlled content of unknown provenance, and the header is
 * the closest thing to a credential in the request -- neither belongs in a log line that will be
 * shipped to an aggregator. The IP and path are what an alert rule needs to tell "one source
 * probing the endpoint" from "our own signing secret has rotated out from under us", which are the
 * two things this signal is for.
 */
export function emitWebhookSignatureFailure(
  log: Logger | undefined,
  eventSink: SecurityEventSink | null | undefined,
  event: WebhookSignatureFailureEvent,
): void {
  const eventType = SIGNATURE_FAILURE_EVENT_TYPES[event.provider];

  log?.error(
    {
      event: eventType,
      path: event.path,
      reason: event.reason,
      client_ip: event.clientIp,
      request_id: event.requestId,
    },
    `${event.provider} webhook signature verification failed`,
  );

  eventSink?.record({
    eventType,
    path: event.path,
    method: "POST",
    clientIp: event.clientIp,
    userAgent: event.userAgent,
    requestId: event.requestId,
  });
}
