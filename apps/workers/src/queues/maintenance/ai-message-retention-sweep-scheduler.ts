/**
 * Ask AI message retention scheduler (ST-309). Registers the daily purge as a BullMQ Job Scheduler,
 * the same idempotent-upsert pattern closure-sweep-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 08:45 UTC every day -- after the tenant-closure sweep (08:30) on the same queue. */
export const AI_MESSAGE_RETENTION_SWEEP_CRON_PATTERN = "45 8 * * *";

const AI_MESSAGE_RETENTION_SWEEP_SCHEDULER_ID = "maintenance-ai-message-retention-daily";

export async function scheduleAiMessageRetentionSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      AI_MESSAGE_RETENTION_SWEEP_SCHEDULER_ID,
      { pattern: AI_MESSAGE_RETENTION_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_EXPIRED_AI_MESSAGES },
    );
  } finally {
    await queue.close();
  }
}
