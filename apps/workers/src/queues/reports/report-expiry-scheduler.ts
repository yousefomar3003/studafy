/**
 * Expired-report purge scheduler (ST-175).
 *
 * Registers the daily expired-report sweep as a BullMQ Job Scheduler (v5's replacement for
 * repeatable jobs). `upsertJobScheduler` is idempotent: every worker boot upserts the same
 * scheduler id with the same cron, and Redis treats it as a no-op. The scheduled job lands on the
 * reports queue with the job name the registry dispatches to `purgeExpiredReports`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 07:00 UTC every day. The bucket lifecycle rule already expires attendance artifacts and the
 * legacy finance keys have no rule at all, so the sweep is a storage-cost bound, not an urgent
 * one — running it after the billing morning leaves the quietest window.
 */
export const REPORT_EXPIRY_CRON_PATTERN = "0 7 * * *";

const REPORT_EXPIRY_SCHEDULER_ID = "reports-expiry-daily";

export async function scheduleReportExpiryJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.REPORTS, { connection });
  try {
    await queue.upsertJobScheduler(
      REPORT_EXPIRY_SCHEDULER_ID,
      { pattern: REPORT_EXPIRY_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_EXPIRED_REPORTS },
    );
  } finally {
    await queue.close();
  }
}
