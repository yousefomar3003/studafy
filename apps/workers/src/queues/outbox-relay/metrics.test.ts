// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test, beforeEach } from "bun:test";

import { incrementFailed, incrementPublished, recordLag, resetMetrics, snapshot } from "./metrics";

beforeEach(() => {
  resetMetrics();
});

describe("outbox relay metrics", () => {
  test("starts at zero", () => {
    const s = snapshot();
    expect(s.published).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.avgLagMs).toBe(0);
  });

  test("incrementPublished adds to the counter", () => {
    incrementPublished(5);
    incrementPublished(3);
    expect(snapshot().published).toBe(8);
  });

  test("incrementFailed adds one per call", () => {
    incrementFailed();
    incrementFailed();
    expect(snapshot().failed).toBe(2);
  });

  test("avgLagMs computes running average", () => {
    recordLag(100);
    recordLag(200);
    expect(snapshot().avgLagMs).toBe(150);
  });

  test("resetMetrics clears everything", () => {
    incrementPublished(10);
    incrementFailed();
    recordLag(50);
    resetMetrics();
    const s = snapshot();
    expect(s.published).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.avgLagMs).toBe(0);
  });
});
