/**
 * Auth anomaly telemetry: rate-limit blocks and token-reuse events.
 *
 * These functions emit structured log entries and security events for the two primary
 * abuse signals in the auth subsystem. They are designed to be cheap, synchronous, and
 * non-throwing — the same contract the SecurityEventSink guarantees — so they never
 * slow down the rejection path they report on.
 *
 * Structured logs land at ERROR level with `event` as the discriminator. Aggregation
 * pipelines (Datadog log-based metrics, CloudWatch metric filters) build counters
 * on the `event` field. Security events are persisted to `app.security_events` via
 * the async sink for queryable history and alert rules.
 *
 * @see db/migrations/000030_add_auth_anomaly_event_types.sql
 */

import type { SecurityEventSink } from "../../lib/security/securityEventSink";
import type { Logger } from "../../logger";

// ---------------------------------------------------------------------------
// Rate-limit block
// ---------------------------------------------------------------------------

export interface RateLimitBlockEvent {
  /** The route class that was blocked (e.g. "auth-strict"). */
  routeClass: string;
  /** The request path that was throttled. */
  path: string;
  /** The client IP that hit the limit. */
  clientIp: string;
  /** Request ID for log correlation. */
  requestId?: string | null;
  /** User-Agent header. */
  userAgent?: string | null;
}

/**
 * Record a rate-limit block on an auth endpoint.
 *
 * Emits a structured log at ERROR level and an `auth_rate_limit_block` security event.
 * Both carry the IP and path — the two fields needed for alert rules that distinguish
 * "one IP hitting every endpoint" from "every IP hitting one endpoint".
 */
export function emitRateLimitBlock(
  log: Logger | undefined,
  eventSink: SecurityEventSink | null | undefined,
  event: RateLimitBlockEvent,
): void {
  log?.error(
    {
      event: "auth_rate_limit_block",
      route_class: event.routeClass,
      path: event.path,
      client_ip: event.clientIp,
      request_id: event.requestId,
    },
    "auth endpoint rate-limited",
  );

  eventSink?.record({
    eventType: "auth_rate_limit_block",
    path: event.path,
    method: "POST",
    clientIp: event.clientIp,
    userAgent: event.userAgent,
    requestId: event.requestId,
  });
}

// ---------------------------------------------------------------------------
// Token reuse detection
// ---------------------------------------------------------------------------

export interface TokenReuseEvent {
  /** The token family that was revoked. */
  familyId: string;
  /** The session ID of the reused token. */
  sessionId: string;
  /** The device that held the compromised token, if known. */
  deviceId: string | null;
  /** How many tokens in the family were revoked. */
  revokedTokenCount: number;
  /** Client IP from the reuse request, if available. */
  clientIp?: string | null;
  /** User-Agent from the reuse request. */
  userAgent?: string | null;
}

/**
 * Record a refresh-token reuse detection — the strongest signal of credential theft
 * in the session subsystem.
 *
 * Emits a structured log at ERROR level and an `auth_token_reuse_detected` security event.
 * The log carries no token material: only the family ID (which is a UUID, not a credential)
 * and the counts needed for triage.
 */
export function emitTokenReuseDetected(
  log: Logger | undefined,
  eventSink: SecurityEventSink | null | undefined,
  event: TokenReuseEvent,
): void {
  log?.error(
    {
      event: "auth_token_reuse_detected",
      family_id: event.familyId,
      session_id: event.sessionId,
      device_id: event.deviceId,
      revoked_token_count: event.revokedTokenCount,
      client_ip: event.clientIp,
    },
    "refresh token reuse detected — token family revoked",
  );

  eventSink?.record({
    eventType: "auth_token_reuse_detected",
    path: "/api/auth/refresh",
    method: "POST",
    clientIp: event.clientIp,
    userAgent: event.userAgent,
    requestId: null,
  });
}
