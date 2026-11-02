import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { ATTR_MESSAGING_DESTINATION_NAME } from "@opentelemetry/semantic-conventions/incubating";

import type { Attributes, Tracer } from "@opentelemetry/api";

const TRACER_NAME = "studafy.queue";

/**
 * The shape a BullMQ job payload carries its trace context in — a plain string-keyed record, never
 * a class instance, because it travels through BullMQ's own `JSON.stringify` on the way into Redis.
 * Store it under a `traceContext` field on the job payload (see `enqueue-dispatch.ts` and
 * `registry.ts`'s `enqueueDelivery` for the two producer call sites).
 */
export type TraceContextCarrier = Record<string, string>;

/**
 * Captures the currently active span's context as a plain object a BullMQ job payload can carry
 * (`{ traceContext: injectTraceContext() }`). Call this at every `queue.add()` call site that
 * should continue the caller's trace.
 *
 * Returns `{}` with no active span — tracing disabled, or a scheduler enqueuing with nothing in
 * flight to continue (the daily digest sweep, for instance). Merging `{}` into a job payload is a
 * no-op, so call sites can spread this in unconditionally rather than branching on whether tracing
 * is on.
 */
export function injectTraceContext(): TraceContextCarrier {
  const carrier: TraceContextCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Runs `fn` inside a CONSUMER span that continues whatever trace `carrier` — a job's own
 * `traceContext` field, written by `injectTraceContext()` at enqueue time — belongs to. With no
 * carrier (a job enqueued before this shipped, or a scheduler with nothing to propagate) this
 * simply starts a new trace rooted at this span, which is the honest behavior for a job that really
 * did start here rather than being handed down from a caller.
 *
 * `worker.ts`'s `createBullmqWorker` calls this once, wrapping every processor in the registry —
 * the same "one shared wrapper instruments the whole registry" shape it already uses for
 * `recordJobOutcome()`, rather than every processor file remembering to instrument itself. This is
 * what makes the dispatcher and delivery jobs (ST-260's "...-> dispatcher -> FCM") continue the
 * request that enqueued them without either processor file importing this function directly.
 */
export async function withConsumerSpan<T>(
  queueName: string,
  jobName: string,
  carrier: TraceContextCarrier | undefined,
  fn: () => Promise<T>,
  tracer: Tracer = trace.getTracer(TRACER_NAME),
): Promise<T> {
  const parentContext = propagation.extract(context.active(), carrier ?? {});
  const span = tracer.startSpan(
    `${queueName} process`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
        "messaging.bullmq.job.name": jobName,
      },
    },
    parentContext,
  );

  return context.with(trace.setSpan(parentContext, span), async () => {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Runs `fn` inside a CLIENT span for an outbound call to a system this codebase doesn't otherwise
 * instrument — the outbox insert (`emit()`) and the FCM send (`delivery.worker.ts`'s push channel,
 * ST-260's "...-> FCM" acceptance criterion) both use this. A thin, generic wrapper rather than a
 * per-integration one: naming and attributes are the caller's business, span lifecycle and error
 * status are the only parts worth sharing.
 */
export async function withClientSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
  tracer: Tracer = trace.getTracer(TRACER_NAME),
): Promise<T> {
  const span = tracer.startSpan(name, { kind: SpanKind.CLIENT, attributes });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw err;
    } finally {
      span.end();
    }
  });
}
