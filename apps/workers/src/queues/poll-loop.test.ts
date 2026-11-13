// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { IdleBackoff, startPollLoop } from "./poll-loop";

describe("IdleBackoff", () => {
  test("doubles from the floor to the ceiling while idle", () => {
    const backoff = new IdleBackoff({ minIdleMs: 500, maxIdleMs: 5_000 });
    const delays = Array.from({ length: 7 }, () => backoff.nextDelay());
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  test("finding work resets to the floor", () => {
    const backoff = new IdleBackoff({ minIdleMs: 500, maxIdleMs: 5_000 });
    backoff.nextDelay();
    backoff.nextDelay();
    backoff.nextDelay();
    backoff.reset();
    expect(backoff.nextDelay()).toBe(500);
  });

  test("a ceiling below the floor means a fixed interval", () => {
    const backoff = new IdleBackoff({ minIdleMs: 1_000, maxIdleMs: 200 });
    expect([backoff.nextDelay(), backoff.nextDelay()]).toEqual([1_000, 1_000]);
  });
});

/**
 * Drives the loop with a scripted sequence of cycle results and records each wait. The loop stops
 * itself once the script runs out, so `done` resolves deterministically.
 */
async function runScript(results: (number | Error)[], minIdleMs = 100, maxIdleMs = 1_000) {
  const waits: number[] = [];
  const errors: unknown[] = [];
  let index = 0;
  const handle = startPollLoop({
    minIdleMs,
    maxIdleMs,
    cycle: async () => {
      const result = results[index++];
      if (index >= results.length) handle.stop();
      if (result instanceof Error) throw result;
      return result ?? 0;
    },
    onError: (err) => errors.push(err),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  await handle.done;
  return { waits, errors, cycles: index };
}

describe("startPollLoop", () => {
  test("backs off across consecutive idle cycles", async () => {
    const { waits } = await runScript([0, 0, 0, 0, 0, 0]);
    expect(waits).toEqual([100, 200, 400, 800, 1_000]);
  });

  test("goes straight round after a cycle that found work, then starts again from the floor", async () => {
    const { waits } = await runScript([0, 0, 0, 3, 7, 0, 0, 0]);
    // No wait after the two busy cycles, and the idle spell after them restarts at 100 ms.
    expect(waits).toEqual([100, 200, 400, 100, 200]);
  });

  test("a failing cycle is reported and backs off like an idle one", async () => {
    const boom = new Error("db down");
    const { waits, errors } = await runScript([boom, boom, boom, 0]);
    expect(errors).toEqual([boom, boom, boom]);
    expect(waits).toEqual([100, 200, 400]);
  });

  test("stop() ends an in-progress idle wait at once", async () => {
    let cycles = 0;
    const handle = startPollLoop({
      minIdleMs: 60_000,
      maxIdleMs: 60_000,
      cycle: async () => {
        cycles += 1;
        return 0;
      },
      onError: () => undefined,
    });
    // Let the first cycle run and the 60 s wait begin.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = Date.now();
    handle.stop();
    await handle.done;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cycles).toBe(1);
  });
});
