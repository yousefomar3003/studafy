/**
 * Abandoned-import purge scheduler (ST-190 follow-up).
 *
 * Registers the daily abandoned-import sweep as a BullMQ Job Scheduler, the same idempotent
 * upsert-on-every-boot pattern as `scheduleReportExpiryJob`. The scheduled job lands on the imports
 * queue with the job name `registry.ts`'s IMPORTS processor dispatches to
 * `purgeAbandonedStudentImports`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** 08:00 UTC every day — after the dunning (04:00), seat (05:00), storage-quota (06:00) and
 * report-expiry (07:00) sweeps, so none of them contend for the same connection pool window. */
export const ABANDONED_IMPORT_SWEEP_CRON_PATTERN = "0 8 * * *";

const ABANDONED_IMPORT_SWEEP_SCHEDULER_ID = "imports-abandoned-sweep-daily";

export async function scheduleAbandonedImportSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.IMPORTS, { connection });
  try {
    await queue.upsertJobScheduler(
      ABANDONED_IMPORT_SWEEP_SCHEDULER_ID,
      { pattern: ABANDONED_IMPORT_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.PURGE_ABANDONED_IMPORTS },
    );
  } finally {
    await queue.close();
  }
}
