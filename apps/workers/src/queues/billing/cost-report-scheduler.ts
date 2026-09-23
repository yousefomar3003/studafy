/**
 * Cost & budget reporting scheduler (ST-293). Registers two BullMQ Job Schedulers on the billing
 * queue, the same idempotent-upsert pattern every other scheduler in this directory uses — see
 * cost-report.ts's header for why there are two modes rather than one job that branches on the
 * date.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 06:15 UTC every day — after the dunning (04:00), seat-reconciliation (05:00) and storage-quota
 * (06:00) sweeps, so the AI-usage totals it reads reflect a school's post-suspension state, and
 * before the 07:00 report-expiry sweep so the two never contend.
 */
export const COST_REPORT_DAILY_CRON_PATTERN = "15 6 * * *";

/** 07:30 UTC on the 1st of every month — after the daily run above, so the monthly report's own
 *  metric publish is redundant with (not a replacement for) that day's daily run. */
export const COST_REPORT_MONTHLY_CRON_PATTERN = "30 7 1 * *";

const COST_REPORT_DAILY_SCHEDULER_ID = "billing-cost-report-daily";
const COST_REPORT_MONTHLY_SCHEDULER_ID = "billing-cost-report-monthly";

export async function scheduleCostReportJobs(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      COST_REPORT_DAILY_SCHEDULER_ID,
      { pattern: COST_REPORT_DAILY_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_COST_REPORT, data: { mode: "daily" } },
    );
    await queue.upsertJobScheduler(
      COST_REPORT_MONTHLY_SCHEDULER_ID,
      { pattern: COST_REPORT_MONTHLY_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_COST_REPORT, data: { mode: "monthly" } },
    );
  } finally {
    await queue.close();
  }
}
