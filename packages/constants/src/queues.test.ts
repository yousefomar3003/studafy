// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { DEAD_LETTER_QUEUE_NAMES, JOB_NAMES, QUEUE_NAMES } from "./queues";

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

describe("DEAD_LETTER_QUEUE_NAMES", () => {
  // The separation is the point: apps/workers starts one BullMQ Worker per QUEUE_NAMES entry, so a
  // dead-letter name appearing there would silently acquire a consumer and stop being a parking lot.
  test("no dead-letter name collides with a live queue name", () => {
    const live = new Set<string>(Object.values(QUEUE_NAMES));

    for (const value of Object.values(DEAD_LETTER_QUEUE_NAMES)) {
      expect(live.has(value)).toBe(false);
    }
  });

  test("every dead-letter name is kebab-case", () => {
    const segmentPattern = /^[a-z]+$/;

    for (const value of Object.values(DEAD_LETTER_QUEUE_NAMES)) {
      for (const segment of value.split("-")) {
        expect(segment).toMatch(segmentPattern);
      }
    }
  });
});

describe("JOB_NAMES", () => {
  test("every job name is unique", () => {
    const values = Object.values(JOB_NAMES);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every job name is kebab-case", () => {
    const segmentPattern = /^[a-z]+$/;

    for (const value of Object.values(JOB_NAMES)) {
      for (const segment of value.split("-")) {
        expect(segment).toMatch(segmentPattern);
      }
    }
  });
});
