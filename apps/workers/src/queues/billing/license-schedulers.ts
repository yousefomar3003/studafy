/**
 * School license job schedulers (session 3 of docs/billing/feature-licensing.md). BullMQ Job
 * Schedulers on the billing queue, upserted idempotently at every worker boot like the dunning
 * scheduler.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** Hourly at :05: licenses expire within the hour of their end date, invoices go overdue. */
export const LICENSE_LIFECYCLE_CRON_PATTERN = "5 * * * *";
/** Hourly at :20, after the lifecycle run has marked what is overdue or expired. */
export const LICENSE_REMINDERS_CRON_PATTERN = "20 * * * *";
/** Hourly at :35: Student AI opt-in notices (and, in one hour a day, leadership's summary). */
export const AI_OPTIN_NOTICES_CRON_PATTERN = "35 * * * *";
/** Mondays at 06:00 UTC: the Student AI weekly statements for the week that just ended. */
export const AI_REVENUE_SHARE_STATEMENTS_CRON_PATTERN = "0 6 * * 1";
/** 00:05 UTC on the 1st of each month. */
export const USAGE_PERIOD_START_CRON_PATTERN = "5 0 1 * *";

export async function scheduleLicenseJobs(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      "billing-license-lifecycle-hourly",
      { pattern: LICENSE_LIFECYCLE_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_LICENSE_LIFECYCLE },
    );
    await queue.upsertJobScheduler(
      "billing-license-reminders-hourly",
      { pattern: LICENSE_REMINDERS_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_LICENSE_REMINDERS },
    );
    await queue.upsertJobScheduler(
      "billing-ai-optin-notices-hourly",
      { pattern: AI_OPTIN_NOTICES_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_AI_OPTIN_NOTICES },
    );
    await queue.upsertJobScheduler(
      "billing-ai-revenue-share-statements-weekly",
      { pattern: AI_REVENUE_SHARE_STATEMENTS_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_AI_REVENUE_SHARE_STATEMENTS },
    );
    await queue.upsertJobScheduler(
      "billing-usage-period-start-monthly",
      { pattern: USAGE_PERIOD_START_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_USAGE_PERIOD_START },
    );
  } finally {
    await queue.close();
  }
}
