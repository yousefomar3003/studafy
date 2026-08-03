// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { EVENT_ROUTES, ROUTED_EVENT_NAMES, routesFor } from "./event-routing";

describe("routesFor", () => {
  test("grades.published routes to the student and parent rooms of the event's school", () => {
    const route = routesFor("grades.published");
    expect(route?.("school-1")).toEqual([
      "school:school-1:role:STUDENT",
      "school:school-1:role:PARENT",
    ]);
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
