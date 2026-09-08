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

import { injectTraceContext, withClientSpan, withConsumerSpan } from "./queueTracing";

import type { Tracer } from "@opentelemetry/api";

// See httpTracing.test.ts's own comment: `context.with()` only actually makes a span active with a
// real ContextManager registered, and one plain AsyncLocalStorageContextManager is safe to share
// across this whole file (and that one) since it carries no per-test configuration. Same for the
// propagator: injecting/extracting a `traceparent` needs a real one registered — the untouched
// default reads and writes nothing.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

function setUpTracer(): { tracer: Tracer; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  return { tracer: provider.getTracer("test"), exporter };
}

describe("injectTraceContext / withConsumerSpan", () => {
  test("a span created inside withClientSpan is a child of the enclosing span", async () => {
    const { tracer, exporter } = setUpTracer();

    await withClientSpan(
      "outer",
      {},
      () => withClientSpan("inner", {}, () => Promise.resolve(), tracer),
      tracer,
    );

    const spans = exporter.getFinishedSpans();
    const outer = spans.find((span) => span.name === "outer");
    const inner = spans.find((span) => span.name === "inner");
    expect(inner?.parentSpanContext?.spanId).toBe(outer?.spanContext().spanId);
    expect(inner?.spanContext().traceId).toBe(outer?.spanContext().traceId);
  });

  test("round-trips a trace across a simulated enqueue/consume boundary", async () => {
    const { tracer, exporter } = setUpTracer();

    // Simulates the API handler: a span is active, and the producer captures it into a carrier —
    // the same shape a BullMQ job's `traceContext` field carries across Redis.
    let carrier: Record<string, string> = {};
    await withClientSpan(
      "api.request",
      {},
      () => {
        carrier = injectTraceContext();
        return Promise.resolve();
      },
      tracer,
    );
    expect(carrier.traceparent).toBeDefined();

    // Simulates worker.ts's createBullmqWorker wrapping the dispatcher processor: a brand new call
    // stack, with no ambient active span, extracting the carrier from job.data.
    const producerSpan = exporter.getFinishedSpans().find((span) => span.name === "api.request");

    await withConsumerSpan(
      "notifications",
      "dispatch-notification",
      carrier,
      () => Promise.resolve(),
      tracer,
    );

    const consumerSpan = exporter
      .getFinishedSpans()
      .find((span) => span.name === "notifications process");
    expect(consumerSpan?.spanContext().traceId).toBe(producerSpan?.spanContext().traceId);
    expect(consumerSpan?.parentSpanContext?.spanId).toBe(producerSpan?.spanContext().spanId);
  });

  test("starts a fresh trace when no carrier is given, rather than throwing", async () => {
    const { tracer, exporter } = setUpTracer();

    await withConsumerSpan(
      "reports",
      "purge-expired-reports",
      undefined,
      () => Promise.resolve(),
      tracer,
    );

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("reports process");
    expect(span?.parentSpanContext).toBeUndefined();
  });

  test("withConsumerSpan marks the span as an error and rethrows when the processor throws", async () => {
    const { tracer, exporter } = setUpTracer();

    await expect(
      withConsumerSpan(
        "notifications",
        "dispatch-notification",
        undefined,
        () => Promise.reject(new Error("dispatch failed")),
        tracer,
      ),
    ).rejects.toThrow("dispatch failed");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span?.events.some((event) => event.name === "exception")).toBe(true);
  });

  test("withClientSpan marks the span as an error and rethrows when the call fails", async () => {
    const { tracer, exporter } = setUpTracer();

    await expect(
      withClientSpan("fcm.send", {}, () => Promise.reject(new Error("quota exceeded")), tracer),
    ).rejects.toThrow("quota exceeded");

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR
  });
});
