/**
 * Account-deletion sweep scheduler (000143). Registers the daily sweep that runs self-service
 * deletions whose 14-day grace period has ended, the same idempotent-upsert pattern
 * closure-sweep-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 09:00 UTC every day -- after the closure sweep (08:30) and the AI message purge (08:45). */
export const ACCOUNT_DELETION_SWEEP_CRON_PATTERN = "0 9 * * *";

const ACCOUNT_DELETION_SWEEP_SCHEDULER_ID = "maintenance-account-deletion-sweep-daily";

export async function scheduleAccountDeletionSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      ACCOUNT_DELETION_SWEEP_SCHEDULER_ID,
      { pattern: ACCOUNT_DELETION_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_ACCOUNT_DELETION_SWEEP },
    );
  } finally {
    await queue.close();
  }
}
