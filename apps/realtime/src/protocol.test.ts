// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { clientMessageSchema, eventEnvelopeSchema, roomKeySchema } from "./protocol";

describe("roomKeySchema", () => {
  test("accepts a well-formed room key with a known role", () => {
    expect(roomKeySchema.safeParse("school:123:role:STUDENT").success).toBe(true);
  });

  test("rejects a room key with an unknown role", () => {
    expect(roomKeySchema.safeParse("school:123:role:WIZARD").success).toBe(false);
  });

  test("rejects a room key missing the role segment", () => {
    expect(roomKeySchema.safeParse("school:123").success).toBe(false);
  });

  test("rejects a role segment that isn't uppercase", () => {
    expect(roomKeySchema.safeParse("school:123:role:student").success).toBe(false);
  });
});

describe("eventEnvelopeSchema", () => {
  test("accepts a well-formed envelope", () => {
    const result = eventEnvelopeSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      type: "announcement.posted",
      room: "school:123:role:STUDENT",
      payload: { text: "hello" },
      publishedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  test("rejects an envelope with a malformed room key", () => {
    const result = eventEnvelopeSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      type: "announcement.posted",
      room: "not-a-room-key",
      payload: {},
      publishedAt: "2026-07-09T12:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  test("accepts a join message", () => {
    const result = clientMessageSchema.safeParse({ type: "join", room: "school:1:role:STUDENT" });
    expect(result.success).toBe(true);
  });

  test("accepts a leave message", () => {
    const result = clientMessageSchema.safeParse({ type: "leave", room: "school:1:role:STUDENT" });
    expect(result.success).toBe(true);
  });

  test("rejects an unknown message type", () => {
    const result = clientMessageSchema.safeParse({ type: "ping" });
    expect(result.success).toBe(false);
  });
});
