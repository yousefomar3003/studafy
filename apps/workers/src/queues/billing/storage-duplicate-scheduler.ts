/**
 * Duplicate storage subscription resolver scheduler (db/migrations/000219). A BullMQ Job Scheduler
 * on the billing queue, upserted idempotently at every worker boot like the other billing sweeps.
 *
 * Every 10 minutes: a school charged for a second storage subscription gets the older one canceled
 * and refunded within minutes, and a run with nothing to do costs one indexed query per
 * Stripe-billed school.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

export const STORAGE_DUPLICATE_RESOLVER_CRON_PATTERN = "*/10 * * * *";

const STORAGE_DUPLICATE_RESOLVER_SCHEDULER_ID = "billing-storage-duplicate-resolver";

export async function scheduleStorageDuplicateResolverJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.BILLING, { connection });
  try {
    await queue.upsertJobScheduler(
      STORAGE_DUPLICATE_RESOLVER_SCHEDULER_ID,
      { pattern: STORAGE_DUPLICATE_RESOLVER_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.RUN_STORAGE_DUPLICATE_RESOLVER },
    );
  } finally {
    await queue.close();
  }
}
