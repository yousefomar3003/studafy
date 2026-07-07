// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createInflightTracker, gracefulShutdown } from "./lifecycle";

describe("createInflightTracker", () => {
  test("counts begin and end", () => {
    const tracker = createInflightTracker();
    expect(tracker.inFlight()).toBe(0);
    tracker.begin();
    tracker.begin();
    expect(tracker.inFlight()).toBe(2);
    tracker.end();
    expect(tracker.inFlight()).toBe(1);
  });

  test("onDrained resolves immediately when nothing is in flight", async () => {
    await expect(createInflightTracker().onDrained()).resolves.toBeUndefined();
  });

  test("onDrained resolves once the last request ends", async () => {
    const tracker = createInflightTracker();
    tracker.begin();

    let drained = false;
    const pending = tracker.onDrained().then(() => {
      drained = true;
    });
    expect(drained).toBe(false);

    tracker.end();
    await pending;
    expect(drained).toBe(true);
  });

  test("onDrained resolves on timeout even if requests remain in flight", async () => {
    const tracker = createInflightTracker();
    tracker.begin();
    await expect(tracker.onDrained(1)).resolves.toBeUndefined();
    expect(tracker.inFlight()).toBe(1);
  });
});

describe("gracefulShutdown", () => {
  test("marks not-ready and stops the server before draining", async () => {
    const tracker = createInflightTracker();
    tracker.begin();

    const events: string[] = [];
    const server = {
      stop() {
        events.push("stopped");
      },
    };

    const shutdown = gracefulShutdown(server, {
      onStart: () => events.push("start"),
      tracker,
      timeoutMs: 1000,
    });

    // onStart and stop run synchronously, before draining begins.
    expect(events).toEqual(["start", "stopped"]);

    tracker.end();
    await shutdown;
    expect(tracker.inFlight()).toBe(0);
  });
});
