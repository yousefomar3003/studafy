/**
 * Announcement publish-sweep scheduler (ST-194).
 *
 * Registers the scheduled-publish sweep as a BullMQ Job Scheduler, the same idempotent
 * upsert-on-every-boot pattern as `scheduleReportExpiryJob`. Every 5 minutes rather than the daily
 * cadence the other sweeps use: those clean up after the fact on a tolerant deadline, but a school
 * scheduling "8am tomorrow" expects recipients to see it reasonably close to 8am, not sometime that
 * day. On the notifications queue, not a new one of its own — this is a notifications-shaped
 * concern (see docs/architecture/SAD_21_notification_dispatch_flow.md's queue placement reasoning),
 * and `registry.ts` already dispatches that queue's jobs on `job.name`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

export const ANNOUNCEMENT_PUBLISH_CRON_PATTERN = "*/5 * * * *";

const ANNOUNCEMENT_PUBLISH_SCHEDULER_ID = "announcements-publish-sweep";

export async function scheduleAnnouncementPublishJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.NOTIFICATIONS, { connection });
  try {
    await queue.upsertJobScheduler(
      ANNOUNCEMENT_PUBLISH_SCHEDULER_ID,
      { pattern: ANNOUNCEMENT_PUBLISH_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PUBLISH_DUE_ANNOUNCEMENTS },
    );
  } finally {
    await queue.close();
  }
}
