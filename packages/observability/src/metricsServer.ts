import { metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, MeterProvider } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { BULLMQ_JOB_DURATION } from "./queueMetrics";
import { HTTP_SERVER_REQUEST_DURATION } from "./redMetrics";

import type { ViewOptions } from "@opentelemetry/sdk-metrics";

/**
 * Explicit histogram bucket boundaries, in **seconds**, for the two duration histograms this
 * package defines.
 *
 * Without these the SDK applies its own default boundaries — `[0, 5, 10, 25, 50, 75, 100, 250,
 * 500, 750, 1000, 2500, 5000, 7500, 10000]` — which are chosen for *milliseconds*. Both histograms
 * record seconds (`unit: "s"`, the OTel semantic convention `http.server.request.duration`
 * mandates), so under the defaults every request faster than five seconds lands in the single
 * `le="5"` bucket: `histogram_quantile` over that has exactly one boundary to interpolate between
 * and reports garbage, and a latency SLO threshold anywhere under 5s cannot be expressed at all.
 * That is what these views fix, and it is why ST-262's latency burn-rate rule can name a real
 * objective (`le="0.5"`) rather than the nearest default boundary.
 *
 * The two sets differ because the two populations do:
 *
 * - **HTTP** uses the classic Prometheus client default ladder (5ms → 10s). `0.5` and `1` are
 *   real boundaries because they are the objectives `infra/docker/prometheus/rules/slo.yml`
 *   actually alerts on — a burn-rate rule can only measure a latency objective that is a bucket
 *   edge.
 * - **BullMQ jobs** run from a sub-second outbox relay to a multi-minute report render or LLM
 *   call, so the ladder extends to 10 minutes. Sharing the HTTP ladder would put most of the job
 *   fleet in the `+Inf` bucket, which is the same failure in the other direction.
 *
 * Changing a boundary is not free: Prometheus sees it as a new set of `le` series, so quantiles
 * spanning the change are interpolated across two different ladders until the old series age out
 * of `prometheus_retention`. Change them deliberately, not casually.
 */
const HISTOGRAM_VIEWS: ViewOptions[] = [
  {
    instrumentName: HTTP_SERVER_REQUEST_DURATION,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10] },
    },
  },
  {
    instrumentName: BULLMQ_JOB_DURATION,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600] },
    },
  },
];

/**
 * Starts a process-wide Prometheus-compatible metrics endpoint (ST-259).
 *
 * Deliberately a separate HTTP server on its own port (`PrometheusExporter`'s built-in listener),
 * not a route mounted on the service's own Hono app: the ALB only ever forwards `/healthz`,
 * `/readyz` and business routes to the public target groups (modules/compute's own listener
 * rules), so a `/metrics` route there would need its own auth story to keep it off the public
 * internet. A dedicated port that only Prometheus's security group can reach needs none — see
 * infra/terraform/modules/monitoring/README.md.
 *
 * Call this once, at process bootstrap, before any code calls `getMeter()`/`createRedMetrics
 * Middleware()` in this package: `@opentelemetry/api`'s `metrics.getMeter()` returns a no-op
 * meter until a global `MeterProvider` is registered, and every instrument created against that
 * no-op meter stays a no-op forever, even after a real provider is registered later (an
 * `Instrument` is bound to the `Meter` that created it). apps/api, apps/realtime and apps/workers
 * all call this before constructing their app/registering workers for exactly this reason.
 */
export interface MetricsServerOptions {
  /** Resource `service.name` every metric this process emits is tagged with. */
  serviceName: string;
  /** Port the Prometheus exporter's HTTP server listens on. */
  port: number;
  /** Bind address. Defaults to all interfaces — the metrics security group is the actual boundary. */
  host?: string;
}

export interface MetricsServerHandle {
  /** Stops the Prometheus HTTP server and flushes pending data. Called during graceful shutdown. */
  shutdown: () => Promise<void>;
}

export function startMetricsServer(options: MetricsServerOptions): MetricsServerHandle {
  const exporter = new PrometheusExporter({ port: options.port, host: options.host });

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    readers: [exporter],
    views: HISTOGRAM_VIEWS,
  });

  metrics.setGlobalMeterProvider(meterProvider);

  return {
    shutdown: () => meterProvider.shutdown(),
  };
}
