import { metrics } from "@opentelemetry/api";
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from "@opentelemetry/semantic-conventions";
import { routePath } from "hono/route";

import type { Meter } from "@opentelemetry/api";
import type { Context, MiddlewareHandler } from "hono";

const METER_NAME = "studafy.http";
/**
 * OTel HTTP semantic-conventions metric name. One histogram gives Rate (its count), Errors (its
 * count filtered to http.response.status_code >= 500) and Duration (its buckets) — RED from a
 * single instrument, exactly the shape ST-259 asks for, rather than three separately-drifting
 * counters.
 *
 * Exported so metricsServer.ts's bucket-boundary view can select this instrument by its real name
 * rather than by a second string literal that a rename here would silently orphan (a view whose
 * selector matches nothing does not fail — the instrument just keeps the SDK's default
 * boundaries). See metricsServer.ts's HISTOGRAM_VIEWS.
 */
export const HTTP_SERVER_REQUEST_DURATION = "http.server.request.duration";
const METRIC_NAME = HTTP_SERVER_REQUEST_DURATION;

/**
 * The matched route *pattern* (e.g. `/students/:id`), never the raw request path. This is the
 * cardinality budget enforced structurally rather than by convention: `hono/route`'s `routePath()`
 * only ever returns one of the finitely many patterns registered with `app.get/post/...`, however
 * many distinct student ids, school ids, or query strings real clients send — there is no code
 * path here that could smuggle a path segment or a query value into a label. Falls back to
 * `"unmatched"` for requests the router never dispatched to a handler (a bad method/path hitting
 * `notFoundHandler`), which is itself a single bounded value, not per-path.
 */
// routePath() resolves, for a genuinely unmatched request, to this middleware's own app.use("*",
// ...) wildcard registration ("*" or "/*" depending on how it was mounted) rather than an empty
// string — still a single bounded value, just not the friendly one a dashboard should show.
const UNMATCHED_ROUTE_PATTERNS = new Set(["", "*", "/*"]);

// Exported for httpTracing.ts's tracing middleware (ST-260): the trace span's `http.route`
// attribute must stay the exact same bounded value the RED metric's own label uses, or the two
// signals would disagree about which route a request belonged to. One function, two consumers.
export function resolveRoute(c: Context): string {
  const matched = routePath(c);
  return UNMATCHED_ROUTE_PATTERNS.has(matched) ? "unmatched" : matched;
}

export interface RedMetricsOptions {
  /**
   * Meter to record onto. Defaults to `metrics.getMeter(...)` against whatever global
   * `MeterProvider` is registered — production code should call `startMetricsServer()`
   * (metricsServer.ts) before this, so the default is a real, exported meter rather than the
   * `@opentelemetry/api` no-op fallback. Tests pass their own `MeterProvider.getMeter(...)`
   * instead of touching global state, which is what keeps two test files in this package from
   * fighting over `metrics.setGlobalMeterProvider` — a process-wide singleton that can only ever
   * be set once.
   */
  meter?: Meter;
}

/**
 * RED metrics middleware (ST-259): Rate/Errors/Duration per route, exported via the OTel HTTP
 * semantic-conventions histogram `http.server.request.duration`. Register this once, as early as
 * possible (outermost, so it wraps error handling and measures the full request including a
 * response `errorHandlerMiddleware` produced), in every Hono app that should be scraped.
 *
 * Labels are exactly `{ http.request.method, http.route, http.response.status_code }` — no user
 * id, school id, or any other unbounded value. See resolveRoute() for how the route label itself
 * is kept bounded, and docs/runbooks/metrics-dashboard-catalog.md for the resulting series count.
 */
export function createRedMetricsMiddleware(options: RedMetricsOptions = {}): MiddlewareHandler {
  const meter = options.meter ?? metrics.getMeter(METER_NAME);
  const durationHistogram = meter.createHistogram(METRIC_NAME, {
    description: "Duration of inbound HTTP requests, labeled by matched route.",
    unit: "s",
  });

  return async (c, next) => {
    const startedAt = performance.now();
    let statusCode = 500;

    try {
      await next();
      statusCode = c.res.status;
    } catch (err) {
      // errorHandlerMiddleware (registered inside this middleware's next()) already turns every
      // thrown error into a response, so reaching here means something above even that failed to
      // produce one — record it as a server error and let it keep propagating rather than
      // swallowing it, since this middleware's only job is measurement, not error handling.
      statusCode = 500;
      throw err;
    } finally {
      const durationSeconds = (performance.now() - startedAt) / 1000;
      durationHistogram.record(durationSeconds, {
        [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
        [ATTR_HTTP_ROUTE]: resolveRoute(c),
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
      });
    }
  };
}
