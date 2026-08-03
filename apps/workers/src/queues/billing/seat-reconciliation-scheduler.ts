/**
 * Seat-reconciliation job scheduler (ST-136).
 *
 * Registers the daily seat-reconciliation sweep as a BullMQ Job Scheduler (v5's replacement for
 * repeatable jobs). `upsertJobScheduler` is idempotent: every worker boot upserts the same
 * scheduler id with the same cron, and Redis treats it as a no-op. The scheduled job lands on the
 * billing queue with the job name the registry dispatches to `runSeatReconciliation`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 05:00 UTC every day, an hour after the 04:00 dunning sweep (ST-134). Reconciliation is not
 * urgent — drift is closed within a day either way — and running after dunning means a school
 * suspended overnight is no longer `active` and is skipped rather than charged for seats it is
 * about to lose access to.
 */
export const SEAT_RECONCILIATION_CRON_PATTERN = "0 5 * * *";

const SEAT_RECONCILIATION_SCHEDULER_ID = "billing-seat-reconciliation-daily";

export async function scheduleSeatReconciliationJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      SEAT_RECONCILIATION_SCHEDULER_ID,
      { pattern: SEAT_RECONCILIATION_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_SEAT_RECONCILIATION },
    );
  } finally {
    await queue.close();
  }
}
