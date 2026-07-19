/**
 * Unit tests for the async batched security event sink.
 *
 * These are deliberately database-free. The sink's contract is about buffering, batching, bounding,
 * and never propagating failure — all of which are observable through a fake `postgres` tagged
 * template. The actual INSERT is exercised against a real database by the migration suite; testing
 * it here would only re-test the driver.
 */

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, it } from "bun:test";

import { createApp } from "../../src/app";
import {
  createNoopSecurityEventSink,
  createSecurityEventSink,
  type SecurityEvent,
  type SecurityEventSink,
} from "../../src/lib/security/securityEventSink";
import { createInflightTracker } from "../../src/lifecycle";
import { createLogger } from "../../src/logger";

import type { Database } from "../../src/db/client";
import type { Logger } from "../../src/logger";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeDatabase {
  db: Database;
  /** One entry per INSERT issued, holding the rows that INSERT carried. */
  batches: Record<string, unknown>[][];
  failWith: (error: Error | null) => void;
}

/**
 * A stand-in for the `postgres` client, which is callable two ways:
 *   - as a helper:          db(rows, ...columnNames)  -> an opaque fragment
 *   - as a tagged template: db`INSERT ... ${fragment}` -> a promise
 * A tagged template call is distinguishable because its first argument carries `.raw`.
 */
function createFakeDatabase(): FakeDatabase {
  const batches: Record<string, unknown>[][] = [];
  let error: Error | null = null;

  const fake = ((first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && "raw" in first) {
      const fragment = rest.find(
        (value): value is { rows: Record<string, unknown>[] } =>
          typeof value === "object" && value !== null && "rows" in value,
      );
      if (fragment) {
        batches.push(fragment.rows);
      }
      return error ? Promise.reject(error) : Promise.resolve([]);
    }
    return { rows: first as Record<string, unknown>[] };
  }) as unknown as Database;

  return {
    db: fake,
    batches,
    failWith: (next) => {
      error = next;
    },
  };
}

function createFakeLogger(): Logger & { warns: unknown[][]; errors: unknown[][] } {
  const warns: unknown[][] = [];
  const errors: unknown[][] = [];
  return {
    warn: (...args: unknown[]) => warns.push(args),
    error: (...args: unknown[]) => errors.push(args),
    info: () => undefined,
    debug: () => undefined,
    child: () => createFakeLogger(),
    warns,
    errors,
  } as unknown as Logger & { warns: unknown[][]; errors: unknown[][] };
}

const event = (overrides: Partial<SecurityEvent> = {}): SecurityEvent => ({
  eventType: "csrf_missing_token",
  path: "/api/students",
  method: "POST",
  clientIp: "203.0.113.5",
  userAgent: "probe/1.0",
  requestId: "3f8c1a4e-2b7d-4c9f-8a1e-5d6b7c8e9f01",
  ...overrides,
});

// A flush is scheduled with `void flush()`, so it settles on the microtask queue rather than
// synchronously. Yielding once lets it complete without depending on a wall-clock timer.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSecurityEventSink", () => {
  it("returns a no-op sink when no database is configured", async () => {
    const sink = createSecurityEventSink({ database: null });

    expect(() => sink.record(event())).not.toThrow();
    await sink.flush();
    expect(sink.droppedCount()).toBe(0);
  });

  it("buffers rather than writing on record()", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db, maxBatchSize: 100 });

    sink.record(event());
    await settle();

    // The whole point of the sink: nothing hit the database on the reject path.
    expect(fake.batches).toHaveLength(0);
    await sink.close();
  });

  it("writes buffered events as a single batched INSERT on flush", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db, maxBatchSize: 100 });

    sink.record(event());
    sink.record(event({ eventType: "cors_origin_rejected", origin: "https://evil.test" }));
    await sink.flush();

    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toHaveLength(2);
    await sink.close();
  });

  it("flushes early once the batch ceiling is reached", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db, maxBatchSize: 2 });

    sink.record(event());
    sink.record(event());
    await settle();

    expect(fake.batches).toHaveLength(1);
    expect(fake.batches[0]).toHaveLength(2);
    await sink.close();
  });

  it("maps the event onto the app.security_events column names", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    sink.record(event({ eventType: "cors_origin_rejected", origin: "https://evil.test" }));
    await sink.flush();

    expect(fake.batches[0]?.[0]).toEqual({
      event_type: "cors_origin_rejected",
      request_path: "/api/students",
      request_method: "POST",
      origin: "https://evil.test",
      client_ip: "203.0.113.5",
      user_agent: "probe/1.0",
      request_id: "3f8c1a4e-2b7d-4c9f-8a1e-5d6b7c8e9f01",
    });
    await sink.close();
  });

  it("normalises the method, which the column's check constraint requires uppercase", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    sink.record(event({ method: "post" }));
    await sink.flush();

    expect(fake.batches[0]?.[0]?.request_method).toBe("POST");
    await sink.close();
  });

  it("stores a non-UUID request id as NULL rather than failing the whole batch", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    sink.record(event({ requestId: "not-a-uuid" }));
    await sink.flush();

    // One malformed id must not cost the batch: uuid is a typed column, so a bad value would
    // otherwise abort the INSERT and discard every other event alongside it.
    expect(fake.batches[0]?.[0]?.request_id).toBeNull();
    await sink.close();
  });

  // extractClientIp() returns the literal "unknown" for a direct connection, and X-Forwarded-For is
  // caller-supplied, so the sink must never hand either straight to an inet column: a bad value
  // aborts the whole multi-row INSERT and discards every event batched alongside it.
  it.each([
    ["unknown", null],
    ["", null],
    ["not-an-ip", null],
    ["203.0.113.999", null],
    ["'; DROP TABLE app.security_events; --", null],
    ["203.0.113.5", "203.0.113.5"],
    ["2001:db8::1", "2001:db8::1"],
    ["::ffff:192.0.2.1", "::ffff:192.0.2.1"],
    // Colon-shaped but carrying no address.
    ["::", null],
    [":::", null],
    // Two zero-run elisions are ambiguous.
    ["2001::db8::1", null],
    // Group too long, and a non-hex digit.
    ["20011:db8::1", null],
    ["2001:zzzz::1", null],
    // A zone identifier and a prefix length are not single-host inet values.
    ["fe80::1%eth0", null],
    ["2001:db8::/32", null],
    // A dotted-quad tail is only meaningful in the final position.
    ["::192.0.2.1:1", null],
  ])("normalises client ip %p to %p", async (input, expected) => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    sink.record(event({ clientIp: input }));
    await sink.flush();

    expect(fake.batches[0]?.[0]?.client_ip).toBe(expected);
    await sink.close();
  });

  it("keeps the rest of a batch when one event has an unusable client ip", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    sink.record(event({ clientIp: "unknown" }));
    sink.record(event({ clientIp: "203.0.113.5" }));
    await sink.flush();

    expect(fake.batches[0]).toHaveLength(2);
    expect(fake.batches[0]?.[0]?.client_ip).toBeNull();
    expect(fake.batches[0]?.[1]?.client_ip).toBe("203.0.113.5");
    await sink.close();
  });

  it("drops and counts events past the queue ceiling instead of growing without bound", async () => {
    const fake = createFakeDatabase();
    // maxBatchSize above the ceiling so nothing auto-drains and the ceiling is what is measured.
    const sink = createSecurityEventSink({
      database: fake.db,
      maxQueueSize: 3,
      maxBatchSize: 1000,
    });

    for (let i = 0; i < 10; i += 1) {
      sink.record(event());
    }

    expect(sink.droppedCount()).toBe(7);

    await sink.flush();
    expect(fake.batches[0]).toHaveLength(3);
    await sink.close();
  });

  it("reports the drop count on the next flush, so a flood is never silent", async () => {
    const fake = createFakeDatabase();
    const logger = createFakeLogger();
    const sink = createSecurityEventSink({
      database: fake.db,
      logger,
      maxQueueSize: 1,
      maxBatchSize: 1000,
    });

    sink.record(event());
    sink.record(event());
    await sink.flush();

    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.[0]).toMatchObject({ dropped: 1, max_queue_size: 1 });
    await sink.close();
  });

  it("never propagates a database failure to the caller", async () => {
    const fake = createFakeDatabase();
    const logger = createFakeLogger();
    fake.failWith(new Error("connection refused"));

    const sink = createSecurityEventSink({ database: fake.db, logger });
    sink.record(event());

    // A rejection was already correctly refused upstream; telemetry about it must not become a
    // second failure.
    await expect(sink.flush()).resolves.toBeUndefined();
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.[1]).toBe("security event sink flush failed; events discarded");
    await sink.close();
  });

  it("discards a failed batch rather than requeueing it", async () => {
    const fake = createFakeDatabase();
    fake.failWith(new Error("connection refused"));

    const sink = createSecurityEventSink({ database: fake.db });
    sink.record(event());
    await sink.flush();

    fake.failWith(null);
    await sink.flush();

    // Only the failed attempt. A requeue would let a persistently failing database refill the
    // queue from its own retries and never drain.
    expect(fake.batches).toHaveLength(1);
    await sink.close();
  });

  it("drains on close and ignores records afterwards", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db, maxBatchSize: 1000 });

    sink.record(event());
    await sink.close();

    expect(fake.batches).toHaveLength(1);

    sink.record(event());
    await sink.flush();
    expect(fake.batches).toHaveLength(1);
  });

  it("is idempotent on repeated close", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    sink.record(event());
    await sink.close();
    await sink.close();

    expect(fake.batches).toHaveLength(1);
  });

  it("does not issue an INSERT when there is nothing buffered", async () => {
    const fake = createFakeDatabase();
    const sink = createSecurityEventSink({ database: fake.db });

    await sink.flush();

    expect(fake.batches).toHaveLength(0);
    await sink.close();
  });
});

describe("createNoopSecurityEventSink", () => {
  it("satisfies the interface without doing anything", async () => {
    const sink = createNoopSecurityEventSink();

    sink.record(event());
    await sink.flush();
    await sink.close();

    expect(sink.droppedCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Middleware wiring
//
// The sink being correct is worth nothing if the middleware never calls it, so these drive the
// real app and assert on what reached a recording sink.
// ---------------------------------------------------------------------------

function createRecordingSink(): SecurityEventSink & { events: SecurityEvent[] } {
  const events: SecurityEvent[] = [];
  return {
    events,
    record: (next) => events.push(next),
    flush: async () => undefined,
    close: async () => undefined,
    droppedCount: () => 0,
  };
}

function buildApp(sink: SecurityEventSink) {
  return createApp({
    isReady: () => true,
    tracker: createInflightTracker(),
    logger: createLogger({ destination: () => undefined }),
    securityEventSink: sink,
  });
}

describe("security event sink wiring", () => {
  it("records a CSRF rejection carrying no token", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    await app.request("/api/students", { method: "POST" });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      eventType: "csrf_missing_token",
      path: "/api/students",
      method: "POST",
    });
  });

  it("stamps the rejection with the tracing request id", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    const response = await app.request("/api/students", { method: "POST" });

    expect(sink.events[0]?.requestId).toBe(response.headers.get("X-Request-Id"));
  });

  it("distinguishes a mismatched token from an absent one", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    await app.request("/api/students", {
      method: "POST",
      headers: {
        Cookie: "XSRF-TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "X-XSRF-TOKEN": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    expect(sink.events[0]?.eventType).toBe("csrf_token_mismatch");
  });

  it("never records the token values, which would be a working forgery at rest", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    await app.request("/api/students", {
      method: "POST",
      headers: {
        Cookie: "XSRF-TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "X-XSRF-TOKEN": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    });

    expect(JSON.stringify(sink.events)).not.toContain("aaaaaaaaaaaa");
    expect(JSON.stringify(sink.events)).not.toContain("bbbbbbbbbbbb");
  });

  it("records a preflight probe from an unlisted origin, keeping the origin", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    await app.request("/api/students", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.test" },
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      eventType: "cors_origin_rejected",
      origin: "https://evil.test",
    });
  });

  it("records nothing for a request that passes the boundary", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    await app.request("/healthz");

    expect(sink.events).toHaveLength(0);
  });

  it("records nothing for a Bearer-authenticated mutation", async () => {
    const sink = createRecordingSink();
    const app = buildApp(sink);

    await app.request("/api/students", {
      method: "POST",
      headers: { Authorization: "Bearer some-token" },
    });

    expect(sink.events).toHaveLength(0);
  });
});
