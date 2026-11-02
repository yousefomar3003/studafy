/**
 * Tap renewal job scheduler (ST-298).
 *
 * Registers the daily Tap renewal run as a BullMQ Job Scheduler, the same idempotent
 * `upsertJobScheduler` pattern as the dunning sweep.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 03:00 UTC every day: an hour before the 04:00 dunning sweep, so a subscription whose last renewal
 * attempt failed tonight is already in `grace_period` when the sweep sends its first reminder.
 */
export const TAP_RENEWAL_CRON_PATTERN = "0 3 * * *";

const TAP_RENEWAL_SCHEDULER_ID = "billing-tap-renewal-daily";

export async function scheduleTapRenewalJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      TAP_RENEWAL_SCHEDULER_ID,
      { pattern: TAP_RENEWAL_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_TAP_RENEWALS },
    );
  } finally {
    await queue.close();
  }
}
