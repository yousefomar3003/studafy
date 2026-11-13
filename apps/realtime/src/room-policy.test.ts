// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import {
  authorizeRoom,
  NOT_AUTHORIZED_REASON,
  OUTSIDE_SCHOOL_REASON,
  ROOM_POLICIES,
  UNKNOWN_KIND_REASON,
} from "./room-policy";
import { roleRoomKey, schoolRoomKey, userRoomKey } from "./rooms";

import type { AuthClaims } from "./auth";

const user = {
  userId: "user-u",
  schoolId: "school-s",
  roles: ["STUDENT"],
} as unknown as AuthClaims;

describe("room policy table (F-04)", () => {
  test("has exactly one row per room kind the protocol defines", () => {
    expect(Object.keys(ROOM_POLICIES).sort()).toEqual(["role", "school", "user"]);
  });

  describe("school room", () => {
    test("allows the caller's own school", () => {
      expect(authorizeRoom(schoolRoomKey("school-s"), user)).toEqual({ allowed: true });
    });

    test("denies another school", () => {
      expect(authorizeRoom(schoolRoomKey("school-t"), user)).toEqual({
        allowed: false,
        reason: OUTSIDE_SCHOOL_REASON,
      });
    });
  });

  describe("role room", () => {
    test("allows the caller's own role", () => {
      expect(authorizeRoom(roleRoomKey("school-s", "STUDENT"), user)).toEqual({ allowed: true });
    });

    test.each(["INSTRUCTOR", "ORG_ADMIN", "SUPER_ADMIN", "PARENT"] as const)(
      "denies a role the caller does not hold (%s)",
      (role) => {
        expect(authorizeRoom(roleRoomKey("school-s", role), user)).toEqual({
          allowed: false,
          reason: NOT_AUTHORIZED_REASON,
        });
      },
    );

    test("allows each role a multi-role caller holds, and no other", () => {
      const teacherParent: AuthClaims = { ...user, roles: ["INSTRUCTOR", "PARENT"] };
      expect(authorizeRoom(roleRoomKey("school-s", "INSTRUCTOR"), teacherParent).allowed).toBe(
        true,
      );
      expect(authorizeRoom(roleRoomKey("school-s", "PARENT"), teacherParent).allowed).toBe(true);
      expect(authorizeRoom(roleRoomKey("school-s", "STUDENT"), teacherParent).allowed).toBe(false);
    });

    test("denies the caller's own role in another school", () => {
      expect(authorizeRoom(roleRoomKey("school-t", "STUDENT"), user)).toEqual({
        allowed: false,
        reason: OUTSIDE_SCHOOL_REASON,
      });
    });
  });

  describe("user room", () => {
    test("allows the caller's own user room", () => {
      expect(authorizeRoom(userRoomKey("school-s", "user-u"), user)).toEqual({ allowed: true });
    });

    test("denies another user's room in the same school", () => {
      expect(authorizeRoom(userRoomKey("school-s", "user-v"), user)).toEqual({
        allowed: false,
        reason: NOT_AUTHORIZED_REASON,
      });
    });

    test("denies the caller's own user id in another school", () => {
      expect(authorizeRoom(userRoomKey("school-t", "user-u"), user)).toEqual({
        allowed: false,
        reason: OUTSIDE_SCHOOL_REASON,
      });
    });
  });

  describe("unknown kinds", () => {
    test.each([
      "school:school-s:class:class-1",
      "school:school-s:role:NOT_A_ROLE",
      "school:school-s:user:user-u:extra",
      "tenant:school-s",
      "school:",
      "",
    ])("denies %p", (room) => {
      expect(authorizeRoom(room, user)).toEqual({ allowed: false, reason: UNKNOWN_KIND_REASON });
    });
  });
});
