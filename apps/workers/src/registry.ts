import { JOB_NAMES, QUEUE_NAMES } from "@studafy/constants";
import { Queue } from "bullmq";

import { createRedisConnection } from "./connection";
import { databaseUrlFrom, loadEnv, readDatabaseUrlFrom } from "./env";
import { workerLogger } from "./log";
import { enqueueAiIngestion } from "./queues/ai-ingestion/enqueue";
import { createTenantSemaphore } from "./queues/ai-ingestion/semaphore";
import { processIngestJob } from "./queues/ai-ingestion/worker";
import { billingDeadLetterListener, processBillingJob } from "./queues/billing";
import { createDerivationS3, processMaterialDerivation } from "./queues/derivations";
import { processStudentImport } from "./queues/imports/worker";
import { processAttendanceAlert } from "./queues/notifications/attendance-alert.worker";
import { processBulkInvite } from "./queues/notifications/bulk-invite-processor";
import { deadLetterListener } from "./queues/notifications/dead-letter";
import { processNotificationDelivery } from "./queues/notifications/delivery.worker";
import {
  DELIVERY_JOB_OPTIONS,
  processNotificationDispatch,
} from "./queues/notifications/dispatcher.worker";
import { processDigest, processNotificationDigest } from "./queues/notifications/email";
import { createFcmSender } from "./queues/notifications/push";
import { processReportJob } from "./queues/reports";
import { createScanS3, materialScanFailedListener, processMaterialScan } from "./queues/scan";

import type { AiIngestionJobData } from "./queues/ai-ingestion/job";
import type { TenantSemaphore } from "./queues/ai-ingestion/semaphore";
import type { AttendanceAlertJobData } from "./queues/notifications/attendance-alert.worker";
import type { FailedHandler } from "./queues/notifications/dead-letter";
import type {
  DeliverNotificationJobData,
  DispatchNotificationJobData,
} from "./queues/notifications/dispatcher.worker";
import type { PushSender } from "./queues/notifications/push";
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
 * The derivations queue, produced by the scan worker on every clean verdict. Lazily created for
 * the same reason `deliveryQueue` is — registry.test.ts imports this module, and constructing a
 * BullMQ `Queue` opens a Redis connection that a pure unit test has no need for.
 */
let derivationQueue: Queue | null = null;

function enqueueDerivation(data: { schoolId: string; materialId: string }): Promise<void> {
  derivationQueue ??= new Queue(QUEUE_NAMES.DERIVATIONS, {
    connection: createRedisConnection(workerEnv) as never,
  });

  return derivationQueue.add(JOB_NAMES.DERIVE_MATERIAL_PREVIEWS, data).then(() => undefined);
}

/**
 * The ai-ingestion producer handle, used by the scan worker to hand a clean AI-visible material to
 * the ingestion queue. Created lazily rather than at module scope for the same reason
 * `deliveryQueue` is: registry.test.ts imports this module, and constructing a BullMQ `Queue`
 * opens a Redis connection.
 */
let aiIngestionQueueInstance: Queue | null = null;

function enqueueIngestion(schoolId: string, materialId: string): Promise<void> {
  aiIngestionQueueInstance ??= new Queue(QUEUE_NAMES.AI_INGESTION, {
    connection: createRedisConnection(workerEnv) as never,
  });
  return enqueueAiIngestion(aiIngestionQueueInstance, schoolId, materialId);
}

/**
 * The per-tenant ingestion gate (ST-161): at most `INGESTION_MAX_CONCURRENCY_PER_SCHOOL` ingestion
 * jobs in flight per school across the whole fleet. Built once on first use rather than at module
 * scope — registry.test.ts imports this module, and constructing the semaphore would open a Redis
 * connection (lazyConnect or not, the client object itself is per-connection).
 */
let ingestionSemaphoreInstance: TenantSemaphore | null = null;

function ingestionSemaphore(): TenantSemaphore {
  ingestionSemaphoreInstance ??= createTenantSemaphore({
    redis: createRedisConnection(workerEnv),
    maxConcurrencyPerSchool: workerEnv.INGESTION_MAX_CONCURRENCY_PER_SCHOOL,
  });
  return ingestionSemaphoreInstance;
}

/**
 * The push sender, built once on first use rather than at module scope.
 *
 * Lazy for the same reason `deliveryQueue` is: registry.test.ts imports this module, and in the
 * common case (no FIREBASE_SERVICE_ACCOUNT) construction is harmless, but when one is configured
 * it parses and validates the service account and initialises the Firebase app — work that belongs
 * on the first push job, not in a test import.
 */
let pushSenderInstance: PushSender | null = null;

function pushSender(): PushSender {
  pushSenderInstance ??= createFcmSender(workerEnv, workerLogger);
  return pushSenderInstance;
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
    // Ingests a material: claim the row, extract + chunk its text, store app.material_chunks. The
    // `missing job data` guard keeps the registry unit test (and any stray producer) from opening a
    // database connection for an empty payload.
    processor: async (job: Job) => {
      const data = job.data as Partial<AiIngestionJobData>;
      if (!data.materialId || !data.schoolId) {
        return { processed: false, reason: "missing job data" };
      }
      return processIngestJob(job, {
        databaseUrl,
        databaseCaCert: workerEnv.DATABASE_CA_CERT,
        s3Region: workerEnv.S3_REGION,
        s3Endpoint: workerEnv.S3_ENDPOINT,
        bucket: workerEnv.S3_APP_FILES_BUCKET,
        ocrLowConfidenceThreshold: workerEnv.OCR_LOW_CONFIDENCE_THRESHOLD,
        ocrWorkerPath: workerEnv.OCR_WORKER_PATH,
        ocrLangPath: workerEnv.OCR_LANG_PATH,
        semaphore: ingestionSemaphore(),
        enqueueDerivation,
      });
    },
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

      if (job.name === JOB_NAMES.DISPATCH_NOTIFICATION) {
        const data = job.data as Partial<DispatchNotificationJobData>;
        if (data.schoolId && data.eventId && data.eventType && data.submissionId) {
          return processNotificationDispatch(data as DispatchNotificationJobData, {
            databaseUrl,
            enqueueDelivery,
            jobId: job.id ?? null,
          });
        }
        return { processed: false, reason: "missing job data" };
      }

      if (job.name === JOB_NAMES.DELIVER_NOTIFICATION) {
        const data = job.data as Partial<DeliverNotificationJobData>;
        if (data.schoolId && data.dispatchLogId && data.recipientId && data.channel) {
          return processNotificationDelivery(data as DeliverNotificationJobData, {
            databaseUrl,
            log: workerLogger,
            push: pushSender(),
          });
        }
        return { processed: false, reason: "missing job data" };
      }

      if (job.name === JOB_NAMES.SEND_DIGESTS) {
        return processDigest(databaseUrl);
      }

      if (job.name === JOB_NAMES.SEND_NOTIFICATION_DIGESTS) {
        return processNotificationDigest(databaseUrl);
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
    // The report type registry dispatches every job this queue carries: the scheduled purge sweep
    // (PURGE_EXPIRED_REPORTS) plus each registered report type. Unknown job names resolve without
    // touching the database or S3, which is what keeps the registry unit test (and any stray
    // producer) side-effect-free.
    processor: (job: Job) =>
      processReportJob(job, {
        primaryDatabaseUrl: databaseUrl,
        readDatabaseUrl,
        s3Region: workerEnv.S3_REGION,
        s3Endpoint: workerEnv.S3_ENDPOINT,
        bucket: workerEnv.S3_APP_FILES_BUCKET,
        databaseCaCert: workerEnv.DATABASE_CA_CERT,
        erpnextBaseUrl: workerEnv.ERPNEXT_API_URL,
        erpnextApiKey: workerEnv.ERPNEXT_API_KEY,
      }),
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
    name: QUEUE_NAMES.SCAN,
    concurrency: 2,
    // One job per confirmed material. Concurrency 2: each scan holds a clamd connection and streams
    // the object once, and the clean-file availability budget is dominated by scan latency — two in
    // flight keeps that low without oversubscribing a Fargate-sized container's clamd pool.
    processor: (job: Job) =>
      processMaterialScan(job, {
        databaseUrl,
        databaseCaCert: workerEnv.DATABASE_CA_CERT,
        s3: workerEnv.S3_REGION
          ? createScanS3({ region: workerEnv.S3_REGION, endpoint: workerEnv.S3_ENDPOINT })
          : null,
        bucket: workerEnv.S3_APP_FILES_BUCKET,
        clamd: {
          host: workerEnv.CLAMAV_HOST ?? "",
          port: workerEnv.CLAMAV_PORT,
          timeoutMs: workerEnv.CLAMAV_TIMEOUT_MS,
          maxFileBytes: workerEnv.CLAMAV_MAX_FILE_BYTES,
        },
        enqueueDerivation,
        enqueueIngestion,
      }),
    // Terminal failures fail closed: the material is marked failed (never available) and the
    // uploader is alerted. See scan-material.worker.ts.
    onFailed: materialScanFailedListener(databaseUrl, workerLogger),
  },
  {
    name: QUEUE_NAMES.DERIVATIONS,
    concurrency: 2,
    // One job per clean material, enqueued by the scan worker. Rasterizes the object into a
    // thumbnail (and first-page preview for PDFs) without ever modifying the original; unsupported
    // or unreadable content degrades to a NULL-key skip, never a failed material. Concurrency 2
    // mirrors the scan queue: each job holds the whole source in memory while rasterizing, so two
    // in flight keeps peak memory modest without making thumbnails trail availability.
    processor: (job: Job) =>
      processMaterialDerivation(job, {
        databaseUrl,
        databaseCaCert: workerEnv.DATABASE_CA_CERT,
        s3: workerEnv.S3_REGION
          ? createDerivationS3({ region: workerEnv.S3_REGION, endpoint: workerEnv.S3_ENDPOINT })
          : null,
        bucket: workerEnv.S3_APP_FILES_BUCKET,
      }),
  },
  {
    name: QUEUE_NAMES.BILLING,
    concurrency: 1,
    processor: async (job) =>
      processBillingJob(job, databaseUrl, {
        s3Region: workerEnv.S3_REGION,
        s3Endpoint: workerEnv.S3_ENDPOINT,
        bucket: workerEnv.S3_APP_FILES_BUCKET,
      }),
    // Terminal failures of `process-billing-event` park the app.billing_events row itself (ST-132).
    // The row already holds the verbatim provider payload, the reason and the attempt count, so it
    // is the dead-letter record — a separate table would be a second copy of data this one has in
    // full. ERPNext invoice jobs share this queue and are ignored by the listener.
    onFailed: billingDeadLetterListener(databaseUrl, workerLogger),
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
