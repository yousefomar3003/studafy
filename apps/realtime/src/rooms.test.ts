// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { createRoomManager, parseRoomKey, roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";

describe("schoolRoomKey", () => {
  test("formats school:{schoolId}", () => {
    expect(schoolRoomKey("school-1")).toBe("school:school-1");
  });
});

describe("roleRoomKey", () => {
  test("formats school:{schoolId}:role:{role}", () => {
    expect(roleRoomKey("school-1", "STUDENT")).toBe("school:school-1:role:STUDENT");
  });
});

describe("userRoomKey", () => {
  test("formats school:{schoolId}:user:{userId}", () => {
    expect(userRoomKey("school-1", "user-1")).toBe("school:school-1:user:user-1");
  });
});

describe("parseRoomKey", () => {
  test("recovers schoolId from a bare school room key", () => {
    expect(parseRoomKey("school:school-1")).toEqual({ kind: "school", schoolId: "school-1" });
  });

  test("recovers schoolId and role from a role room key", () => {
    expect(parseRoomKey("school:school-1:role:STUDENT")).toEqual({
      kind: "role",
      schoolId: "school-1",
      role: "STUDENT",
    });
  });

  test("recovers schoolId and userId from a user room key", () => {
    expect(parseRoomKey("school:school-1:user:user-1")).toEqual({
      kind: "user",
      schoolId: "school-1",
      userId: "user-1",
    });
  });

  test("throws for a malformed key", () => {
    expect(() => parseRoomKey("not-a-room-key")).toThrow();
  });
});

describe("createRoomManager", () => {
  test("join adds a client to a room's members", () => {
    const rooms = createRoomManager<string>();
    rooms.join("room-a", "client-1");
    expect(rooms.members("room-a")).toEqual(new Set(["client-1"]));
  });

  test("members is empty for a room nobody has joined", () => {
    const rooms = createRoomManager<string>();
    expect(rooms.members("room-a")).toEqual(new Set());
  });

  test("a client can join multiple rooms", () => {
    const rooms = createRoomManager<string>();
    rooms.join("room-a", "client-1");
    rooms.join("room-b", "client-1");
    expect(rooms.roomsOf("client-1")).toEqual(new Set(["room-a", "room-b"]));
  });

  test("a room can have multiple members", () => {
    const rooms = createRoomManager<string>();
    rooms.join("room-a", "client-1");
    rooms.join("room-a", "client-2");
    expect(rooms.members("room-a")).toEqual(new Set(["client-1", "client-2"]));
  });

  test("leave removes only the specified room membership", () => {
    const rooms = createRoomManager<string>();
    rooms.join("room-a", "client-1");
    rooms.join("room-b", "client-1");
    rooms.leave("room-a", "client-1");
    expect(rooms.members("room-a")).toEqual(new Set());
    expect(rooms.members("room-b")).toEqual(new Set(["client-1"]));
  });

  test("leaveAll removes a client from every room it joined", () => {
    const rooms = createRoomManager<string>();
    rooms.join("room-a", "client-1");
    rooms.join("room-b", "client-1");
    rooms.join("room-a", "client-2");
    rooms.leaveAll("client-1");
    expect(rooms.members("room-a")).toEqual(new Set(["client-2"]));
    expect(rooms.members("room-b")).toEqual(new Set());
    expect(rooms.roomsOf("client-1")).toEqual(new Set());
  });

  test("leaveAll on a client with no rooms is a no-op", () => {
    const rooms = createRoomManager<string>();
    expect(() => rooms.leaveAll("ghost")).not.toThrow();
  });
});
