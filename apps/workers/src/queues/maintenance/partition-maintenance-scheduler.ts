/**
 * Partition maintenance scheduler. Registers the daily run of ensureFuturePartitions
 * (partition-maintenance.ts) as a BullMQ Job Scheduler, the same idempotent-upsert pattern
 * closure-sweep-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 02:15 UTC every day: quiet hours, and well before any month boundary matters. */
export const PARTITION_MAINTENANCE_CRON_PATTERN = "15 2 * * *";

const PARTITION_MAINTENANCE_SCHEDULER_ID = "maintenance-table-partitions-daily";

export async function schedulePartitionMaintenanceJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      PARTITION_MAINTENANCE_SCHEDULER_ID,
      { pattern: PARTITION_MAINTENANCE_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.ENSURE_TABLE_PARTITIONS },
    );
  } finally {
    await queue.close();
  }
}
