/**
 * Sensitive record retention scheduler. Registers the daily sweep as a BullMQ Job Scheduler, the
 * same idempotent-upsert pattern ai-message-retention-sweep-scheduler.ts uses.
 */
import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 08:50 UTC every day -- after the Ask AI message purge (08:45) on the same queue. */
export const RECORD_RETENTION_SWEEP_CRON_PATTERN = "50 8 * * *";
const RECORD_RETENTION_SWEEP_SCHEDULER_ID = "maintenance-sensitive-record-retention-daily";

export async function scheduleRecordRetentionSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      RECORD_RETENTION_SWEEP_SCHEDULER_ID,
      { pattern: RECORD_RETENTION_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_EXPIRED_SENSITIVE_RECORDS },
    );
  } finally {
    await queue.close();
  }
}
