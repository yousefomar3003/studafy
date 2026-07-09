// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { shutdownWorkers, startWorkers } from "./worker";

import type { QueueDefinition } from "./registry";
import type { StoppableWorker } from "./worker";

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
