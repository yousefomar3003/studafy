/* eslint-disable import-x/no-unresolved -- "bun:test" is a virtual Bun built-in */
import { describe, expect, test, mock } from "bun:test";
/* eslint-enable import-x/no-unresolved */

import { resolveRouteClass, RATE_LIMIT_BUDGETS, ROUTE_CLASS_MAP } from "../../config/rateLimits";

import { emitRateLimitBlock, emitTokenReuseDetected } from "./auth-anomaly-events";

// ---------------------------------------------------------------------------
// Stub logger that captures calls
// ---------------------------------------------------------------------------

function createStubLogger() {
  const calls: { level: string; fields: unknown; msg: string }[] = [];
  const stub = {
    calls,
    trace: mock(() => undefined),
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock((fields: unknown, msg: string) => {
      calls.push({ level: "error", fields, msg });
    }),
    fatal: mock(() => undefined),
    child: () => stub,
    level: "info" as const,
  };
  return stub;
}

function createStubEventSink() {
  const events: unknown[] = [];
  return {
    events,
    record: mock((event: unknown) => {
      events.push(event);
    }),
    flush: mock(async () => undefined),
    close: mock(async () => undefined),
    droppedCount: () => 0,
  };
}

// ---------------------------------------------------------------------------
// Route-class classification
// ---------------------------------------------------------------------------

describe("ROUTE_CLASS_MAP registration", () => {
  test("refresh is auth-strict", () => {
    expect(ROUTE_CLASS_MAP["/api/auth/refresh"]).toBe("auth-strict");
  });

  test("logout is auth-strict", () => {
    expect(ROUTE_CLASS_MAP["/api/auth/logout"]).toBe("auth-strict");
  });

  test("sessions is auth", () => {
    expect(ROUTE_CLASS_MAP["/api/auth/sessions"]).toBe("auth");
  });

  test("sessions wildcard is auth", () => {
    expect(ROUTE_CLASS_MAP["/api/auth/sessions/*"]).toBe("auth");
  });

  test("devices wildcard is auth", () => {
    expect(ROUTE_CLASS_MAP["/api/auth/devices/*"]).toBe("auth");
  });

  test("invitations is auth", () => {
    expect(ROUTE_CLASS_MAP["/api/invitations"]).toBe("auth");
  });

  test("invitations wildcard is auth", () => {
    expect(ROUTE_CLASS_MAP["/api/invitations/*"]).toBe("auth");
  });
});

describe("resolveRouteClass", () => {
  test("resolves /api/auth/refresh to auth-strict", () => {
    expect(resolveRouteClass("/api/auth/refresh")).toBe("auth-strict");
  });

  test("resolves /api/auth/logout to auth-strict", () => {
    expect(resolveRouteClass("/api/auth/logout")).toBe("auth-strict");
  });

  test("resolves /api/auth/sessions to auth", () => {
    expect(resolveRouteClass("/api/auth/sessions")).toBe("auth");
  });

  test("resolves /api/auth/sessions/some-uuid to auth via wildcard", () => {
    expect(resolveRouteClass("/api/auth/sessions/550e8400-e29b-41d4-a716-446655440000")).toBe(
      "auth",
    );
  });

  test("resolves /api/auth/devices/some-uuid/sessions to auth via wildcard", () => {
    expect(
      resolveRouteClass("/api/auth/devices/550e8400-e29b-41d4-a716-446655440000/sessions"),
    ).toBe("auth");
  });

  test("resolves /api/invitations to auth", () => {
    expect(resolveRouteClass("/api/invitations")).toBe("auth");
  });

  test("resolves /api/invitations/some-uuid/revoke to auth via wildcard", () => {
    expect(resolveRouteClass("/api/invitations/550e8400-e29b-41d4-a716-446655440000/revoke")).toBe(
      "auth",
    );
  });

  test("unregistered path falls to default", () => {
    expect(resolveRouteClass("/api/unknown")).toBe("default");
  });
});

describe("auth-strict budget is tighter than auth", () => {
  test("auth-strict has fewer tokens than auth", () => {
    expect(RATE_LIMIT_BUDGETS["auth-strict"].maxTokens).toBeLessThan(
      RATE_LIMIT_BUDGETS.auth.maxTokens,
    );
  });

  test("auth-strict has slower refill than auth", () => {
    expect(RATE_LIMIT_BUDGETS["auth-strict"].refillRate).toBeLessThan(
      RATE_LIMIT_BUDGETS.auth.refillRate,
    );
  });
});

// ---------------------------------------------------------------------------
// Anomaly event emission
// ---------------------------------------------------------------------------

describe("emitRateLimitBlock", () => {
  test("logs at error level with correct event name", () => {
    const log = createStubLogger();
    const sink = createStubEventSink();

    emitRateLimitBlock(log as never, sink as never, {
      routeClass: "auth-strict",
      path: "/api/auth/refresh",
      clientIp: "10.0.0.1",
      requestId: "req-123",
      userAgent: "curl/7.0",
    });

    expect(log.calls).toHaveLength(1);
    expect(log.calls[0].level).toBe("error");
    expect(log.calls[0].msg).toBe("auth endpoint rate-limited");
    expect(log.calls[0].fields).toMatchObject({
      event: "auth_rate_limit_block",
      route_class: "auth-strict",
      path: "/api/auth/refresh",
      client_ip: "10.0.0.1",
    });
  });

  test("records security event via sink", () => {
    const log = createStubLogger();
    const sink = createStubEventSink();

    emitRateLimitBlock(log as never, sink as never, {
      routeClass: "auth",
      path: "/api/invitations",
      clientIp: "192.168.1.1",
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(sink.events[0]).toMatchObject({
      eventType: "auth_rate_limit_block",
      path: "/api/invitations",
      clientIp: "192.168.1.1",
    });
  });

  test("no-op when eventSink is null", () => {
    const log = createStubLogger();

    emitRateLimitBlock(log as never, null, {
      routeClass: "auth",
      path: "/api/auth/refresh",
      clientIp: "10.0.0.1",
    });

    expect(log.calls).toHaveLength(1);
  });
});

describe("emitTokenReuseDetected", () => {
  test("logs at error level with correct event name", () => {
    const log = createStubLogger();
    const sink = createStubEventSink();

    emitTokenReuseDetected(log as never, sink as never, {
      familyId: "fam-uuid",
      sessionId: "sess-uuid",
      deviceId: "dev-uuid",
      revokedTokenCount: 3,
      clientIp: "10.0.0.1",
      userAgent: "Mozilla/5.0",
    });

    expect(log.calls).toHaveLength(1);
    expect(log.calls[0].level).toBe("error");
    expect(log.calls[0].msg).toBe("refresh token reuse detected — token family revoked");
    expect(log.calls[0].fields).toMatchObject({
      event: "auth_token_reuse_detected",
      family_id: "fam-uuid",
      session_id: "sess-uuid",
      device_id: "dev-uuid",
      revoked_token_count: 3,
    });
  });

  test("records security event via sink", () => {
    const log = createStubLogger();
    const sink = createStubEventSink();

    emitTokenReuseDetected(log as never, sink as never, {
      familyId: "fam-uuid",
      sessionId: "sess-uuid",
      deviceId: null,
      revokedTokenCount: 1,
    });

    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(sink.events[0]).toMatchObject({
      eventType: "auth_token_reuse_detected",
      path: "/api/auth/refresh",
      method: "POST",
    });
  });

  test("handles null device gracefully", () => {
    const log = createStubLogger();
    const sink = createStubEventSink();

    emitTokenReuseDetected(log as never, sink as never, {
      familyId: "fam-uuid",
      sessionId: "sess-uuid",
      deviceId: null,
      revokedTokenCount: 2,
    });

    expect(log.calls[0].fields).toMatchObject({ device_id: null });
  });
});
