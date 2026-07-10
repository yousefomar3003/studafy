import { EventEmitter } from "node:events";

// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { subscribeToRooms } from "./subscriber";

import type { EventEnvelope } from "./protocol";
import type IORedis from "ioredis";

/** Minimal fake standing in for the subset of ioredis's pub/sub API subscribeToRooms uses. */
function fakeRedis() {
  const emitter = new EventEmitter();
  const psubscribed: string[] = [];
  const punsubscribed: string[] = [];
  return {
    redis: Object.assign(emitter, {
      psubscribe: async (pattern: string) => {
        psubscribed.push(pattern);
      },
      punsubscribe: async (pattern: string) => {
        punsubscribed.push(pattern);
      },
    }) as unknown as IORedis,
    psubscribed,
    punsubscribed,
    emitPmessage: (channel: string, message: string) => {
      emitter.emit("pmessage", "school:*:role:*", channel, message);
    },
  };
}

const validEnvelope: EventEnvelope = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  type: "announcement.posted",
  room: "school:1:role:STUDENT",
  payload: { text: "hello" },
  publishedAt: "2026-07-09T12:00:00.000Z",
};

describe("subscribeToRooms", () => {
  test("subscribes to the room channel pattern immediately", () => {
    const { redis, psubscribed } = fakeRedis();
    subscribeToRooms(redis, () => undefined);
    expect(psubscribed).toEqual(["school:*:role:*"]);
  });

  test("forwards a valid envelope whose room matches the channel", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToRooms(redis, (envelope) => received.push(envelope));

    emitPmessage("school:1:role:STUDENT", JSON.stringify(validEnvelope));

    expect(received).toEqual([validEnvelope]);
  });

  test("drops a message that is not valid JSON", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToRooms(redis, (envelope) => received.push(envelope));

    emitPmessage("school:1:role:STUDENT", "not json");

    expect(received).toEqual([]);
  });

  test("drops a message that fails envelope validation", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToRooms(redis, (envelope) => received.push(envelope));

    emitPmessage("school:1:role:STUDENT", JSON.stringify({ not: "an envelope" }));

    expect(received).toEqual([]);
  });

  test("drops a message whose envelope.room does not match the publishing channel", () => {
    const { redis, emitPmessage } = fakeRedis();
    const received: EventEnvelope[] = [];
    subscribeToRooms(redis, (envelope) => received.push(envelope));

    emitPmessage("school:2:role:STUDENT", JSON.stringify(validEnvelope));

    expect(received).toEqual([]);
  });

  test("teardown removes the listener and unsubscribes", async () => {
    const { redis, emitPmessage, punsubscribed } = fakeRedis();
    const received: EventEnvelope[] = [];
    const teardown = subscribeToRooms(redis, (envelope) => received.push(envelope));

    await teardown();
    emitPmessage("school:1:role:STUDENT", JSON.stringify(validEnvelope));

    expect(received).toEqual([]);
    expect(punsubscribed).toEqual(["school:*:role:*"]);
  });
});
