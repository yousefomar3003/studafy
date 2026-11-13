/**
 * The producer side of the ai-ingestion queue (ST-161).
 *
 * Enqueued by the scan worker after a clean verdict and by the API on re-ingest / AI re-enable. The
 * job data matches aiIngestionJobDataSchema in ./job.ts — the worker claims the material by its
 * 'queued' status, so a duplicate enqueue is absorbed as a skip rather than a second ingestion.
 */

import { INGESTION_JOB_OPTIONS, JOB_NAMES } from "@studafy/constants";

import type { AiIngestionJobData } from "./job";
import type { Queue } from "bullmq";

export function enqueueAiIngestion(
  queue: Queue,
  schoolId: string,
  materialId: string,
): Promise<void> {
  const data: AiIngestionJobData = { version: 1, schoolId, materialId };
  return queue.add(JOB_NAMES.INGEST_MATERIAL, data, INGESTION_JOB_OPTIONS).then(() => undefined);
}
