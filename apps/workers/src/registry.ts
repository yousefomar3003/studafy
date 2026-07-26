import { QUEUE_NAMES } from "@studafy/constants";

import { processStudentImport } from "./queues/imports/worker";
import { processBulkInvite } from "./queues/notifications/bulk-invite-processor";

import type { QueueName } from "@studafy/constants";
import type { Job } from "bullmq";

export type Processor = (job: Job) => Promise<unknown>;

export interface QueueDefinition {
  name: QueueName;
  /** Number of jobs this process runs concurrently for this queue. */
  concurrency: number;
  processor: Processor;
}

// The import processor needs the database URL. It is read from the environment
// at registry construction time so it can be injected into the queue definition.
const databaseUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/studafy";

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
    processor: async (job: Job) => {
      const data = job.data as { bulkInviteId?: string; schoolId?: string };
      if (data.bulkInviteId && data.schoolId) {
        return processBulkInvite(data as { bulkInviteId: string; schoolId: string }, databaseUrl);
      }
      return { processed: true };
    },
  },
  {
    name: QUEUE_NAMES.REPORTS,
    concurrency: 3,
    processor: placeholderProcessor(QUEUE_NAMES.REPORTS),
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
