// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { resolveRoleHome } from "./role-home";

describe("resolveRoleHome", () => {
  test.each([
    ["SUPER_ADMIN", "/portal/platform"],
    ["ORG_ADMIN", "/portal/admin"],
    ["PRINCIPAL", "/portal/principal"],
    ["FINANCE", "/portal/finance"],
  ])("routes a %s session to its own home", (role, home) => {
    expect(resolveRoleHome([role])).toBe(home);
  });

  test.each([["GUEST"]])("routes a %s session to the portal", (role) => {
    expect(resolveRoleHome([role])).toBe("/portal");
  });

  test("an ORG_ADMIN who also teaches lands on the admin home", () => {
    expect(resolveRoleHome(["INSTRUCTOR", "ORG_ADMIN"])).toBe("/portal/admin");
  });

  test("falls back to the portal for an unrecognized role", () => {
    expect(resolveRoleHome(["SOME_FUTURE_ROLE"])).toBe("/portal");
  });

  test("falls back to the portal for no roles at all", () => {
    expect(resolveRoleHome([])).toBe("/portal");
  });

  test("picks the higher-priority role when a session holds more than one", () => {
    expect(resolveRoleHome(["STUDENT", "ORG_ADMIN"])).toBe("/portal/admin");
    expect(resolveRoleHome(["FINANCE", "SUPER_ADMIN"])).toBe("/portal/platform");
    expect(resolveRoleHome(["FINANCE", "PRINCIPAL"])).toBe("/portal/principal");
  });
});
