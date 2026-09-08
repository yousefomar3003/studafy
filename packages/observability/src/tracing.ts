import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AlwaysOnSampler, BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Starts distributed tracing (ST-260): every span this process creates is exported over OTLP/HTTP
 * to the tail-sampling collector (`infra/terraform/modules/monitoring/tracing.tf`) — this SDK never
 * makes a sampling decision itself.
 *
 * ## Why sampling happens at the collector, not here
 *
 * The acceptance criterion is "sampled at 10%, always-on for errors". A *head* sampler — the kind
 * `ParentBasedSampler(TraceIdRatioBasedSampler(0.1))` gives you — decides before the request has
 * run, so it can never know the request is about to fail: "always capture errors" and "decide at
 * the start" are mutually exclusive. So this process samples nothing (`AlwaysOnSampler`) and ships
 * every span it creates to the collector; the collector buffers each trace for a few seconds and
 * only then applies `tailsamplingprocessor`'s `errors` OR `probabilistic 10%` policies — the one
 * place in the pipeline that has actually seen how the trace ended. See that module's own
 * `otel-collector-config.yaml` for the policy definitions.
 *
 * This does mean every span this process creates crosses the network, all the time. That is the
 * standard trade tail sampling makes (see the OpenTelemetry Collector's own `tailsamplingprocessor`
 * docs), and it is why spans are hand-created only at the two boundaries that matter (an inbound
 * HTTP request, a BullMQ job) rather than on every internal function call.
 *
 * ## Why `@opentelemetry/sdk-trace`, not `-node` or an auto-instrumentation bundle
 *
 * Same reasoning `metricsServer.ts` already documents for `@opentelemetry/sdk-metrics`: this runs
 * on Bun, and the standard auto-instrumentation packages (`@opentelemetry/instrumentation-http`,
 * `-pg`, `-ioredis`, …) patch Node's own `http`/`pg`/`ioredis` modules — which is not how `Bun.serve`
 * or the `postgres` package this repo actually uses work underneath. Pulling those packages in
 * would be dead weight that silently instruments nothing. Spans are created by hand instead, at the
 * inbound HTTP request (`httpTracing.ts`) and the BullMQ job boundary (`queueTracing.ts`) — the same
 * "measure the boundary this repo's own runtime actually has" choice `redMetrics.ts`/
 * `queueMetrics.ts` already made for metrics.
 *
 * Call once, at process bootstrap, before any code calls `trace.getTracer()` — `@opentelemetry/
 * api`'s `trace.getTracer()` returns a no-op tracer until a global `TracerProvider` is registered,
 * exactly like `startMetricsServer()`'s own ordering requirement for the global `MeterProvider`.
 */
export interface TracingOptions {
  /** Resource `service.name` every span this process emits is tagged with. */
  serviceName: string;
  /**
   * Base URL of the OTel collector's OTLP/HTTP receiver, e.g.
   * `http://otel-collector.metrics.internal:4318`. `undefined` disables tracing entirely — dev,
   * test and the OpenAPI generator all run with no collector reachable, the same nullable-producer
   * shape `redis`/`storage`/`stripeProvider` already use in apps/api/src/index.ts.
   */
  otlpEndpoint?: string;
}

export interface TracingHandle {
  /** Flushes buffered spans and stops the exporter. Called during graceful shutdown. */
  shutdown: () => Promise<void>;
}

export function startTracing(options: TracingOptions): TracingHandle | null {
  if (options.otlpEndpoint === undefined) return null;

  const exporter = new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` });

  const provider = new TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });

  // This package's `TracerProvider` has no `.register()` convenience (unlike the older
  // `NodeTracerProvider`), so the three globals `@opentelemetry/api` needs are wired by hand:
  // the context manager (so an active span survives an `await`), the tracer provider itself, and
  // the propagator (so a `traceparent` header round-trips through `httpTracing.ts`/
  // `queueTracing.ts`). `AsyncLocalStorageContextManager` over `AsyncHooksContextManager`: it is
  // the propagation package's own modern default and Bun implements `AsyncLocalStorage` natively.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );

  return { shutdown: () => provider.shutdown() };
}
