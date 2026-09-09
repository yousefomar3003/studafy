/**
 * Tenant-closure sweep scheduler (ST-268). Registers the daily closure sweep as a BullMQ Job
 * Scheduler, the same idempotent-upsert pattern report-expiry-scheduler.ts uses.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/**
 * 08:30 UTC every day -- after the dunning sweep (04:00) and seat reconciliation (05:00), so a
 * subscription that reached `closed` overnight has already settled before this sweep looks for it.
 */
export const CLOSURE_SWEEP_CRON_PATTERN = "30 8 * * *";

const CLOSURE_SWEEP_SCHEDULER_ID = "maintenance-tenant-closure-sweep-daily";

export async function scheduleClosureSweepJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      CLOSURE_SWEEP_SCHEDULER_ID,
      { pattern: CLOSURE_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_TENANT_CLOSURE_SWEEP },
    );
  } finally {
    await queue.close();
  }
}
