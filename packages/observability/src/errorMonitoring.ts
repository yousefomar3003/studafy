import { context } from "@opentelemetry/api";
import * as Sentry from "@sentry/bun";
import { SentryContextManager } from "@sentry/node";

import { redactPii, scrubBreadcrumb, scrubEvent } from "./scrubPii";

/**
 * Sentry error monitoring for the backend services — the server-side counterpart of
 * `apps/web/src/lib/monitoring/sentry.ts`, and the one seam api/workers/realtime reach Sentry
 * through: nothing outside this package imports `@sentry/*` directly. Every export degrades to a
 * no-op until `initErrorMonitoring()` has been called with a DSN, so local dev, tests and the
 * OpenAPI generator (none of which set `SENTRY_DSN`) behave exactly as they did before this existed.
 *
 * ## Errors and log events only — tracing stays on OpenTelemetry
 *
 * Distributed tracing already has an owner: `startTracing()` (tracing.ts) ships every span to the
 * tail-sampling collector (ST-260). Sentry's Node/Bun SDK would, by default, register its *own*
 * global `TracerProvider`, propagator and context manager — whichever of the two ran second would
 * silently lose, and Sentry's `Bun.serve` wrapper marks a request's context as "tracing suppressed"
 * when Sentry tracing is off, which would blank out the collector's server span for every request.
 * So `skipOpenTelemetrySetup` is always on, no `tracesSampleRate` is configured, and the
 * span-creating integrations (`BunServer`, `Http`, `NodeFetch`) are left out. Events still carry the
 * active OTel trace id, so a Sentry issue links straight to its trace in Tempo.
 *
 * ## The one OTel global this does register
 *
 * Sentry keys its per-request scopes (breadcrumbs, the user, tags) off the active OTel context, and
 * only forks them under its own `SentryContextManager` — an `AsyncLocalStorage` context manager that
 * is otherwise a drop-in for the one `startTracing()` installs. It is registered here, so this must
 * run *before* `startTracing()`, which then keeps it rather than registering its own (see that
 * function's own note). Without it every request would share one global breadcrumb trail.
 */
export interface ErrorMonitoringOptions {
  /** `SENTRY_DSN`. `undefined` or `""` disables monitoring entirely. */
  dsn: string | undefined;
  /** Deploy tier events are grouped by (`SENTRY_ENVIRONMENT`, falling back per service). */
  environment: string;
  /** The deploy's immutable image tag (`RELEASE_VERSION`), matching the web build's release. */
  release: string;
  /** Tagged on every event, so one Sentry project can hold all three services. */
  serviceName: string;
}

export interface ErrorMonitoringHandle {
  /** Flushes queued events (bounded by `timeoutMs`) and disables the client. */
  shutdown: (timeoutMs?: number) => Promise<void>;
}

/**
 * Integrations dropped from `@sentry/bun`'s defaults. `Console` and `Http`/`NodeFetch` would turn
 * every console line and outbound URL into a breadcrumb (log lines are forwarded deliberately by
 * `forwardLog()` instead, and a URL can carry a token in its query string); `RequestData` would
 * attach headers and cookies; `BunServer` creates spans (see above); `ProcessSession` is release
 * health for long-lived clients, not request-serving processes.
 */
const EXCLUDED_INTEGRATIONS = new Set([
  "Console",
  "Http",
  "NodeFetch",
  "RequestData",
  "BunServer",
  "ProcessSession",
  // Replaced below rather than dropped.
  "OnUnhandledRejection",
]);

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;

let enabled = false;

/**
 * Errors already reported by an explicit `captureError()` (the API's error handler, the workers'
 * job wrapper). The same error is almost always logged right afterwards too, and `forwardLog()`
 * skips it here rather than reporting it a second time. A WeakSet, so a reported error is still
 * garbage-collected normally.
 */
const reportedErrors = new WeakSet<object>();

export function initErrorMonitoring(options: ErrorMonitoringOptions): ErrorMonitoringHandle | null {
  if (!options.dsn) return null;

  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    initialScope: { tags: { service: options.serviceName } },
    // Sentry's own PII collection (request headers/cookies, the client IP) stays off; the scrubbers
    // are the belt-and-braces layer over whatever this codebase attaches itself.
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    integrations: (defaults) => [
      ...defaults.filter((integration) => !EXCLUDED_INTEGRATIONS.has(integration.name)),
      // "strict": capture, then exit non-zero — the same crash-on-unhandled-rejection Bun does with
      // no listener installed. Sentry's default "warn" mode would keep a broken process serving.
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
      // Drops an event identical to the one just sent — a polling loop (the outbox relay, the email
      // dispatcher) logging the same failure every cycle while a dependency is down reports once,
      // not twice a second.
      Sentry.dedupeIntegration(),
    ],
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });

  context.setGlobalContextManager(new SentryContextManager().enable());
  enabled = true;

  return {
    shutdown: async (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) => {
      enabled = false;
      await Sentry.close(timeoutMs);
    },
  };
}

export function isErrorMonitoringEnabled(): boolean {
  return enabled;
}

type TagValue = string | number | boolean | null | undefined;

export interface CaptureContext {
  /** Low-cardinality ids only (request_id, school_id, route, queue, job_id) — never names. */
  tags?: Readonly<Record<string, TagValue>>;
  /** Set as the event's user, `{ id }` only. */
  userId?: string | null;
  /** Additional context. Scrubbed with the same rules as everything else on the event. */
  extra?: Readonly<Record<string, unknown>>;
  level?: "error" | "fatal";
}

function definedTags(tags: Readonly<Record<string, TagValue>> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
}

/**
 * Reports an error. A no-op when monitoring is disabled — callers keep their own logging for that
 * case rather than this module logging on their behalf, the same contract as the web seam.
 */
export function captureError(error: unknown, captureContext: CaptureContext = {}): void {
  if (!enabled) return;
  if (error !== null && typeof error === "object") reportedErrors.add(error);

  Sentry.captureException(error, {
    level: captureContext.level ?? "error",
    tags: definedTags(captureContext.tags),
    ...(captureContext.userId ? { user: { id: captureContext.userId } } : {}),
    ...(captureContext.extra ? { extra: { ...captureContext.extra } } : {}),
  });
}

/**
 * Runs `callback` in its own Sentry isolation scope, so breadcrumbs recorded while it runs belong
 * to that unit of work — one inbound request, one job — rather than to the whole process. Returns
 * whatever `callback` returns (including its promise) unchanged.
 */
export function withErrorMonitoringScope<T>(callback: () => T): T {
  if (!enabled) return callback();
  return Sentry.withIsolationScope(() => callback());
}

/**
 * Log fields promoted to event tags: the ids an on-call engineer filters by. Every other field is
 * attached as (scrubbed) extra data. `user_id` becomes the event's user instead.
 */
const TAG_FIELDS = new Set(["request_id", "school_id", "route", "queue", "job_id", "job_name"]);

const LEVELS: ReadonlyMap<string, "warn" | "error" | "fatal"> = new Map([
  ["warn", "warn"],
  ["error", "error"],
  ["fatal", "fatal"],
]);

function describeError(value: unknown): unknown {
  return value instanceof Error ? { type: value.name, message: value.message } : value;
}

/**
 * Log forwarding. stdout stays the system of record (docs/architecture/SAD_28_logging_conventions.md);
 * this only adds to it. Called by each service's logger after it has written its line:
 *
 * - `warn` becomes a breadcrumb on the current scope, so it rides along with whatever error that
 *   request or job goes on to report — never an event of its own.
 * - `error`/`fatal` becomes an event: `captureException` when an `err` Error is attached (unless
 *   `captureError()` already reported that exact error), otherwise a message event.
 * - Anything below `warn` is ignored.
 *
 * Never throws: a monitoring failure must not turn a log call into a second error.
 */
export function forwardLog(
  level: string,
  message: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  if (!enabled) return;
  const severity = LEVELS.get(level);
  if (severity === undefined) return;

  try {
    const { err, user_id: rawUserId, ...rest } = fields;
    const userId = typeof rawUserId === "string" ? rawUserId : null;
    const isTag = ([key, value]: [string, unknown]): boolean =>
      TAG_FIELDS.has(key) && (typeof value === "string" || typeof value === "number");
    const entries = Object.entries(rest);
    const tags = Object.fromEntries(entries.filter(isTag)) as Record<string, TagValue>;
    const extra = Object.fromEntries(entries.filter((entry) => !isTag(entry)));

    if (severity === "warn") {
      Sentry.addBreadcrumb({
        category: "log",
        level: "warning",
        message,
        data: redactPii({
          ...tags,
          ...extra,
          ...(err === undefined ? {} : { err: describeError(err) }),
        }),
      });
      return;
    }

    if (err instanceof Error) {
      if (reportedErrors.has(err)) return;
      captureError(err, {
        tags,
        userId,
        extra: { ...extra, log_message: message },
        level: severity,
      });
      return;
    }

    Sentry.captureMessage(message, {
      level: severity,
      tags: definedTags(tags),
      ...(userId ? { user: { id: userId } } : {}),
      extra: err === undefined ? extra : { ...extra, err },
    });
  } catch {
    // Deliberately swallowed — see the doc comment.
  }
}
