/**
 * Digest job scheduler.
 *
 * Registers the daily parent-digest as a BullMQ Job Scheduler (v5's replacement for repeatable
 * jobs). `upsertJobScheduler` is idempotent: every worker boot upserts the same scheduler id with
 * the same cron, and Redis treats it as a no-op. The scheduled job lands on the notifications
 * queue with the job name the registry dispatches to `processDigest`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 06:00 UTC every day — after any school-day activity but before parents' mornings. */
export const DIGEST_CRON_PATTERN = "0 6 * * *";

const DIGEST_SCHEDULER_ID = "parent-digest-daily";

export async function scheduleDigestJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection });
  try {
    await queue.upsertJobScheduler(
      DIGEST_SCHEDULER_ID,
      { pattern: DIGEST_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.SEND_DIGESTS },
    );
  } finally {
    await queue.close();
  }
}
