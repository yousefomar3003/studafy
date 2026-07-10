// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createConnectionTracker, gracefulShutdown } from "./lifecycle";

describe("createConnectionTracker", () => {
  test("tracks size as clients are added and removed", () => {
    const tracker = createConnectionTracker();
    const client = { close: () => undefined };
    expect(tracker.size()).toBe(0);
    tracker.add(client);
    expect(tracker.size()).toBe(1);
    tracker.remove(client);
    expect(tracker.size()).toBe(0);
  });

  test("closeAll closes every tracked client with the given code and reason", () => {
    const tracker = createConnectionTracker();
    const closed: { code?: number; reason?: string }[] = [];
    tracker.add({ close: (code, reason) => closed.push({ code, reason }) });
    tracker.add({ close: (code, reason) => closed.push({ code, reason }) });

    tracker.closeAll(1001, "shutting down");

    expect(closed).toEqual([
      { code: 1001, reason: "shutting down" },
      { code: 1001, reason: "shutting down" },
    ]);
  });
});

describe("gracefulShutdown", () => {
  test("marks not-ready, unsubscribes, then closes every connection", async () => {
    const events: string[] = [];
    const tracker = createConnectionTracker();
    tracker.add({ close: () => events.push("closed") });

    await gracefulShutdown({
      onStart: () => events.push("start"),
      unsubscribe: async () => {
        events.push("unsubscribed");
      },
      tracker,
    });

    expect(events).toEqual(["start", "unsubscribed", "closed"]);
  });
});
