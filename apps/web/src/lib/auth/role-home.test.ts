// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { resolveRoleHome } from "./role-home";

describe("resolveRoleHome", () => {
  test.each([["ORG_ADMIN"], ["INSTRUCTOR"], ["TEACHING_ASSISTANT"], ["STUDENT"], ["GUEST"]])(
    "routes a %s session to the portal",
    (role) => {
      expect(resolveRoleHome([role])).toBe("/portal");
    },
  );

  test("falls back to the portal for an unrecognized role", () => {
    expect(resolveRoleHome(["SOME_FUTURE_ROLE"])).toBe("/portal");
  });

  test("falls back to the portal for no roles at all", () => {
    expect(resolveRoleHome([])).toBe("/portal");
  });

  test("picks the higher-priority role when a session holds more than one", () => {
    expect(resolveRoleHome(["STUDENT", "ORG_ADMIN"])).toBe("/portal");
    // Same destination today, but exercises the priority search rather than array order.
    expect(resolveRoleHome(["GUEST", "INSTRUCTOR", "STUDENT"])).toBe("/portal");
  });
});
