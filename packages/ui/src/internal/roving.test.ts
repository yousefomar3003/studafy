// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { firstEnabledIndex, lastEnabledIndex, nextEnabledIndex } from "./roving";

const enabled = [{}, {}, {}];
const withDisabled = [{}, { disabled: true }, {}];
const allDisabled = [{ disabled: true }, { disabled: true }];

describe("nextEnabledIndex", () => {
  test("steps forward", () => {
    expect(nextEnabledIndex(enabled, 0, 1)).toBe(1);
  });

  test("steps backward", () => {
    expect(nextEnabledIndex(enabled, 1, -1)).toBe(0);
  });

  test("wraps forward past the end", () => {
    expect(nextEnabledIndex(enabled, 2, 1)).toBe(0);
  });

  test("wraps backward past the start", () => {
    expect(nextEnabledIndex(enabled, 0, -1)).toBe(2);
  });

  test("skips disabled items", () => {
    expect(nextEnabledIndex(withDisabled, 0, 1)).toBe(2);
    expect(nextEnabledIndex(withDisabled, 2, -1)).toBe(0);
  });

  test("returns the origin when nothing is enabled", () => {
    expect(nextEnabledIndex(allDisabled, 1, 1)).toBe(1);
  });

  test("returns the origin for an empty list", () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(0);
  });
});

describe("firstEnabledIndex / lastEnabledIndex", () => {
  test("find the outermost enabled items", () => {
    const items = [{ disabled: true }, {}, {}, { disabled: true }];
    expect(firstEnabledIndex(items)).toBe(1);
    expect(lastEnabledIndex(items)).toBe(2);
  });

  test("fall back to 0 when nothing is enabled", () => {
    expect(firstEnabledIndex(allDisabled)).toBe(0);
    expect(lastEnabledIndex(allDisabled)).toBe(0);
  });
});
