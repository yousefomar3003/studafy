/**
 * The one place a data subject request job is added to the maintenance queue: job name by request
 * type, `jobId` = the request row id (so a duplicate add is a BullMQ no-op), and the retry/retention
 * options the worker (apps/workers/src/queues/maintenance/dsr-processor.ts) is written against.
 *
 * Shared by the privacy routes (which enqueue after their transaction commits) and self-service
 * account deletion (which enqueues as the last step inside its transaction), so the two can never
 * disagree about how a DSR job is shaped.
 */

import { JOB_NAMES } from "@studafy/constants";

import type { DsrRequestType } from "./service";
import type { Queue } from "bullmq";

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export async function addDsrJob(
  maintenanceQueue: Queue,
  request: { id: string; requestType: DsrRequestType },
  schoolId: string,
): Promise<void> {
  const jobName =
    request.requestType === "export"
      ? JOB_NAMES.RUN_DATA_SUBJECT_EXPORT
      : JOB_NAMES.RUN_DATA_SUBJECT_ERASURE;
  await maintenanceQueue.add(
    jobName,
    { requestId: request.id, schoolId },
    {
      jobId: request.id,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: THIRTY_DAYS_SECONDS },
      removeOnFail: { age: THIRTY_DAYS_SECONDS },
    },
  );
}
