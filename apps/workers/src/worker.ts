import { recordJobOutcome } from "@studafy/observability";
import { Worker } from "bullmq";

import type { QueueDefinition } from "./registry";
import type { ConnectionOptions, Job } from "bullmq";

/** Minimal surface of a BullMQ Worker needed for shutdown — satisfied by the real `Worker` class. */
export interface StoppableWorker {
  close(force?: boolean): Promise<void>;
}

export type WorkerFactory = (
  definition: QueueDefinition,
  connection: ConnectionOptions,
) => StoppableWorker;

/**
 * Builds the real BullMQ `Worker` for a queue definition, with its own per-queue concurrency.
 *
 * The `failed`/`completed` listeners are attached here rather than in `startWorkers` deliberately.
 * Doing it there would mean widening `StoppableWorker` with `on(...)`, which every fake in
 * worker.test.ts (`{ close: async () => undefined }`) would then fail to satisfy. This function is
 * already the one place that needs a live Redis and is already not unit-tested, so the seam costs
 * nothing — and the listener's own logic lives in a plain function that tests call directly.
 */
export const createBullmqWorker: WorkerFactory = (definition, connection) => {
  const worker = new Worker(definition.name, definition.processor, {
    connection,
    concurrency: definition.concurrency,
  });

  if (definition.onFailed) {
    worker.on("failed", definition.onFailed);
  }

  // Queue metrics (ST-259): every job that reaches a terminal state reports its outcome, whatever
  // queue it belongs to — one shared listener pair here covers the whole registry rather than
  // requiring each queue definition to remember to instrument itself. `job` is `undefined` for a
  // `failed` event BullMQ could not even attach to a job (see BullMQ's own Worker typings); there
  // is nothing to attribute that case to, so it is skipped rather than recorded under a wrong or
  // synthetic queue name.
  const recordOutcome = (job: Job | undefined, outcome: "completed" | "failed") => {
    if (!job) return;
    recordJobOutcome(job.queueName, outcome, job.processedOn, job.finishedOn);
  };
  worker.on("completed", (job) => recordOutcome(job, "completed"));
  worker.on("failed", (job) => recordOutcome(job, "failed"));

  return worker;
};

/** Starts one worker per registry entry. `createWorker` is injectable so tests can avoid Redis. */
export function startWorkers(
  registry: QueueDefinition[],
  connection: ConnectionOptions,
  createWorker: WorkerFactory = createBullmqWorker,
): StoppableWorker[] {
  return registry.map((definition) => createWorker(definition, connection));
}

/**
 * Graceful shutdown: `Worker.close()` stops pulling new jobs and waits for jobs already active to
 * finish before resolving — that is what satisfies "SIGTERM waits for active jobs". The wait is
 * bounded by `timeoutMs`: any worker still open past the deadline is force-closed so shutdown
 * can't hang forever on a stuck job.
 */
export async function shutdownWorkers(
  workers: StoppableWorker[],
  timeoutMs: number,
): Promise<void> {
  const timer = setTimeout(() => {
    for (const worker of workers) {
      void worker.close(true);
    }
  }, timeoutMs);

  try {
    await Promise.all(workers.map((worker) => worker.close()));
  } finally {
    clearTimeout(timer);
  }
}
