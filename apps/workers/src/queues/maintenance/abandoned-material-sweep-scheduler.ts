/**
 * Abandoned material sweep scheduler. Registers the daily removal of never-confirmed uploads and
 * long-failed materials (abandoned-material-sweep.ts) as a BullMQ Job Scheduler, the same idempotent
 * upsert closure-sweep-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 04:20 UTC every day: a quiet slot on the maintenance queue (after the 03:45 IP address purge), and
 * before the 06:00 storage reconciliation, which then recounts every school's meter from the bucket
 * the sweep has just cleaned.
 */
export const ABANDONED_MATERIAL_SWEEP_CRON_PATTERN = "20 4 * * *";

const ABANDONED_MATERIAL_SWEEP_SCHEDULER_ID = "maintenance-abandoned-materials-daily";

export async function scheduleAbandonedMaterialSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      ABANDONED_MATERIAL_SWEEP_SCHEDULER_ID,
      { pattern: ABANDONED_MATERIAL_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_ABANDONED_MATERIALS },
    );
  } finally {
    await queue.close();
  }
}
