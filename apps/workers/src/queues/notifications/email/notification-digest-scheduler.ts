/**
 * Notification digest job scheduler.
 *
 * Registers the daily per-recipient notification digest as a BullMQ Job Scheduler, the same
 * upsert-is-idempotent shape digest-scheduler.ts uses for the parent digest: every worker boot
 * upserts the same scheduler id with the same cron, and Redis treats it as a no-op. The scheduled
 * job lands on the notifications queue with the job name the registry dispatches to
 * processNotificationDigest.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 06:30 UTC every day — after the 06:00 parent digest (digest-scheduler.ts) so the two jobs never
 * contend for the same outbox-insert window, before parents' and students' mornings.
 */
export const NOTIFICATION_DIGEST_CRON_PATTERN = "30 6 * * *";

const NOTIFICATION_DIGEST_SCHEDULER_ID = "notification-digest-daily";

export async function scheduleNotificationDigestJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection });
  try {
    await queue.upsertJobScheduler(
      NOTIFICATION_DIGEST_SCHEDULER_ID,
      { pattern: NOTIFICATION_DIGEST_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.SEND_NOTIFICATION_DIGESTS },
    );
  } finally {
    await queue.close();
  }
}
