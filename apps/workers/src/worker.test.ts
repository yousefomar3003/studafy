import { UnrecoverableError } from "bullmq";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, mock, test } from "bun:test";

import { runMonitoredJob, shutdownWorkers, startWorkers } from "./worker";

import type { QueueDefinition } from "./registry";
import type { StoppableWorker } from "./worker";
import type { Job } from "bullmq";

function fakeDefinition(name: string): QueueDefinition {
  return {
    name: name as QueueDefinition["name"],
    concurrency: 1,
    processor: async () => undefined,
  };
}

describe("startWorkers", () => {
  test("creates one worker per registry entry via the injected factory", () => {
    const registry = [fakeDefinition("a"), fakeDefinition("b")];
    const connection = { host: "localhost" };
    const created: unknown[] = [];

    const workers = startWorkers(registry, connection, (definition, conn) => {
      created.push([definition, conn]);
      return { close: async () => undefined };
    });

    expect(workers).toHaveLength(2);
    expect(created).toEqual([
      [registry[0], connection],
      [registry[1], connection],
    ]);
  });
});

describe("shutdownWorkers", () => {
  test("waits for every worker to close before resolving", async () => {
    const closed = [false, false];
    const workers: StoppableWorker[] = [
      { close: async () => void (closed[0] = true) },
      { close: async () => void (closed[1] = true) },
    ];

    await shutdownWorkers(workers, 1000);

    expect(closed).toEqual([true, true]);
  });

  test("force-closes a worker still open past the timeout", async () => {
    const forceClosed: boolean[] = [];
    let resolveGracefulClose = (): void => undefined;
    const gracefulClose = new Promise<void>((resolve) => {
      resolveGracefulClose = resolve;
    });

    const worker: StoppableWorker = {
      close: (force) => {
        if (force) {
          forceClosed.push(true);
          resolveGracefulClose();
        }
        return gracefulClose;
      },
    };

    await shutdownWorkers([worker], 5);

    expect(forceClosed).toEqual([true]);
  });
});

describe("runMonitoredJob", () => {
  const failingDefinition = (error: unknown): QueueDefinition => ({
    name: "billing" as QueueDefinition["name"],
    concurrency: 1,
    processor: async () => {
      throw error;
    },
  });

  const fakeJob = (attemptsMade: number, attempts: number | undefined, data: unknown = {}): Job =>
    ({ id: "job-1", name: "dunning", attemptsMade, opts: { attempts }, data }) as unknown as Job;

  test("returns the processor's result and reports nothing on success", async () => {
    const reportError = mock();
    const definition: QueueDefinition = { ...fakeDefinition("billing"), processor: async () => 7 };

    expect(await runMonitoredJob(definition, fakeJob(0, 3), reportError)).toBe(7);
    expect(reportError).not.toHaveBeenCalled();
  });

  test("does not report an attempt BullMQ will retry, and still rethrows it", async () => {
    const reportError = mock();
    const error = new Error("smtp timeout");

    await expect(
      runMonitoredJob(failingDefinition(error), fakeJob(0, 3), reportError),
    ).rejects.toBe(error);
    expect(reportError).not.toHaveBeenCalled();
  });

  test("reports the final attempt with queue, job and tenant ids", async () => {
    const reportError = mock();
    const error = new Error("smtp timeout");

    await expect(
      runMonitoredJob(
        failingDefinition(error),
        fakeJob(2, 3, { schoolId: "school-1", email: "a@b.com" }),
        reportError,
      ),
    ).rejects.toBe(error);
    expect(reportError).toHaveBeenCalledWith(error, {
      tags: { queue: "billing", job_id: "job-1", job_name: "dunning", school_id: "school-1" },
      extra: { attempt: 3, max_attempts: 3 },
    });
  });

  test("reports a job with no retries configured on its only attempt", async () => {
    const reportError = mock();

    await expect(
      runMonitoredJob(failingDefinition(new Error("x")), fakeJob(0, undefined), reportError),
    ).rejects.toThrow("x");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  test("reports an UnrecoverableError immediately, whatever attempts remain", async () => {
    const reportError = mock();

    await expect(
      runMonitoredJob(
        failingDefinition(new UnrecoverableError("bad payload")),
        fakeJob(0, 5),
        reportError,
      ),
    ).rejects.toThrow("bad payload");
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
