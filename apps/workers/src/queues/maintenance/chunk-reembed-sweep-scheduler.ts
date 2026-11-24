/**
 * Chunk re-embed scheduler (ADR-021). Registers the sweep as a BullMQ Job Scheduler, the same
 * idempotent-upsert pattern the other maintenance sweeps use. A run with nothing to re-embed is one
 * short query per school.
 */

import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import type { ConnectionOptions } from "bullmq";

/** Every 30 minutes, offset from the quarter-hour upload-scan sweep. */
export const CHUNK_REEMBED_SWEEP_CRON_PATTERN = "20,50 * * * *";

const CHUNK_REEMBED_SWEEP_SCHEDULER_ID = "maintenance-chunk-reembed";

export async function scheduleChunkReembedSweepJob(connection: ConnectionOptions): Promise<void> {
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection });
  try {
    await queue.upsertJobScheduler(
      CHUNK_REEMBED_SWEEP_SCHEDULER_ID,
      { pattern: CHUNK_REEMBED_SWEEP_CRON_PATTERN, tz: "UTC" },
      { name: JOB_NAMES.REEMBED_STALE_CHUNKS },
    );
  } finally {
    await queue.close();
  }
}
