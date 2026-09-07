import { metrics } from "@opentelemetry/api";
// Incubating (not yet stable) semantic conventions live at their own subpath — see
// @opentelemetry/semantic-conventions's package.json "./incubating" export.
import { ATTR_MESSAGING_DESTINATION_NAME } from "@opentelemetry/semantic-conventions/incubating";
import { Queue } from "bullmq";

import type { Counter, Histogram, ObservableGauge, ObservableResult } from "@opentelemetry/api";
import type { ConnectionOptions } from "bullmq";

const METER_NAME = "studafy.queue";

// A fixed, small vocabulary — BullMQ's own job-count states. Never a job id or job name, both of
// which are unbounded (see docs/runbooks/metrics-dashboard-catalog.md's cardinality-budget note).
const JOB_COUNT_STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;

export type JobOutcome = "completed" | "failed";

// Lazy singletons for the same reason redMetrics.ts's histogram is: an instrument created before
// startMetricsServer() registers the real global MeterProvider would stay a no-op forever.
let jobOutcomesCounter: Counter | undefined;
let jobDurationHistogram: Histogram | undefined;

function getJobOutcomesCounter(): Counter {
  jobOutcomesCounter ??= metrics.getMeter(METER_NAME).createCounter("bullmq.job.outcomes", {
    description: "BullMQ jobs that reached a terminal state, by queue and outcome.",
  });
  return jobOutcomesCounter;
}

function getJobDurationHistogram(): Histogram {
  jobDurationHistogram ??= metrics.getMeter(METER_NAME).createHistogram("bullmq.job.duration", {
    description: "Wall-clock time from a job's processing start to its terminal state, by queue.",
    unit: "s",
  });
  return jobDurationHistogram;
}

/**
 * Records one terminal job outcome (ST-259's "queue metrics" — the Rate/Errors/Duration
 * equivalent for a queue consumer, which has no HTTP route to key off). Call this from the
 * `Worker`'s own `completed`/`failed` listeners (see apps/workers/src/worker.ts's
 * `createBullmqWorker`) — never from inside a processor itself, so a processor that forgets to
 * report its own outcome cannot silently go unmeasured.
 *
 * `queueName` is one of `QUEUE_NAMES` (`@studafy/constants`) — a fixed, small enum — never a job
 * id or job name.
 */
export function recordJobOutcome(
  queueName: string,
  outcome: JobOutcome,
  processedOn: number | undefined,
  finishedOn: number | undefined,
): void {
  getJobOutcomesCounter().add(1, {
    [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
    outcome,
  });

  if (processedOn !== undefined && finishedOn !== undefined && finishedOn >= processedOn) {
    getJobDurationHistogram().record((finishedOn - processedOn) / 1000, {
      [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
    });
  }
}

export interface QueueDepthGaugeHandle {
  /** Stops observing and closes the read-only Queue clients this opened. */
  close: () => Promise<void>;
}

/**
 * Observes queue depth (`bullmq.queue.jobs`, one gauge per queue × job-count state) on every
 * Prometheus scrape, rather than on a fixed poll interval: `@opentelemetry/api`'s observable
 * gauge callback runs lazily, exactly when a `MetricReader` (the Prometheus exporter) collects —
 * so depth is always as fresh as the last scrape, with no separate timer to leak or drift out of
 * sync with scrape interval.
 *
 * `queueNames` is `QUEUE_NAMES`'s value set (`@studafy/constants`) — every registry entry, not a
 * per-job or per-tenant list, which keeps the series count `queues × states`, not `queues × jobs`.
 */
export function startQueueDepthGauge(
  queueNames: readonly string[],
  connection: ConnectionOptions,
): QueueDepthGaugeHandle {
  // Read-only handles: this module only ever calls getJobCounts(), never add()/process(). BullMQ's
  // Queue constructor does not itself start consuming anything.
  const queues = queueNames.map((name) => new Queue(name, { connection }));

  const gauge: ObservableGauge = metrics
    .getMeter(METER_NAME)
    .createObservableGauge("bullmq.queue.jobs", {
      description:
        "BullMQ job counts per queue and state (waiting/active/delayed/failed/completed).",
    });

  const callback = async (result: ObservableResult): Promise<void> => {
    await Promise.all(
      queues.map(async (queue) => {
        const counts = await queue.getJobCounts(...JOB_COUNT_STATES);
        // Object.entries, not a computed counts[state] access: the latter trips
        // eslint-plugin-security's detect-object-injection, and there is no reason to take the
        // disable (see apps/api/src/logger.ts's fragments() for the same convention).
        for (const [state, count] of Object.entries(counts)) {
          result.observe(count, {
            [ATTR_MESSAGING_DESTINATION_NAME]: queue.name,
            state,
          });
        }
      }),
    );
  };

  gauge.addCallback(callback);

  return {
    close: async () => {
      gauge.removeCallback(callback);
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}
