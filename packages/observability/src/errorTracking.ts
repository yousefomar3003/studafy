import * as Sentry from "@sentry/bun";

import type { ErrorEvent } from "@sentry/bun";

/**
 * Error tracking for the server processes (api, workers), reported to Sentry.
 *
 * Errors only: no performance tracing, logs or profiling -- tracing stays with OpenTelemetry
 * (`startTracing`), and Sentry does not register a tracer provider of its own (the Bun SDK's
 * `enableOpenTelemetrySetup` defaults to false), so the two never compete.
 *
 * Off unless a DSN is configured; every function here is a no-op until `startErrorTracking` has
 * succeeded, so callers never need to check.
 *
 * Privacy: no request bodies, headers, cookies or query strings, and no user beyond an opaque id.
 * Studafy serves school children; anything a person typed must not leave for a third party.
 */

export interface ErrorTrackingOptions {
  /** Sentry DSN. Absent or empty: error tracking stays off. */
  dsn?: string;
  /** Deployment tier, e.g. `production`, `staging`, `development`. */
  environment: string;
  /** Release identifier, e.g. the image tag. */
  release?: string;
  /** `api`, `workers` -- tagged on every event so one project can hold both. */
  serviceName: string;
}

let started = false;

export function startErrorTracking(options: ErrorTrackingOptions): boolean {
  if (!options.dsn || started) return started;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    // Collect nothing a person entered or sent: the event is the error and its stack, no more.
    // `stackFrameVariables` matters most -- local variables at the crash point often hold a request's
    // content. beforeSend (scrubEvent) still strips request data as a second layer.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    // Errors only (see the module comment).
    tracesSampleRate: 0,
    initialScope: { tags: { service: options.serviceName } },
    beforeSend: scrubEvent,
  });
  started = true;
  return true;
}

/**
 * Report one error with optional context tags (a request id, a queue name). Only ids and names
 * belong in `tags` -- never values a person entered.
 */
export function captureError(
  error: unknown,
  tags: Record<string, string | number | undefined> = {},
): void {
  if (!started) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) {
      if (value !== undefined) scope.setTag(key, String(value));
    }
    Sentry.captureException(error);
  });
}

/** Send whatever is still queued; call during graceful shutdown. */
export async function flushErrorTracking(timeoutMs = 2_000): Promise<void> {
  if (!started) return;
  await Sentry.flush(timeoutMs);
}

/**
 * Strip anything a person typed or sent before an event leaves the process. Exported for tests.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }
  if (event.user) {
    event.user = event.user.id === undefined ? undefined : { id: event.user.id };
  }
  return event;
}
