// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  allInvalidationKeys,
  EVENT_QUERY_INVALIDATIONS,
  invalidationKeysFor,
} from "./invalidations";

describe("EVENT_QUERY_INVALIDATIONS", () => {
  test("maps grades.published to the approval queue and grade queries", () => {
    expect(invalidationKeysFor("grades.published")).toEqual([["approval-queue"], ["grades"]]);
  });

  test("maps userEntitlement.changed to the person's features and the AI add-on offer", () => {
    expect(invalidationKeysFor("userEntitlement.changed")).toEqual([
      ["me", "features"],
      ["ai-offer"],
    ]);
  });

  test("returns an empty list for events with no mapping", () => {
    expect(invalidationKeysFor("no.such.event")).toEqual([]);
  });

  test("every mapped query key is a non-empty prefix", () => {
    for (const keys of EVENT_QUERY_INVALIDATIONS.values()) {
      for (const key of keys) {
        expect(Array.isArray(key)).toBe(true);
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });

  test("allInvalidationKeys flattens every mapped prefix, in map order", () => {
    expect(allInvalidationKeys()).toEqual([
      ["approval-queue"],
      ["grades"],
      ["me", "features"],
      ["ai-offer"],
    ]);
  });
});
