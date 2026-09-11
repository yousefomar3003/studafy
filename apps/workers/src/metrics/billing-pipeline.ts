/**
 * The payment pipeline's liveness signal (ST-262).
 *
 * ## Why a database gauge and not a counter
 *
 * Every other alerting signal in this repo is emitted by the code path that does the work — a RED
 * histogram per request, a counter per terminal job. Those answer "is work failing". They cannot
 * answer the question that actually matters for money: **"has work stopped happening at all"**.
 *
 * A Stripe webhook is claimed into `app.billing_events` (status `pending`) by the API at intake,
 * in the same transaction that verifies its signature, and is only flipped to `processed` once a
 * transition has been applied. So a row sitting at `pending`/`failed` is, precisely, work that was
 * accepted and never finished — and the *age* of the oldest such row is how long the pipeline has
 * been halted. No in-process counter can see that: the process that would have emitted it is the
 * one that is not running.
 *
 * That makes this the one gauge worth a query. The table is small by construction (see
 * `db/migrations/000078`'s "Partitioning: deliberately deferred" — a school generates on the order
 * of a dozen provider events a year), and `idx_billing_events_unresolved` is a partial index over
 * exactly the `status IN ('pending','failed')` tail this reads, so the query touches the
 * unresolved backlog, never the table.
 *
 * ## Why apps/workers owns it, and not @studafy/observability
 *
 * `@studafy/observability` is deliberately transport-generic: it knows about HTTP requests and
 * BullMQ jobs, not about this product's tables. A gauge that embeds `app.billing_events` in a SQL
 * string belongs with the app that owns the schema.
 *
 * That is why this file — alone among apps/workers — imports `@opentelemetry/api` directly rather
 * than going through `@studafy/observability`. `@opentelemetry/api` is a zero-dependency facade
 * whose entire purpose is to be depended on by instrumented application code; routing this through
 * the shared package would mean either leaking the word "billing" into a package that must not know
 * it, or inventing a stringly-typed "declare some gauges and a reader" abstraction to avoid saying
 * it. Both are worse than one honest import. `startMetricsServer()` (apps/workers' `index.ts`) is
 * still the only thing that registers a `MeterProvider`, so the ordering contract is unchanged:
 * this module must be started after it, like every other instrument in the process.
 *
 * ## Global, not per-tenant
 *
 * `app.billing_events` carries the `global_admin_only` policy (`TO studafy_admin USING (true)`,
 * migration 000016) rather than `tenant_isolation`, so one query under `withSystemTx` reads the
 * whole ledger. That is what makes this affordable on every scrape, and it is exactly why the
 * notification dead-letter signal next door is a counter instead — `app.notification_dead_letters`
 * is RLS-forced per school, so its equivalent reading would be one query per school.
 */

import { metrics } from "@opentelemetry/api";

import { withSystemTx } from "../db/tenant-tx";

import type { BatchObservableResult, ObservableGauge } from "@opentelemetry/api";
import type { Sql } from "postgres";

const METER_NAME = "studafy.billing";

/**
 * Ceiling on the scrape-path query. An observable callback runs inside Prometheus's own scrape, so
 * a query blocked behind a lock would hold the scrape open rather than fail fast; five seconds is
 * comfortably longer than a partial-index lookup can honestly take and comfortably shorter than
 * Prometheus's own scrape timeout.
 */
const STATEMENT_TIMEOUT = "5s";

export interface BillingPipelineGaugesOptions {
  /** Connection the scrape-path query runs on. Read-only in practice; never written to here. */
  db: Sql;
  /** Where a failed observation is reported. A scrape that reads nothing must not be silent. */
  logger: { error: (fields: Record<string, unknown>, message: string) => void };
}

export interface BillingPipelineGaugesHandle {
  /** Stops observing. The caller still owns `db` and closes it. */
  close: () => void;
}

interface UnresolvedBacklog {
  unresolved: number;
  backlog_age_seconds: number;
}

/**
 * Reads the unresolved tail of `app.billing_events`.
 *
 * `COALESCE(..., 0)` rather than a null age: an empty backlog is the healthy state, and "no rows"
 * and "oldest row is zero seconds old" mean the same thing to every alert that reads this. Leaving
 * it null would make the series disappear instead, which reads identically to "the worker died" —
 * the one state this gauge exists to distinguish.
 */
export async function readUnresolvedBacklog(db: Sql): Promise<UnresolvedBacklog> {
  return await withSystemTx(db, async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);

    const [row] = await tx<UnresolvedBacklog[]>`
      SELECT count(*)::int AS unresolved,
             COALESCE(
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - min(received_at))),
               0
             )::float8 AS backlog_age_seconds
      FROM app.billing_events
      WHERE status IN ('pending', 'failed')
    `;

    // An aggregate over zero rows still returns exactly one row, so this is unreachable — asserted
    // rather than defaulted so a future rewrite that adds a GROUP BY fails loudly here.
    if (row === undefined) {
      throw new Error("aggregate over app.billing_events returned no row");
    }
    return row;
  });
}

/**
 * Observes the unresolved billing-event backlog on every Prometheus scrape.
 *
 * - **`billing.events.unresolved`** — rows at `pending`/`failed`. *How much* is stuck.
 * - **`billing.events.backlog.age`** — seconds since the oldest of them was received; `0` when the
 *   ledger is clear. *How long* it has been stuck, which is the halt signal:
 *   `BillingEventPipelineHalted` (ST-262) pages on this, not on depth, because a burst of renewals
 *   is a deep backlog that drains and a dead worker is a shallow one that does not.
 *
 * One batch callback over one query, the same shape as `startQueueGauges` in
 * `@studafy/observability` and for the same reason: two readings, one round trip.
 */
export function startBillingPipelineGauges(
  options: BillingPipelineGaugesOptions,
): BillingPipelineGaugesHandle {
  const meter = metrics.getMeter(METER_NAME);

  const unresolvedGauge: ObservableGauge = meter.createObservableGauge(
    "billing.events.unresolved",
    { description: "Provider billing events accepted but not yet processed (pending or failed)." },
  );

  const backlogAgeGauge: ObservableGauge = meter.createObservableGauge(
    "billing.events.backlog.age",
    {
      description:
        "Seconds since the oldest unresolved provider billing event was received; 0 when clear.",
      unit: "s",
    },
  );

  const callback = async (result: BatchObservableResult): Promise<void> => {
    try {
      const backlog = await readUnresolvedBacklog(options.db);
      result.observe(unresolvedGauge, backlog.unresolved);
      result.observe(backlogAgeGauge, backlog.backlog_age_seconds);
    } catch (error: unknown) {
      // Observe nothing and say so. Both series then go *absent* rather than stale-but-plausible,
      // which is the honest reading — this scrape learned nothing about the ledger. The alerts
      // that read them are `for:`-guarded and treat absence as "no data", not as "healthy"; the
      // database being unreachable has its own alarms.
      options.logger.error(
        { event: "billing_pipeline_gauge_failed", err: error },
        "could not read the unresolved billing-event backlog for this scrape",
      );
    }
  };

  meter.addBatchObservableCallback(callback, [unresolvedGauge, backlogAgeGauge]);

  return {
    close: () => meter.removeBatchObservableCallback(callback, [unresolvedGauge, backlogAgeGauge]),
  };
}
