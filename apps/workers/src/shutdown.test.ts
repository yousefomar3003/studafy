/**
 * QA-047: a deploy drains in-flight work before anything is closed or killed.
 *
 * Fly's default is SIGINT with a 5 s grace before SIGKILL, under the 10 s SHUTDOWN_TIMEOUT_MS the
 * services wait for, so every deploy killed jobs mid-flight (BullMQ re-runs them: a second email,
 * a second push). And the poll loops' stop() returned nothing, so the database pools were closed
 * under a cycle that was still sending.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { startPollLoop } from "./queues/poll-loop";
import { drainThenClose } from "./worker";

import type { StoppableWorker } from "./worker";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("poll loop stop (QA-047)", () => {
  test("stop() resolves only after the in-flight cycle has finished", async () => {
    const events: string[] = [];
    const loop = startPollLoop({
      minIdleMs: 1,
      maxIdleMs: 1,
      onError: () => undefined,
      cycle: async () => {
        events.push("cycle-start");
        await tick(40);
        events.push("cycle-end");
        return 0;
      },
    });
    await tick(5);
    await loop.stop();
    events.push("stopped");
    expect(events).toEqual(["cycle-start", "cycle-end", "stopped"]);
  });
});

describe("drainThenClose (QA-047)", () => {
  function slowWorker(events: string[], ms: number): StoppableWorker {
    return {
      close: async (force?: boolean) => {
        if (force) return;
        await tick(ms);
        events.push("job-finished");
      },
    } as StoppableWorker;
  }

  test("pools close only after the active job and the poll cycle have finished", async () => {
    const events: string[] = [];
    await drainThenClose({
      loops: [
        {
          stop: async () => {
            await tick(30);
            events.push("cycle-finished");
          },
        },
      ],
      workers: [slowWorker(events, 50)],
      timeoutMs: 1_000,
      close: async () => {
        events.push("pools-closed");
      },
    });
    expect(events).toEqual(["cycle-finished", "job-finished", "pools-closed"]);
  });

  test("a loop that never stops cannot hold shutdown past the deadline", async () => {
    const events: string[] = [];
    const started = Date.now();
    await drainThenClose({
      loops: [{ stop: () => new Promise<void>(() => undefined) }],
      workers: [],
      timeoutMs: 60,
      close: async () => {
        events.push("pools-closed");
      },
    });
    expect(events).toEqual(["pools-closed"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("Fly gives each service time to drain (QA-047)", () => {
  const fly = join(import.meta.dir, "../../../infra/fly");
  const SHUTDOWN_TIMEOUT_DEFAULT_S = 10;

  for (const [file, minimum] of [
    ["api.toml", 30],
    ["realtime.toml", 30],
    ["workers.toml", 60],
  ] as const) {
    test(`${file} sends SIGTERM and waits at least ${minimum}s`, () => {
      const toml = readFileSync(join(fly, file), "utf8");
      expect(toml).toMatch(/^kill_signal\s*=\s*"SIGTERM"/m);
      const timeout = /^kill_timeout\s*=\s*"?(\d+)s?"?/m.exec(toml);
      expect(timeout).not.toBeNull();
      const seconds = Number(timeout![1]);
      expect(seconds).toBeGreaterThanOrEqual(minimum);
      expect(seconds).toBeGreaterThan(SHUTDOWN_TIMEOUT_DEFAULT_S);
      // An explicit SHUTDOWN_TIMEOUT_MS must still leave headroom under the kill.
      const explicit = /SHUTDOWN_TIMEOUT_MS\s*=\s*"?(\d+)"?/.exec(toml);
      if (explicit) expect(Number(explicit[1])).toBeLessThan(seconds * 1000);
    });
  }
});
