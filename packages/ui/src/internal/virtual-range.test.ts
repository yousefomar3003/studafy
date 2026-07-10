// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { computeVirtualRange } from "./virtual-range";

describe("computeVirtualRange", () => {
  test("renders the whole list when it fits inside the viewport plus overscan", () => {
    const range = computeVirtualRange({
      rowCount: 10,
      rowHeight: 40,
      viewportHeight: 400,
      scrollTop: 0,
      overscan: 8,
    });

    expect(range).toEqual({
      startIndex: 0,
      endIndex: 10,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    });
  });

  test("windows a long list around the scroll position", () => {
    const range = computeVirtualRange({
      rowCount: 1000,
      rowHeight: 40,
      viewportHeight: 400,
      scrollTop: 4000,
      overscan: 2,
    });

    // first visible row = 4000 / 40 = 100; viewport fits 10 rows; overscan 2 on each side.
    expect(range.startIndex).toBe(98);
    expect(range.endIndex).toBe(112);
    expect(range.topSpacerHeight).toBe(98 * 40);
    expect(range.bottomSpacerHeight).toBe((1000 - 112) * 40);
  });

  test("clamps the start index at zero near the top", () => {
    const range = computeVirtualRange({
      rowCount: 1000,
      rowHeight: 40,
      viewportHeight: 400,
      scrollTop: 0,
      overscan: 8,
    });

    expect(range.startIndex).toBe(0);
    expect(range.topSpacerHeight).toBe(0);
  });

  test("clamps the end index at the row count near the bottom", () => {
    const range = computeVirtualRange({
      rowCount: 1000,
      rowHeight: 40,
      viewportHeight: 400,
      scrollTop: 40_000,
      overscan: 8,
    });

    expect(range.endIndex).toBe(1000);
    expect(range.bottomSpacerHeight).toBe(0);
  });

  test("returns an empty range for an empty list", () => {
    const range = computeVirtualRange({
      rowCount: 0,
      rowHeight: 40,
      viewportHeight: 400,
      scrollTop: 0,
    });

    expect(range).toEqual({
      startIndex: 0,
      endIndex: 0,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
    });
  });
});
