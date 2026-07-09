import { QUEUE_NAMES } from "@studafy/constants";

import type { QueueName } from "@studafy/constants";
import type { Job } from "bullmq";

export type Processor = (job: Job) => Promise<unknown>;

export interface QueueDefinition {
  name: QueueName;
  /** Number of jobs this process runs concurrently for this queue. */
  concurrency: number;
  processor: Processor;
}

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
    processor: placeholderProcessor(QUEUE_NAMES.NOTIFICATIONS),
  },
  {
    name: QUEUE_NAMES.REPORTS,
    concurrency: 3,
    processor: placeholderProcessor(QUEUE_NAMES.REPORTS),
  },
  {
    name: QUEUE_NAMES.IMPORTS,
    concurrency: 2,
    processor: placeholderProcessor(QUEUE_NAMES.IMPORTS),
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
];
