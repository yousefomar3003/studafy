// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { computeBackoffDelay } from "./backoff";

const BASE_OPTIONS = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.2,
  random: () => 0.5, // mid-range: jitter factor 0
};

describe("computeBackoffDelay", () => {
  test("grows exponentially without jitter", () => {
    expect(computeBackoffDelay(0, BASE_OPTIONS)).toBe(1_000);
    expect(computeBackoffDelay(1, BASE_OPTIONS)).toBe(2_000);
    expect(computeBackoffDelay(2, BASE_OPTIONS)).toBe(4_000);
    expect(computeBackoffDelay(3, BASE_OPTIONS)).toBe(8_000);
  });

  test("never exceeds the configured ceiling", () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(computeBackoffDelay(attempt, BASE_OPTIONS)).toBeLessThanOrEqual(30_000);
    }
    expect(computeBackoffDelay(10, BASE_OPTIONS)).toBe(30_000);
  });

  test("jitter stays within the configured ratio", () => {
    const options = { ...BASE_OPTIONS, random: () => 0 };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const delay = computeBackoffDelay(attempt, options);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
  });

  test("is never negative for any random draw", () => {
    const options = { ...BASE_OPTIONS, random: () => 1 };
    expect(computeBackoffDelay(0, options)).toBeGreaterThanOrEqual(0);
    expect(computeBackoffDelay(5, options)).toBeGreaterThanOrEqual(0);
  });

  test("ignores negative attempts", () => {
    expect(computeBackoffDelay(-1, BASE_OPTIONS)).toBe(1_000);
  });
});
