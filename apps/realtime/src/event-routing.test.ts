// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EVENT_ROUTES, ROUTED_EVENT_NAMES, routesFor } from "./event-routing";

describe("routesFor", () => {
  // QA-031: grades.published used to go to every STUDENT and PARENT socket in the school, so any
  // of them saw which minors were graded, when, and by whom. It now reaches only the people the
  // event names: the student's own account and their linked guardians.
  test("grades.published reaches only the recipients the event names", () => {
    const route = routesFor("grades.published");
    expect(route?.("school-1", { recipientUserIds: ["u-student", "u-parent"] })).toEqual([
      "school:school-1:user:u-student",
      "school:school-1:user:u-parent",
    ]);
  });

  test("grades.published is never broadcast to a role room", () => {
    const route = routesFor("grades.published");
    for (const payload of [{}, { studentId: "s-1" }, { recipientUserIds: [] }, null]) {
      const rooms = route?.("school-1", payload) ?? [];
      expect(rooms.some((room) => room.includes(":role:"))).toBe(false);
    }
    expect(route?.("school-1", { studentId: "s-1" })).toEqual([]);
  });

  test("userEntitlement.changed routes only to the affected user's own room", () => {
    const route = routesFor("userEntitlement.changed");
    expect(
      route?.("school-1", { schoolId: "school-1", userId: "user-9", entitlementsVersion: 3 }),
    ).toEqual(["school:school-1:user:user-9"]);
    // No user id, no delivery -- never a broadcast.
    expect(route?.("school-1", { schoolId: "school-1" })).toEqual([]);
    expect(route?.("school-1", null)).toEqual([]);
  });

  test("returns undefined for an event with no route", () => {
    expect(routesFor("course.published")).toBeUndefined();
  });
});

describe("ROUTED_EVENT_NAMES", () => {
  test("lists exactly the keys of EVENT_ROUTES", () => {
    expect(Object.keys(EVENT_ROUTES)).toEqual(ROUTED_EVENT_NAMES);
  });
});
