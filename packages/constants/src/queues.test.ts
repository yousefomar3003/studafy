// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { QUEUE_NAMES } from "./queues";

describe("QUEUE_NAMES", () => {
  test("every queue name is unique", () => {
    const values = Object.values(QUEUE_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every queue name is kebab-case", () => {
    const segmentPattern = /^[a-z]+$/;

    for (const value of Object.values(QUEUE_NAMES)) {
      for (const segment of value.split("-")) {
        expect(segment).toMatch(segmentPattern);
      }
    }
  });
});
