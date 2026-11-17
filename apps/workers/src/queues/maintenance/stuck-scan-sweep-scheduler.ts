/**
 * Upload-scan sweep scheduler (QA-055). Registers the 15-minute re-enqueue of uploads stuck in
 * `scanning` or left `unscanned` as a BullMQ Job Scheduler, the same idempotent-upsert pattern the
 * other maintenance schedulers use.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { STUCK_SCAN_SWEEP_CRON_PATTERN } from "../scan/stuck-scan-sweep";

import type { ConnectionOptions } from "bullmq";

const STUCK_SCAN_SWEEP_SCHEDULER_ID = "maintenance-stuck-upload-scans";

export async function scheduleStuckUploadScanSweepJob(
  connection: ConnectionOptions,
): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      STUCK_SCAN_SWEEP_SCHEDULER_ID,
      { pattern: STUCK_SCAN_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.SWEEP_STUCK_UPLOAD_SCANS },
    );
  } finally {
    await queue.close();
  }
}
