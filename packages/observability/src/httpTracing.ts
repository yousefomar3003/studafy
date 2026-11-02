import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from "@opentelemetry/semantic-conventions";

import { resolveRoute } from "./redMetrics";

import type { TextMapGetter, Tracer } from "@opentelemetry/api";
import type { MiddlewareHandler } from "hono";

const TRACER_NAME = "studafy.http";

/**
 * Reads W3C trace-context headers off a Fetch API `Headers` object. `@opentelemetry/api`'s default
 * getter assumes a plain object with bracket access, which `Request.headers` is not — Hono (and
 * Bun) hand middleware the real `Headers` class.
 */
const headersGetter: TextMapGetter<Headers> = {
  keys: (carrier) => [...carrier.keys()],
  get: (carrier, key) => carrier.get(key) ?? undefined,
};

export interface TracingMiddlewareOptions {
  /**
   * Tracer to create spans on. Defaults to `trace.getTracer(...)` against whatever global
   * `TracerProvider` `startTracing()` (tracing.ts) registered — production code should call that
   * before this, so the default is a real, exporting tracer rather than `@opentelemetry/api`'s
   * no-op fallback. Tests pass their own `TracerProvider.getTracer(...)` instead, the same seam
   * `createRedMetricsMiddleware`'s `meter` option uses for the same reason.
   */
  tracer?: Tracer;
}

/**
 * Distributed tracing middleware (ST-260): one SERVER span per inbound request. Register this
 * immediately after the inflight tracker and before `createRedMetricsMiddleware()`/
 * `requestIdMiddleware()` — `requestIdMiddleware` reads `activeTraceFields()` while building its
 * per-request logger, which only sees this span if it is already active by then.
 *
 * The span is extracted from any inbound `traceparent` (so a caller that is already mid-trace
 * continues it rather than starting a new one) and made active for the rest of the request's async
 * chain via `context.with()`. Everything `next()` runs — route handlers, `emit()`'s outbox insert,
 * `enqueueNotificationDispatch()`'s `queue.add()` — sees this span as its parent automatically:
 * nothing downstream has to thread a context value through by hand, because the `AsyncLocalStorage`
 * context manager `startTracing()` wires up follows the same await chain the request itself runs
 * on. This is what makes "one trace across API -> outbox -> dispatcher -> FCM" (ST-260's acceptance
 * criterion) hold without every layer in between taking an explicit tracing dependency.
 */
export function createTracingMiddleware(options: TracingMiddlewareOptions = {}): MiddlewareHandler {
  const tracer = options.tracer ?? trace.getTracer(TRACER_NAME);

  return async (c, next) => {
    const parentContext = propagation.extract(context.active(), c.req.raw.headers, headersGetter);
    const span = tracer.startSpan(`HTTP ${c.req.method}`, { kind: SpanKind.SERVER }, parentContext);

    await context.with(trace.setSpan(parentContext, span), async () => {
      try {
        await next();
        // errorHandlerMiddleware (registered inside next()) turns every thrown error into a
        // response, so a 5xx here is the normal way this middleware ever sees a failed request —
        // the catch block below is for the rarer case of something failing even that handler.
        if (c.res.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw err;
      } finally {
        span.setAttributes({
          [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
          [ATTR_HTTP_ROUTE]: resolveRoute(c),
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: c.res.status,
        });
        span.end();
      }
    });
  };
}

/**
 * The active span's `trace_id`/`span_id`, meant to be spread into a `log.child()`/log-call
 * bindings object — "trace links from logs" (ST-260): a CloudWatch Logs line carrying `trace_id`
 * lets a reader paste it straight into Grafana Tempo's search and land on the exact request or job.
 *
 * Returns `{}` outside any span (tracing disabled, or a code path with no active trace — a
 * cron-scheduled BullMQ job with no producer, a boot-time log line), so callers can unconditionally
 * spread the result into their bindings rather than branching on it.
 */
export function activeTraceFields(): { trace_id: string; span_id: string } | Record<string, never> {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};
  const spanContext = span.spanContext();
  if (!trace.isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
