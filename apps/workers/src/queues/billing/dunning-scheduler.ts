/**
 * Dunning sweep job scheduler.
 *
 * Registers the daily grace-period sweep as a BullMQ Job Scheduler (v5's replacement for repeatable
 * jobs). `upsertJobScheduler` is idempotent: every worker boot upserts the same scheduler id with
 * the same cron, and Redis treats it as a no-op. The scheduled job lands on the billing queue with
 * the job name the registry dispatches to `runDunningSweep`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 04:00 UTC every day. Before the day's billing activity, and the grace-window deadline is measured
 * in days, so a daily run cannot skip a subscription whose window closes mid-day — the sweep either
 * suspended it the morning of the deadline or, on a same-day boundary, the morning after, and both
 * are within the 24h slack the calendar day gives us.
 */
export const DUNNING_CRON_PATTERN = "0 4 * * *";

const DUNNING_SCHEDULER_ID = "billing-dunning-daily";

export async function scheduleDunningJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      DUNNING_SCHEDULER_ID,
      { pattern: DUNNING_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_DUNNING },
    );
  } finally {
    await queue.close();
  }
}
