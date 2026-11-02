// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeEach, describe, expect, test } from "bun:test";

import {
  incrementDevicesSkippedCap,
  incrementNoTokens,
  incrementPruned,
  incrementSent,
  resetMetrics,
  snapshot,
} from "./metrics";

beforeEach(() => {
  resetMetrics();
});

describe("push channel metrics", () => {
  test("starts at zero", () => {
    const s = snapshot();
    expect(s.sent).toBe(0);
    expect(s.pruned).toBe(0);
    expect(s.noTokens).toBe(0);
    expect(s.devicesSkippedCap).toBe(0);
  });

  test("incrementSent adds to the counter", () => {
    incrementSent(2);
    incrementSent(3);
    expect(snapshot().sent).toBe(5);
  });

  test("incrementPruned adds to the counter", () => {
    incrementPruned(3);
    incrementPruned(1);
    expect(snapshot().pruned).toBe(4);
  });

  test("incrementNoTokens adds one per call", () => {
    incrementNoTokens();
    incrementNoTokens();
    expect(snapshot().noTokens).toBe(2);
  });

  test("incrementDevicesSkippedCap adds to the counter", () => {
    incrementDevicesSkippedCap(7);
    incrementDevicesSkippedCap(1);
    expect(snapshot().devicesSkippedCap).toBe(8);
  });

  test("resetMetrics clears everything", () => {
    incrementSent(10);
    incrementPruned(2);
    incrementNoTokens();
    incrementDevicesSkippedCap(5);
    resetMetrics();
    const s = snapshot();
    expect(s.sent).toBe(0);
    expect(s.pruned).toBe(0);
    expect(s.noTokens).toBe(0);
    expect(s.devicesSkippedCap).toBe(0);
  });
});
