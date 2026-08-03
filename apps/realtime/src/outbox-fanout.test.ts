import { EventEmitter } from "node:events";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { beforeEach, describe, expect, test } from "bun:test";

import { resetMetrics, snapshot } from "./metrics";
import { subscribeToOutboxEvents } from "./outbox-fanout";

import type { EventEnvelope } from "./protocol";
import type IORedis from "ioredis";

/** Minimal fake standing in for the subset of ioredis's pub/sub API subscribeToOutboxEvents uses. */
function fakeRedis() {
  const emitter = new EventEmitter();
  const psubscribed: string[] = [];
  const punsubscribed: string[] = [];
  return {
    redis: Object.assign(emitter, {
      psubscribe: async (...patterns: string[]) => {
        psubscribed.push(...patterns);
      },
      punsubscribe: async (...patterns: string[]) => {
        punsubscribed.push(...patterns);
      },
    }) as unknown as IORedis,
    psubscribed,
    punsubscribed,
    emitPmessage: (pattern: string, channel: string, message: string) => {
      emitter.emit("pmessage", pattern, channel, message);
    },
  };
}

const GRADES_PUBLISHED_PATTERN = "events:*:grades.published";

beforeEach(() => {
  resetMetrics();
});

describe("subscribeToOutboxEvents", () => {
  test("subscribes to one pattern per routed event name", () => {
    const { redis, psubscribed } = fakeRedis();
    subscribeToOutboxEvents(redis, () => undefined);
    expect(psubscribed).toEqual([GRADES_PUBLISHED_PATTERN]);
  });

  test("fans a routed event out to every target room with a fresh envelope per room", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToOutboxEvents(redis, (envelope) => received.push(envelope));

    const payload = {
      submissionId: "sub-1",
      gradebookId: "gb-1",
      studentId: "student-1",
      approvedByUserId: "teacher-1",
    };
    emitPmessage(
      GRADES_PUBLISHED_PATTERN,
      "events:school-1:grades.published",
      JSON.stringify(payload),
    );

    expect(received).toHaveLength(2);
    expect(received.map((e) => e.room)).toEqual([
      "school:school-1:role:STUDENT",
      "school:school-1:role:PARENT",
    ]);
    for (const envelope of received) {
      expect(envelope.type).toBe("grades.published");
      expect(envelope.payload).toEqual(payload);
      expect(envelope.id).not.toBe("");
    }
    expect(received[0]!.id).not.toBe(received[1]!.id);
    expect(snapshot()).toEqual({ received: 1, roomDeliveries: 2, dropped: 0 });
  });

  test("ignores a pmessage for a pattern it did not subscribe to", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToOutboxEvents(redis, (envelope) => received.push(envelope));

    emitPmessage("school:*:role:*", "school:school-1:role:STUDENT", JSON.stringify({}));

    expect(received).toEqual([]);
    expect(snapshot()).toEqual({ received: 0, roomDeliveries: 0, dropped: 0 });
  });

  test("drops a message that is not valid JSON", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToOutboxEvents(redis, (envelope) => received.push(envelope));

    emitPmessage(GRADES_PUBLISHED_PATTERN, "events:school-1:grades.published", "not json");

    expect(received).toEqual([]);
    expect(snapshot().dropped).toBe(1);
  });

  test("drops a message on a malformed channel", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToOutboxEvents(redis, (envelope) => received.push(envelope));

    emitPmessage(GRADES_PUBLISHED_PATTERN, "events:grades.published", JSON.stringify({}));

    expect(received).toEqual([]);
    expect(snapshot().dropped).toBe(1);
  });

  test("teardown removes the listener and unsubscribes every pattern", async () => {
    const { redis, emitPmessage, punsubscribed } = fakeRedis();
    const received: EventEnvelope[] = [];
    const teardown = subscribeToOutboxEvents(redis, (envelope) => received.push(envelope));

    await teardown();
    emitPmessage(GRADES_PUBLISHED_PATTERN, "events:school-1:grades.published", JSON.stringify({}));

    expect(received).toEqual([]);
    expect(punsubscribed).toEqual([GRADES_PUBLISHED_PATTERN]);
  });
});
