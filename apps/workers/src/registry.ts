import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { createRedisConnection } from "./connection";
import { databaseUrlFrom, loadEnv, readDatabaseUrlFrom } from "./env";
import { workerLogger } from "./log";
import { processBillingJob } from "./queues/billing";
import { processStudentImport } from "./queues/imports/worker";
import { processAttendanceAlert } from "./queues/notifications/attendance-alert.worker";
import { processBulkInvite } from "./queues/notifications/bulk-invite-processor";
import { processDigest } from "./queues/notifications/email";
import { processAttendanceExport, processFinanceExport } from "./queues/reports";

import type { AttendanceAlertJobData } from "./queues/notifications/attendance-alert.worker";
import type { FailedHandler } from "./queues/notifications/dead-letter";
import type {
  DeliverNotificationJobData,
  DispatchNotificationJobData,
} from "./queues/notifications/dispatcher.worker";
import type { QueueName } from "@studafy/constants";
import type { Job } from "bullmq";

export type Processor = (job: Job) => Promise<unknown>;

export interface QueueDefinition {
  name: QueueName;
  /** Number of jobs this process runs concurrently for this queue. */
  concurrency: number;
  processor: Processor;
  /**
   * Terminal-failure hook, attached by `createBullmqWorker`. Optional, so the queues with no
   * dead-letter policy are unchanged.
   *
   * Synchronous by type on purpose: BullMQ emits `failed` on every attempt and does not await its
   * listeners, so a handler that returned a promise would be one nobody holds. It may start async
   * work; it owns its own error handling.
   */
  onFailed?: FailedHandler;
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
 * The queue the dispatcher fans channel deliveries out onto — the `notifications` queue itself,
 * since that is where the delivery processor lives.
 *
 * Created lazily rather than at module scope, and that matters: registry.test.ts imports this
 * module, and constructing a BullMQ `Queue` opens a Redis connection. A module-scope queue would
 * make a pure unit test require a live Redis. Nothing in that test reaches a branch that dispatches,
 * so the connection is never opened there.
 */
let deliveryQueue: Queue | null = null;

function enqueueDelivery(data: DeliverNotificationJobData): Promise<void> {
  deliveryQueue ??= new Queue(QUEUE_NAMES.NOTIFICATIONS, {
    connection: createRedisConnection(workerEnv) as never,
  });

  return deliveryQueue
    .add(JOB_NAMES.DELIVER_NOTIFICATION, data, DELIVERY_JOB_OPTIONS)
    .then(() => undefined);
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

      if (job.name === JOB_NAMES.SEND_DIGESTS) {
        return processDigest(databaseUrl);
      }

      const data = job.data as { bulkInviteId?: string; schoolId?: string };
      if (data.bulkInviteId && data.schoolId) {
        return processBulkInvite(data as { bulkInviteId: string; schoolId: string }, databaseUrl);
      }
      // registry.test.ts calls every processor with `{ data: {} }` and requires a defined result,
      // so this fallback is load-bearing rather than defensive.
      return { processed: true };
    },
    // Terminal failures on this queue are dead-lettered to app.notification_dead_letters and raise
    // `notification.dispatchFailed`. Only this queue carries the hook — it is the only one whose
    // jobs a person is waiting on.
    onFailed: deadLetterListener(databaseUrl, workerLogger),
  },
  {
    name: QUEUE_NAMES.REPORTS,
    concurrency: 3,
    processor: async (job: Job) => {
      if (job.name === JOB_NAMES.GENERATE_FINANCE_REPORT) {
        return processFinanceExport(job, {
          primaryDatabaseUrl: databaseUrl,
          s3Region: workerEnv.S3_REGION,
          s3Endpoint: workerEnv.S3_ENDPOINT,
          bucket: workerEnv.S3_APP_FILES_BUCKET,
          databaseCaCert: workerEnv.DATABASE_CA_CERT,
          erpnextBaseUrl: workerEnv.ERPNEXT_API_URL,
          erpnextApiKey: workerEnv.ERPNEXT_API_KEY,
        });
      }
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
    processor: async (job) => processBillingJob(job, databaseUrl),
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
