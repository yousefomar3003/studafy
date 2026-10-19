/**
 * Finance-reconciliation job scheduler.
 *
 * Registers the daily finance reconciliation (finance-reconciliation.ts) as a BullMQ Job Scheduler (v5's replacement for
 * repeatable jobs). `upsertJobScheduler` is idempotent: every worker boot upserts the same
 * scheduler id with the same cron, and Redis treats it as a no-op. The scheduled job lands on the
 * billing queue with the job name the registry dispatches to `runFinanceReconciliation`.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 02:30 UTC every day (05:30 in Amman): before a school's day starts, so the Finance dashboard
 * opens on reconciled balances, and clear of the 03:00-06:15 billing sweeps it shares the queue
 * with. Not urgent beyond that: drift is closed within a day either way.
 */
export const FINANCE_RECONCILIATION_CRON_PATTERN = "30 2 * * *";

const FINANCE_RECONCILIATION_SCHEDULER_ID = "billing-finance-reconciliation-daily";

export async function scheduleFinanceReconciliationJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      FINANCE_RECONCILIATION_SCHEDULER_ID,
      { pattern: FINANCE_RECONCILIATION_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_FINANCE_RECONCILIATION },
    );
  } finally {
    await queue.close();
  }
}
