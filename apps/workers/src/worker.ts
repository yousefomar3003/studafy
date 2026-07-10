import { Worker } from "bullmq";

import type { QueueDefinition } from "./registry";
import type { ConnectionOptions } from "bullmq";

/** Minimal surface of a BullMQ Worker needed for shutdown — satisfied by the real `Worker` class. */
export interface StoppableWorker {
  close(force?: boolean): Promise<void>;
}

export type WorkerFactory = (
  definition: QueueDefinition,
  connection: ConnectionOptions,
) => StoppableWorker;

/** Builds the real BullMQ `Worker` for a queue definition, with its own per-queue concurrency. */
export const createBullmqWorker: WorkerFactory = (definition, connection) =>
  new Worker(definition.name, definition.processor, {
    connection,
    concurrency: definition.concurrency,
  });

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
