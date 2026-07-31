import { DEAD_LETTER_QUEUE_NAMES, QUEUE_NAMES } from "@studafy/constants";
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

  // The inverse of the bijection above, and the reason DEAD_LETTER_QUEUE_NAMES is a separate
  // constant rather than more QUEUE_NAMES entries (ST-139). A dead-letter queue is a parking lot:
  // the moment this process runs a Worker against one, it stops being a parking lot and becomes a
  // sixth retry. Keeping the names apart makes that a compile error at the QueueDefinition type;
  // this asserts it at runtime too, in case someone widens the type.
  test("no dead-letter queue has a worker", () => {
    const registeredNames = new Set<string>(QUEUE_REGISTRY.map((definition) => definition.name));

    for (const name of Object.values(DEAD_LETTER_QUEUE_NAMES)) {
      expect(registeredNames.has(name)).toBe(false);
    }
  });

  test("the notifications queue dead-letters its terminal failures", () => {
    // It is the only queue whose jobs a person is waiting on, and the only one wired to
    // app.notification_dead_letters.
    const notifications = QUEUE_REGISTRY.find(
      (definition) => definition.name === QUEUE_NAMES.NOTIFICATIONS,
    );
    expect(notifications?.onFailed).toBeDefined();
  });
});
