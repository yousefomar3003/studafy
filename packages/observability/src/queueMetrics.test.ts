import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeAll, describe, expect, test } from "bun:test";

import { recordDeadLetter, recordJobOutcome } from "./queueMetrics";

import type { MetricData, ResourceMetrics } from "@opentelemetry/sdk-metrics";

// recordJobOutcome and recordDeadLetter are the pure/local pieces of this module —
// startQueueGauges constructs a real BullMQ `Queue`, which opens a Redis connection (see
// apps/workers/src/registry.ts's own comment on the same tradeoff), so it is exercised by
// apps/workers' own integration coverage instead, not here.
//
// `@opentelemetry/api`'s global MeterProvider can only be set once per process, so — same as
// redMetrics.test.ts — this file sets it up once in beforeAll and gives every test its own queue
// name, since cumulative counters are additive per distinct attribute set.
let exporter: InMemoryMetricExporter;
let reader: PeriodicExportingMetricReader;

beforeAll(() => {
  exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});

async function collectMetric(name: string): Promise<MetricData | undefined> {
  await reader.forceFlush();
  // See redMetrics.test.ts's identical comment: InMemoryMetricExporter.getMetrics() accumulates
  // one entry per export call, so the current cumulative state is always the last entry.
  const resourceMetrics = (exporter.getMetrics() as ResourceMetrics[]).at(-1);
  return resourceMetrics?.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === name);
}

describe("recordJobOutcome", () => {
  test("labels by queue name and outcome, never by job id", async () => {
    recordJobOutcome("notifications", "completed", 1_000, 1_250);

    const outcomes = await collectMetric("bullmq.job.outcomes");
    const point = outcomes?.dataPoints.find(
      (dp) => dp.attributes["messaging.destination.name"] === "notifications",
    );
    expect(point?.attributes.outcome).toBe("completed");
    expect(point?.value).toBe(1);
  });

  test("records processing duration in seconds from processedOn/finishedOn", async () => {
    recordJobOutcome("reports", "completed", 10_000, 12_500);

    const duration = await collectMetric("bullmq.job.duration");
    const point = duration?.dataPoints.find(
      (dp) => dp.attributes["messaging.destination.name"] === "reports",
    ) as { value: { count: number; sum: number } } | undefined;
    expect(point?.value.count).toBe(1);
    expect(point?.value.sum).toBeCloseTo(2.5, 5);
  });

  test("skips the duration histogram when timestamps are missing (job never started processing)", async () => {
    recordJobOutcome("billing", "failed", undefined, undefined);

    const outcomes = await collectMetric("bullmq.job.outcomes");
    const duration = await collectMetric("bullmq.job.duration");
    expect(
      outcomes?.dataPoints.some((dp) => dp.attributes["messaging.destination.name"] === "billing"),
    ).toBe(true);
    expect(
      duration?.dataPoints.some((dp) => dp.attributes["messaging.destination.name"] === "billing"),
    ).toBe(false);
  });
});

describe("recordDeadLetter", () => {
  test("labels by parking store and queue, never by school or job id", async () => {
    recordDeadLetter("billing", "billing");

    const entries = await collectMetric("dead_letter.entries");
    const point = entries?.dataPoints.find((dp) => dp.attributes.source === "billing");
    expect(point?.attributes["messaging.destination.name"]).toBe("billing");
    expect(point?.value).toBe(1);
    // The cardinality budget is the point of the assertion, not an incidental detail: a school id
    // here would make this series unbounded (docs/runbooks/metrics-dashboard-catalog.md).
    expect(Object.keys(point?.attributes ?? {}).sort()).toEqual([
      "messaging.destination.name",
      "source",
    ]);
  });

  test("counts each parked unit of work separately per source", async () => {
    recordDeadLetter("notifications", "notifications");
    recordDeadLetter("notifications", "notifications");

    const entries = await collectMetric("dead_letter.entries");
    const point = entries?.dataPoints.find((dp) => dp.attributes.source === "notifications");
    expect(point?.value).toBe(2);
  });
});
