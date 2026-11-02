// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  eventEnvelopeSchema,
  parseIncomingMessage,
  parseRoomKeyParts,
  REAUTH_REQUIRED_CLOSE_CODE,
  roomKeySchema,
  systemMessageSchema,
} from "./protocol";

const ENVELOPE = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  type: "grades.published",
  room: "school:123:role:STUDENT",
  payload: { submissionId: "s-1", studentId: "u-1" },
  publishedAt: "2026-07-09T12:00:00.000Z",
};

describe("parseRoomKeyParts", () => {
  test("parses all three room kinds", () => {
    expect(parseRoomKeyParts("school:123")).toEqual({ kind: "school", schoolId: "123" });
    expect(parseRoomKeyParts("school:123:role:STUDENT")).toEqual({
      kind: "role",
      schoolId: "123",
      role: "STUDENT",
    });
    expect(parseRoomKeyParts("school:123:user:u-1")).toEqual({
      kind: "user",
      schoolId: "123",
      userId: "u-1",
    });
  });

  test("rejects malformed and cross-kind keys", () => {
    for (const value of [
      "",
      "school:",
      "tenant:123",
      "school:123:role:",
      "school:123:user:",
      "school:123:group:g-1",
      "school:123:role:STUDENT:extra",
    ]) {
      expect(parseRoomKeyParts(value)).toBeUndefined();
      expect(roomKeySchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("wire schemas", () => {
  test("event envelope validates", () => {
    expect(eventEnvelopeSchema.safeParse(ENVELOPE).success).toBe(true);
  });

  test("system messages validate", () => {
    for (const message of [
      { type: "system.joined", room: "school:123" },
      { type: "system.left", room: "school:123" },
      { type: "system.error", message: "cannot join a room outside your own school" },
      { type: "system.reauth_required", reason: "token expired" },
    ]) {
      expect(systemMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  test("reauth close code is 4401", () => {
    expect(REAUTH_REQUIRED_CLOSE_CODE).toBe(4401);
  });
});

describe("parseIncomingMessage", () => {
  test("parses an event envelope frame", () => {
    const message = parseIncomingMessage(JSON.stringify(ENVELOPE));
    expect(message).toEqual(ENVELOPE);
  });

  test("parses a system message frame", () => {
    const message = parseIncomingMessage(JSON.stringify({ type: "system.error", message: "nope" }));
    expect(message).toEqual({ type: "system.error", message: "nope" });
  });

  test("drops malformed JSON", () => {
    expect(parseIncomingMessage("not json")).toBeUndefined();
  });

  test("drops well-formed JSON that is not a known message", () => {
    expect(parseIncomingMessage(JSON.stringify({ type: "system.unknown" }))).toBeUndefined();
    expect(parseIncomingMessage(JSON.stringify({ ...ENVELOPE, id: "not-a-uuid" }))).toBeUndefined();
  });
});
