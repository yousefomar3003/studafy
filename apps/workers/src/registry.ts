import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";

import { databaseUrlFrom, loadEnv, readDatabaseUrlFrom } from "./env";
import { processStudentImport } from "./queues/imports/worker";
import { processAttendanceAlert } from "./queues/notifications/attendance-alert.worker";
import { processBulkInvite } from "./queues/notifications/bulk-invite-processor";
import { processAttendanceExport } from "./queues/reports";

import type { AttendanceAlertJobData } from "./queues/notifications/attendance-alert.worker";
import type { QueueName } from "@studafy/constants";
import type { Job } from "bullmq";

export type Processor = (job: Job) => Promise<unknown>;

export interface QueueDefinition {
  name: QueueName;
  /** Number of jobs this process runs concurrently for this queue. */
  concurrency: number;
  processor: Processor;
}

// The DB-backed processors need a connection string, resolved once at registry construction and
// injected into each queue definition. Read through loadEnv() rather than process.env directly, so
// production's discrete DATABASE_HOST/USER/PASSWORD are honoured — reading DATABASE_URL raw would
// silently fall back to its localhost default in every deployed environment.
const workerEnv = loadEnv();
const databaseUrl = databaseUrlFrom(workerEnv);
const readDatabaseUrl = readDatabaseUrlFrom(workerEnv);

/**
 * Placeholder processor for a queue that has no domain logic yet. It exists so the worker
 * bootstrap has something real to run end-to-end (see `scripts/smoke-test.ts`); dedicated
 * tickets for each queue replace this with the actual handler.
 */
function placeholderProcessor(name: QueueName): Processor {
  return async (job: Job) => {
    console.log(`[${name}] processed job ${job.id} (${job.name})`);
    return { processed: true };
  };
}

/**
 * One entry per queue in `QUEUE_NAMES` — see `docs/queue-catalog.md` for what each queue is for
 * and why it has the concurrency it does. The workers bootstrap (`src/worker.ts`) starts exactly
 * one BullMQ `Worker` per entry.
 */
export const QUEUE_REGISTRY: QueueDefinition[] = [
  {
    name: QUEUE_NAMES.AI_INGESTION,
    concurrency: 2,
    processor: placeholderProcessor(QUEUE_NAMES.AI_INGESTION),
  },
  {
    name: QUEUE_NAMES.NOTIFICATIONS,
    concurrency: 10,
    // One Worker per queue name, so every notification job type is dispatched from here. A second
    // Worker on this name would compete for the same jobs rather than add a stream.
    //
    // New job types discriminate on job.name, which is what BullMQ gives producers to say what a
    // job is. The bulk-invite branch below still discriminates on payload shape because that is
    // how it was written and its producer names jobs "process-bulk-invite" without relying on it.
    processor: async (job: Job) => {
      if (job.name === JOB_NAMES.EVALUATE_ATTENDANCE_ALERTS) {
        const data = job.data as Partial<AttendanceAlertJobData>;
        if (data.schoolId && data.sessionDate && Array.isArray(data.studentIds)) {
          return processAttendanceAlert(
            data as AttendanceAlertJobData,
            databaseUrl,
            job.id ?? null,
          );
        }
        return { processed: false, reason: "missing job data" };
      }

      const data = job.data as { bulkInviteId?: string; schoolId?: string };
      if (data.bulkInviteId && data.schoolId) {
        return processBulkInvite(data as { bulkInviteId: string; schoolId: string }, databaseUrl);
      }
      // registry.test.ts calls every processor with `{ data: {} }` and requires a defined result,
      // so this fallback is load-bearing rather than defensive.
      return { processed: true };
    },
  },
  {
    name: QUEUE_NAMES.REPORTS,
    concurrency: 3,
    processor: async (job: Job) => {
      if (job.name !== JOB_NAMES.GENERATE_ATTENDANCE_EXPORT) {
        return { processed: false, reason: "unknown report job" };
      }
      return processAttendanceExport(job, {
        primaryDatabaseUrl: databaseUrl,
        readDatabaseUrl,
        s3Region: workerEnv.S3_REGION,
        s3Endpoint: workerEnv.S3_ENDPOINT,
        bucket: workerEnv.S3_APP_FILES_BUCKET,
        databaseCaCert: workerEnv.DATABASE_CA_CERT,
      });
    },
  },
  {
    name: QUEUE_NAMES.IMPORTS,
    concurrency: 2,
    processor: async (job: Job) => {
      const data = job.data as { importId?: string; schoolId?: string };
      if (!data.importId || !data.schoolId) {
        return { processed: false, reason: "missing job data" };
      }
      return processStudentImport(data as { importId: string; schoolId: string }, databaseUrl);
    },
  },
  {
    name: QUEUE_NAMES.BILLING,
    concurrency: 1,
    processor: placeholderProcessor(QUEUE_NAMES.BILLING),
  },
  {
    name: QUEUE_NAMES.OUTBOX_RELAY,
    concurrency: 5,
    processor: placeholderProcessor(QUEUE_NAMES.OUTBOX_RELAY),
  },
  {
    name: QUEUE_NAMES.PROVISIONING,
    concurrency: 2,
    processor: placeholderProcessor(QUEUE_NAMES.PROVISIONING),
  },
];
