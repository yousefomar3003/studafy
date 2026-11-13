import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { activeTraceFields, createTracingMiddleware } from "./httpTracing";

import type { Tracer } from "@opentelemetry/api";

/**
 * The active-span propagation this middleware relies on (`context.with()` making a span visible to
 * everything `next()` awaits) only actually works with a real `ContextManager` registered —
 * `@opentelemetry/api`'s built-in default is a no-op whose `with()` never makes anything active. A
 * single `AsyncLocalStorageContextManager`, registered once for this whole file, is exactly what
 * `tracing.ts`'s `startTracing()` registers in production; it carries no per-test configuration
 * (unlike a `MeterProvider`'s exporter/reader), so — unlike `redMetrics.test.ts`'s explicit
 * avoidance of the global `MeterProvider` — sharing one across this file's tests is harmless.
 */
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
// Same reasoning, for the same reason: extracting/injecting a `traceparent` header needs a real
// propagator registered — the untouched default is a no-op that reads and writes nothing.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

/** A fully local TracerProvider per test, injected via `{ tracer }` — never the global one. */
function setUpTracer(): { tracer: Tracer; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  return { tracer: provider.getTracer("test"), exporter };
}

describe("createTracingMiddleware", () => {
  test("creates a SERVER span carrying the matched route, method and status", async () => {
    const { tracer, exporter } = setUpTracer();
    const app = new Hono();
    app.use("*", createTracingMiddleware({ tracer }));
    app.get("/students/:id", (c) => c.json({ id: c.req.param("id") }));

    const res = await app.request("/students/8f14e45f-ceea-467e-95f8-9c8d2b9c1f3a");
    expect(res.status).toBe(200);

    const [span] = exporter.getFinishedSpans();
    expect(span?.attributes["http.route"]).toBe("/students/:id");
    expect(span?.attributes["http.request.method"]).toBe("GET");
    expect(span?.attributes["http.response.status_code"]).toBe(200);
  });

  test("continues an inbound traceparent rather than starting a new trace", async () => {
    const { tracer, exporter } = setUpTracer();
    const app = new Hono();
    app.use("*", createTracingMiddleware({ tracer }));
    app.get("/ping", (c) => c.text("pong"));

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentSpanId = "00f067aa0ba902b7";
    await app.request("/ping", {
      headers: { traceparent: `00-${traceId}-${parentSpanId}-01` },
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  test("marks the span as an error for a 5xx response", async () => {
    const { tracer, exporter } = setUpTracer();
    const app = new Hono();
    app.use("*", createTracingMiddleware({ tracer }));
    app.get("/degraded", (c) => c.json({ error: "degraded" }, 503));

    await app.request("/degraded");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  // Hono's own `compose()` catches a thrown handler error at the dispatch frame closest to where
  // it was thrown, using whatever `onError` is registered (a default one always is, even without
  // an explicit `app.onError()`) — so `next()` inside this middleware never actually rejects for an
  // ordinary handler throw; it resolves with the error already converted to a response, which is
  // exactly the `status >= 500` branch the test above exercises. This middleware's own `catch`
  // block, like redMetricsMiddleware's, only ever runs if even the error handler itself throws —
  // reproduced here the same way.
  test("records the exception and marks the span as an error when the error handler itself throws", async () => {
    const { tracer, exporter } = setUpTracer();
    const app = new Hono();
    app.use("*", createTracingMiddleware({ tracer }));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.onError(() => {
      throw new Error("error handler itself failed");
    });

    await expect(app.request("/boom")).rejects.toThrow("error handler itself failed");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((event) => event.name === "exception")).toBe(true);
  });
});

describe("activeTraceFields", () => {
  test("returns {} outside any span", () => {
    expect(activeTraceFields()).toEqual({});
  });

  test("returns the active span's trace_id/span_id once a request is in flight", async () => {
    const { tracer } = setUpTracer();
    let seen: Record<string, unknown> = {};
    const app = new Hono();
    app.use("*", createTracingMiddleware({ tracer }));
    app.get("/whoami", (c) => {
      seen = activeTraceFields();
      return c.text("ok");
    });

    await app.request("/whoami");

    expect(typeof seen.trace_id).toBe("string");
    expect((seen.trace_id as string).length).toBe(32);
    expect(typeof seen.span_id).toBe("string");
  });
});
