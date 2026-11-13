/**
 * Data retention scheduler. Registers the daily run of purgeExpiredRetainedData
 * (data-retention-sweep.ts) as a BullMQ Job Scheduler, the same idempotent-upsert pattern
 * closure-sweep-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 03:15 UTC every day: quiet hours, after partition maintenance (02:15) on the same queue. */
export const DATA_RETENTION_SWEEP_CRON_PATTERN = "15 3 * * *";

const DATA_RETENTION_SWEEP_SCHEDULER_ID = "maintenance-data-retention-daily";

export async function scheduleDataRetentionSweepJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      DATA_RETENTION_SWEEP_SCHEDULER_ID,
      { pattern: DATA_RETENTION_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_EXPIRED_RETAINED_DATA },
    );
  } finally {
    await queue.close();
  }
}
