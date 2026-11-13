/**
 * IP address retention scheduler. Registers the daily removal of IP addresses older than 90 days as a
 * BullMQ Job Scheduler, the same idempotent-upsert pattern closure-sweep-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 03:45 UTC every day -- a quiet slot: after the Tap renewal run (03:00) and before the dunning
 * sweep (04:00), and the only job on the maintenance queue at that hour.
 */
export const IP_ADDRESS_RETENTION_SWEEP_CRON_PATTERN = "45 3 * * *";

const IP_ADDRESS_RETENTION_SWEEP_SCHEDULER_ID = "maintenance-ip-address-retention-daily";

export async function scheduleIpAddressRetentionSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      IP_ADDRESS_RETENTION_SWEEP_SCHEDULER_ID,
      { pattern: IP_ADDRESS_RETENTION_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_EXPIRED_IP_ADDRESSES },
    );
  } finally {
    await queue.close();
  }
}
