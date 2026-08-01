/**
 * Async batched sink for boundary rejections (CSRF failures, foreign-origin probes).
 *
 * ST-067 requires the middleware chain to stay under 0.5 ms per request and to perform zero
 * database I/O on the reject path. Both constraints rule out an inline INSERT, and the second one
 * is not merely about latency: the reject path is reachable by any unauthenticated caller, so a
 * synchronous write would hand an attacker a cheap way to generate database load. Two properties
 * follow from that, and they are the whole design:
 *
 *   1. record() NEVER awaits, and never throws. It appends to an in-memory buffer and returns.
 *      A failing or slow database cannot slow down, or fail, a rejection.
 *   2. The buffer is BOUNDED. Past maxQueueSize, events are dropped and counted rather than
 *      accumulated, so a flood is capped at a fixed memory cost instead of becoming an OOM vector.
 *      The drop count is surfaced on the next flush, so silence is never mistaken for calm.
 *
 * Rows land in app.security_events, not app.audit_logs -- see the migration
 * (db/migrations/000028_create_security_events_table.sql) for why the audit table structurally
 * cannot hold an unauthenticated event.
 */

import type { Database } from "../../db/client";
import type { Logger } from "../../logger";

/** Mirrors the app.security_event_type PostgreSQL enum. */
export type SecurityEventType =
  | "csrf_missing_token"
  | "csrf_token_mismatch"
  | "cors_origin_rejected"
  | "auth_rate_limit_block"
  | "auth_token_reuse_detected"
  | "stripe_webhook_signature_invalid";

/** One boundary rejection, as the middleware observed it. */
export interface SecurityEvent {
  eventType: SecurityEventType;
  path: string;
  method: string;
  origin?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface SecurityEventSink {
  /** Enqueue an event. Synchronous, non-throwing, and cheap by contract. */
  record(event: SecurityEvent): void;
  /** Write everything buffered. Used by shutdown and by tests; the timer calls it too. */
  flush(): Promise<void>;
  /** Stop the timer and drain. Idempotent. */
  close(): Promise<void>;
  /** Events discarded because the queue was full, since process start. */
  droppedCount(): number;
}

export interface SecurityEventSinkOptions {
  database: Database | null;
  logger?: Logger | null;
  /** How often the buffer drains. */
  flushIntervalMs?: number;
  /** Drain early once this many events are buffered. */
  maxBatchSize?: number;
  /** Hard ceiling on buffered events; beyond it, new events are dropped and counted. */
  maxQueueSize?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_QUEUE_SIZE = 1_000;

/** A UUID this sink is willing to send to a uuid column. Anything else is stored as NULL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Anchored and bounded on every quantifier, so it cannot backtrack pathologically. */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Longest possible textual IPv6, the IPv4-mapped form with every group written out. */
const MAX_IPV6_LENGTH = 45;

function isIpv4(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

function isHexDigit(char: string): boolean {
  return (
    (char >= "0" && char <= "9") || (char >= "a" && char <= "f") || (char >= "A" && char <= "F")
  );
}

/**
 * Validate an IPv6 literal by a single linear scan rather than a regular expression.
 *
 * A regex here would mix a `[0-9a-f:]+` class with an optional group beginning in `:`, whose overlap
 * is exactly the shape that backtracks badly — and this runs on caller-supplied X-Forwarded-For
 * content, so that would be a denial-of-service surface on the security path itself. Scanning is
 * linear by construction and needs no such argument.
 *
 * Zone identifiers (`%eth0`) and prefix lengths (`/64`) are rejected: neither belongs in a
 * single-host `inet` value here, and both would be stored as NULL rather than risk the batch.
 */
function isIpv6(value: string): boolean {
  if (value.length > MAX_IPV6_LENGTH || !value.includes(":")) {
    return false;
  }

  // "::" is the zero-run elision and may appear at most once; more than one is ambiguous.
  const firstRun = value.indexOf("::");
  if (firstRun !== -1 && value.indexOf("::", firstRun + 1) !== -1) {
    return false;
  }

  const groups = value.split(":");
  if (groups.length > 8) {
    return false;
  }

  let sawGroup = false;

  for (const [i, group] of groups.entries()) {
    // Empty groups come from "::" or a leading/trailing colon, and carry no digits to check.
    if (group === "") {
      continue;
    }

    // A dotted-quad tail is the IPv4-mapped form, and is only meaningful in the final position.
    if (group.includes(".")) {
      if (i !== groups.length - 1 || !isIpv4(group)) {
        return false;
      }
      sawGroup = true;
      continue;
    }

    if (group.length > 4) {
      return false;
    }
    for (const char of group) {
      if (!isHexDigit(char)) {
        return false;
      }
    }
    sawGroup = true;
  }

  // Rejects "::" and ":::" — syntactically colon-shaped but carrying no address.
  return sawGroup;
}

/**
 * Coerce a client IP into something `inet` will accept, or NULL.
 *
 * This guard is load-bearing rather than defensive padding. extractClientIp() returns the literal
 * string "unknown" when neither X-Forwarded-For nor X-Real-IP is present — the ordinary case for a
 * direct connection — and X-Forwarded-For is caller-supplied, so its contents are arbitrary. Either
 * value reaching an inet column raises "invalid input syntax for type inet", which aborts the whole
 * multi-row INSERT and discards every other event batched with it. One unroutable request must not
 * cost the batch.
 */
function toInetOrNull(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return isIpv4(value) || isIpv6(value) ? value : null;
}

/**
 * A sink that discards everything. Returned when no database is configured, so callers never
 * branch on nullability at the call site.
 */
export function createNoopSecurityEventSink(): SecurityEventSink {
  return {
    record: () => undefined,
    flush: async () => undefined,
    close: async () => undefined,
    droppedCount: () => 0,
  };
}

export function createSecurityEventSink(options: SecurityEventSinkOptions): SecurityEventSink {
  const { database, logger } = options;

  if (!database) {
    return createNoopSecurityEventSink();
  }

  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

  let queue: SecurityEvent[] = [];
  let dropped = 0;
  let closed = false;
  // Serialises flushes. Without it, a timer tick landing mid-flush would issue a second concurrent
  // INSERT and claim a second pooled connection for the same work.
  let inFlight: Promise<void> = Promise.resolve();

  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // Never hold the process open for telemetry.
  timer.unref?.();

  async function writeBatch(batch: SecurityEvent[]): Promise<void> {
    const rows = batch.map((event) => ({
      event_type: event.eventType,
      request_path: event.path,
      request_method: event.method.toUpperCase(),
      origin: event.origin ?? null,
      client_ip: toInetOrNull(event.clientIp),
      user_agent: event.userAgent ?? null,
      request_id: event.requestId && UUID_PATTERN.test(event.requestId) ? event.requestId : null,
    }));

    // One multi-row INSERT per batch rather than one per event: the batch is the point.
    await database!`
      INSERT INTO app.security_events ${database!(
        rows,
        "event_type",
        "request_path",
        "request_method",
        "origin",
        "client_ip",
        "user_agent",
        "request_id",
      )}
    `;
  }

  async function flush(): Promise<void> {
    const run = inFlight.then(async () => {
      if (queue.length === 0) {
        return;
      }

      const batch = queue;
      queue = [];

      const droppedThisCycle = dropped;
      dropped = 0;

      if (droppedThisCycle > 0) {
        logger?.warn(
          { dropped: droppedThisCycle, max_queue_size: maxQueueSize },
          "security event sink dropped events: queue ceiling reached",
        );
      }

      try {
        await writeBatch(batch);
      } catch (error) {
        // Swallowed on purpose, and loudly. Telemetry about a rejection must never escalate into
        // a second failure -- the request was already correctly refused, and the structured log
        // written by the middleware remains the primary record. The batch is deliberately NOT
        // requeued: a persistently failing database would otherwise let the queue refill from its
        // own retries and never drain.
        logger?.error(
          { err: error, batch_size: batch.length },
          "security event sink flush failed; events discarded",
        );
      }
    });

    inFlight = run.catch(() => undefined);
    return run;
  }

  return {
    record(event: SecurityEvent): void {
      if (closed) {
        return;
      }

      if (queue.length >= maxQueueSize) {
        dropped += 1;
        return;
      }

      queue.push(event);

      if (queue.length >= maxBatchSize) {
        void flush();
      }
    },

    flush,

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      await flush();
    },

    droppedCount: () => dropped,
  };
}
