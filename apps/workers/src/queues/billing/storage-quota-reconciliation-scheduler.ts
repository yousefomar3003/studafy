/**
 * Storage-quota reconciliation job scheduler (ST-16x).
 *
 * Registers the daily storage-quota sweep as a BullMQ Job Scheduler (v5's replacement for
 * repeatable jobs). `upsertJobScheduler` is idempotent: every worker boot upserts the same
 * scheduler id with the same cron, and Redis treats it as a no-op. The scheduled job lands on the
 * billing queue with the job name the registry dispatches to `runStorageQuotaReconciliation`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 06:00 UTC every day, an hour after the 05:00 seat reconciliation (ST-136) and two after the
 * 04:00 dunning sweep (ST-134). The storage meter tolerates 1% drift; a daily recompute from the
 * bucket keeps every school's meter honest. It is not urgent, so it runs last in the billing
 * morning — a school suspended overnight has its objects quarantined/deleted by then, and the
 * sweep records the post-suspension figure.
 */
export const STORAGE_QUOTA_RECONCILIATION_CRON_PATTERN = "0 6 * * *";

const STORAGE_QUOTA_RECONCILIATION_SCHEDULER_ID = "billing-storage-quota-reconciliation-daily";

export async function scheduleStorageQuotaReconciliationJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      STORAGE_QUOTA_RECONCILIATION_SCHEDULER_ID,
      { pattern: STORAGE_QUOTA_RECONCILIATION_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_STORAGE_QUOTA_RECONCILIATION },
    );
  } finally {
    await queue.close();
  }
}
