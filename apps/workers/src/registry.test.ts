import { QUEUE_NAMES } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { QUEUE_REGISTRY } from "./registry";

import type { Job } from "bullmq";

describe("QUEUE_REGISTRY", () => {
  test("has exactly one entry per queue in QUEUE_NAMES", () => {
    const registeredNames = QUEUE_REGISTRY.map((definition) => definition.name);
    expect(new Set(registeredNames)).toEqual(new Set(Object.values(QUEUE_NAMES)));
    expect(registeredNames.length).toBe(Object.values(QUEUE_NAMES).length);
  });

  test("every queue has a positive integer concurrency", () => {
    for (const definition of QUEUE_REGISTRY) {
      expect(Number.isInteger(definition.concurrency)).toBe(true);
      expect(definition.concurrency).toBeGreaterThan(0);
    }
  });

  test("every processor resolves for a job-shaped input", async () => {
    for (const definition of QUEUE_REGISTRY) {
      const job = { id: "1", name: "test", data: {} } as unknown as Job;
      await expect(definition.processor(job)).resolves.toBeDefined();
    }
  });
});
