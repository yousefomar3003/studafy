import { metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

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
  });

  metrics.setGlobalMeterProvider(meterProvider);

  return {
    shutdown: () => meterProvider.shutdown(),
  };
}
