import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createRedMetricsMiddleware } from "./redMetrics";

import type { Meter } from "@opentelemetry/api";
import type { HistogramMetricData, ResourceMetrics } from "@opentelemetry/sdk-metrics";

/**
 * A fully local MeterProvider per test — never `metrics.setGlobalMeterProvider()`, which is a
 * process-wide singleton that can only be set once. Two test files in this package both wanting a
 * fresh provider would otherwise race for it (whichever file's setup runs first wins, and every
 * other file's own reader silently never receives anything). Injecting `{ meter }` into
 * createRedMetricsMiddleware() sidesteps that global entirely, so every test here is independent
 * of every other test and of any other file in this package.
 */
function setUpMeter(): {
  meter: Meter;
  reader: PeriodicExportingMetricReader;
  exporter: InMemoryMetricExporter;
} {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  const provider = new MeterProvider({ readers: [reader] });
  return { meter: provider.getMeter("test"), reader, exporter };
}

async function findDurationDataPoints(
  reader: PeriodicExportingMetricReader,
  exporter: InMemoryMetricExporter,
): Promise<HistogramMetricData["dataPoints"]> {
  await reader.forceFlush();
  const resourceMetrics = (exporter.getMetrics() as ResourceMetrics[]).at(-1);
  const durationMetric = resourceMetrics?.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === "http.server.request.duration") as
    HistogramMetricData | undefined;
  return durationMetric?.dataPoints ?? [];
}

describe("createRedMetricsMiddleware", () => {
  test("labels a request by its matched route pattern, not the raw path", async () => {
    const { meter, reader, exporter } = setUpMeter();
    const app = new Hono();
    app.use("*", createRedMetricsMiddleware({ meter }));
    app.get("/students/:id", (c) => c.json({ id: c.req.param("id") }));

    const res = await app.request("/students/8f14e45f-ceea-467e-95f8-9c8d2b9c1f3a");
    expect(res.status).toBe(200);

    const points = await findDurationDataPoints(reader, exporter);
    expect(points).toHaveLength(1);
    expect(points[0]?.attributes["http.route"]).toBe("/students/:id");
    expect(points[0]?.attributes["http.request.method"]).toBe("GET");
    expect(points[0]?.attributes["http.response.status_code"]).toBe(200);
    expect(points[0]?.value.count).toBe(1);
  });

  test("two requests to the same dynamic route with different ids aggregate into one series", async () => {
    const { meter, reader, exporter } = setUpMeter();
    const app = new Hono();
    app.use("*", createRedMetricsMiddleware({ meter }));
    app.get("/teachers/:id", (c) => c.json({ id: c.req.param("id") }));

    await app.request("/teachers/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    await app.request("/teachers/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    // The whole point of the cardinality budget: two distinct ids under the same route pattern
    // must land in exactly one series, however many distinct values clients send. If routePath()
    // were ever swapped for the raw request path, this is what would catch it — one data point per
    // distinct raw path instead of one per registered route.
    const points = await findDurationDataPoints(reader, exporter);
    expect(points).toHaveLength(1);
    expect(points[0]?.value.count).toBe(2);
  });

  test("records the response status code, including errors thrown after this middleware", async () => {
    const { meter, reader, exporter } = setUpMeter();
    const app = new Hono();
    app.use("*", createRedMetricsMiddleware({ meter }));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.onError((_err, c) => c.json({ error: "internal" }, 500));

    const res = await app.request("/boom");
    expect(res.status).toBe(500);

    const points = await findDurationDataPoints(reader, exporter);
    expect(points[0]?.attributes["http.response.status_code"]).toBe(500);
    expect(points[0]?.attributes["http.route"]).toBe("/boom");
  });

  test("falls back to a bounded 'unmatched' route label for requests no handler matched", async () => {
    const { meter, reader, exporter } = setUpMeter();
    const app = new Hono();
    app.use("*", createRedMetricsMiddleware({ meter }));
    app.get("/known", (c) => c.text("ok"));

    const res = await app.request("/never-registered/at-all");
    expect(res.status).toBe(404);

    const points = await findDurationDataPoints(reader, exporter);
    expect(points[0]?.attributes["http.route"]).toBe("unmatched");
  });
});
