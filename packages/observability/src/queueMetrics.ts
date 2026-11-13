import { metrics } from "@opentelemetry/api";
// Incubating (not yet stable) semantic conventions live at their own subpath — see
// @opentelemetry/semantic-conventions's package.json "./incubating" export.
import { ATTR_MESSAGING_DESTINATION_NAME } from "@opentelemetry/semantic-conventions/incubating";
import { Queue } from "bullmq";

import type {
  BatchObservableResult,
  Counter,
  Histogram,
  ObservableGauge,
} from "@opentelemetry/api";
import type { ConnectionOptions } from "bullmq";

const METER_NAME = "studafy.queue";

// A fixed, small vocabulary — BullMQ's own job-count states. Never a job id or job name, both of
// which are unbounded (see docs/runbooks/metrics-dashboard-catalog.md's cardinality-budget note).
const JOB_COUNT_STATES = ["waiting", "active", "delayed", "failed", "completed"] as const;

/**
 * Exported for metricsServer.ts's bucket-boundary view, for the same reason redMetrics.ts exports
 * its own name: a view selector that no longer matches its instrument fails silently, leaving the
 * SDK's default boundaries in place.
 */
export const BULLMQ_JOB_DURATION = "bullmq.job.duration";

export type JobOutcome = "completed" | "failed";

/**
 * Where a permanently-failed unit of work was parked. A fixed, two-value vocabulary, deliberately
 * not the queue name: the two sources have different durable stores (see recordDeadLetter), and
 * "which store do I drain" is the only question the alert needs answered — the queue name is
 * already on the log line and the dead-letter row itself.
 */
export type DeadLetterSource = "notifications" | "billing";

// Lazy singletons for the same reason redMetrics.ts's histogram is: an instrument created before
// startMetricsServer() registers the real global MeterProvider would stay a no-op forever.
let jobOutcomesCounter: Counter | undefined;
let jobDurationHistogram: Histogram | undefined;
let deadLetterCounter: Counter | undefined;

function getJobOutcomesCounter(): Counter {
  jobOutcomesCounter ??= metrics.getMeter(METER_NAME).createCounter("bullmq.job.outcomes", {
    description: "BullMQ jobs that reached a terminal state, by queue and outcome.",
  });
  return jobOutcomesCounter;
}

function getJobDurationHistogram(): Histogram {
  jobDurationHistogram ??= metrics.getMeter(METER_NAME).createHistogram(BULLMQ_JOB_DURATION, {
    description: "Wall-clock time from a job's processing start to its terminal state, by queue.",
    unit: "s",
  });
  return jobDurationHistogram;
}

function getDeadLetterCounter(): Counter {
  deadLetterCounter ??= metrics.getMeter(METER_NAME).createCounter("dead_letter.entries", {
    description: "Units of work parked in a dead-letter store after exhausting their retries.",
  });
  return deadLetterCounter;
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

/**
 * Records one unit of work parked in a dead-letter store (ST-262's "DLQ non-empty" alert).
 *
 * A counter, not a gauge of the store's current size, and that is a deliberate trade worth naming:
 * both durable stores are behind forced row-level security keyed on `app.school_id`
 * (`app.notification_dead_letters`) or restricted to `studafy_admin`
 * (`app.billing_events`), so a *global* "how many are undrained right now" reading would mean one
 * query per school on every scrape. What the pager actually needs is "something dead-lettered and
 * nobody has looked at it", which an arrival rate answers exactly — and the standing backlog is a
 * drain-time question the runbook answers with SQL, not a per-30s scrape.
 *
 * Call this from the same code path that writes the durable record, so the two cannot disagree:
 * - `notifications` — `apps/workers/src/queues/notifications/dead-letter.ts` (one
 *   `app.notification_dead_letters` row per terminally-failed dispatch job).
 * - `billing` — `apps/workers/src/queues/billing/billing-event.service.ts` (one
 *   `app.billing_events` row flipped to `status = 'dlq'`).
 *
 * Deliberately no `school_id` label: see this module's cardinality note above.
 */
export function recordDeadLetter(source: DeadLetterSource, queueName: string): void {
  getDeadLetterCounter().add(1, {
    source,
    [ATTR_MESSAGING_DESTINATION_NAME]: queueName,
  });
}

export interface QueueGaugesHandle {
  /** Stops observing and closes the read-only Queue clients this opened. */
  close: () => Promise<void>;
}

/**
 * Observes the two backlog signals apps/workers' queues are alerted on, both lazily, on every
 * Prometheus scrape rather than on a fixed poll interval: `@opentelemetry/api`'s observable
 * callbacks run exactly when a `MetricReader` (the Prometheus exporter) collects, so the readings
 * are always as fresh as the last scrape with no separate timer to leak or drift out of sync with
 * the scrape interval.
 *
 * - **`bullmq.queue.jobs`** — job counts per queue × state (waiting/active/delayed/failed/
 *   completed). *How much* work is outstanding.
 * - **`bullmq.queue.backlog.age`** — seconds the oldest *eligible* waiting job has been waiting.
 *   *How long* it has been outstanding, which is the signal that distinguishes a busy queue from a
 *   stopped one: a queue 10,000 jobs deep that is draining is healthy, and a queue 3 jobs deep
 *   whose oldest has waited an hour is not. `0` when nothing is waiting.
 *
 * One batch callback over one set of `Queue` handles, not two independent callbacks: both readings
 * come from the same Redis round trips, and `addBatchObservableCallback` is the API that exists
 * precisely so two instruments can share one fetch.
 *
 * `queueNames` is `QUEUE_NAMES`'s value set (`@studafy/constants`) — every registry entry, not a
 * per-job or per-tenant list, which keeps the series count `queues × states`, not `queues × jobs`.
 */
export function startQueueGauges(
  queueNames: readonly string[],
  connection: ConnectionOptions,
): QueueGaugesHandle {
  // Read-only handles: this module only ever calls getJobCounts()/getWaiting(), never
  // add()/process(). BullMQ's Queue constructor does not itself start consuming anything.
  const queues = queueNames.map((name) => new Queue(name, { connection }));
  const meter = metrics.getMeter(METER_NAME);

  const depthGauge: ObservableGauge = meter.createObservableGauge("bullmq.queue.jobs", {
    description: "BullMQ job counts per queue and state (waiting/active/delayed/failed/completed).",
  });

  const backlogAgeGauge: ObservableGauge = meter.createObservableGauge("bullmq.queue.backlog.age", {
    description:
      "Seconds the oldest eligible waiting job in each queue has been waiting; 0 when idle.",
    unit: "s",
  });

  const callback = async (result: BatchObservableResult): Promise<void> => {
    const now = Date.now();

    await Promise.all(
      queues.map(async (queue) => {
        const [counts, oldestWaiting] = await Promise.all([
          queue.getJobCounts(...JOB_COUNT_STATES),
          // getWaiting(0, 0) is `getJobs(["waiting"], 0, 0, true)` — ascending, so it reads the
          // tail of the `wait` list, which is the *oldest* waiting job (BullMQ pushes new jobs at
          // the head and moves jobs to `active` from the tail). One job per queue per scrape.
          queue.getWaiting(0, 0),
        ]);

        // Object.entries, not a computed counts[state] access: the latter trips
        // eslint-plugin-security's detect-object-injection, and there is no reason to take the
        // disable (see apps/api/src/logger.ts's fragments() for the same convention).
        for (const [state, count] of Object.entries(counts)) {
          result.observe(depthGauge, count, {
            [ATTR_MESSAGING_DESTINATION_NAME]: queue.name,
            state,
          });
        }

        result.observe(backlogAgeGauge, waitingSecondsOf(oldestWaiting[0], now), {
          [ATTR_MESSAGING_DESTINATION_NAME]: queue.name,
        });
      }),
    );
  };

  meter.addBatchObservableCallback(callback, [depthGauge, backlogAgeGauge]);

  return {
    close: async () => {
      meter.removeBatchObservableCallback(callback, [depthGauge, backlogAgeGauge]);
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}

/**
 * Seconds `job` has been waiting *since it became eligible to run*, or 0 when there is no waiting
 * job at all.
 *
 * `timestamp + delay`, not `timestamp`: `timestamp` is when the job was *created*, and a scheduled
 * job (`JOB_NAMES.RUN_DUNNING` and every other Job Scheduler entry in apps/workers) is created the
 * moment its previous run finishes, with a `delay` carrying it to its next cron slot. Measuring
 * from `timestamp` would report a daily sweep as ~24 hours of backlog every day — a guaranteed
 * false page, on the one signal whose entire job is to distinguish a stopped queue from a busy one.
 *
 * Clamped at 0 because a job promoted from `delayed` to `waiting` can be read a few milliseconds
 * before its own eligibility instant, and a negative age is not a thing an operator should ever
 * have to interpret.
 */
function waitingSecondsOf(job: { timestamp: number; delay: number } | undefined, now: number) {
  if (job === undefined) {
    return 0;
  }
  return Math.max(0, (now - (job.timestamp + job.delay)) / 1000);
}
