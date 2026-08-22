// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { permissionsForRoles } from "../../lib/auth/permissions";

import { visiblePortalNavItems } from "./nav-items";

/** Item ids, in render order — the "snapshot" this ticket's acceptance criteria calls for. */
const idsFor = (roles: readonly string[]) =>
  visiblePortalNavItems(permissionsForRoles(roles)).map((item) => item.id);

describe("visiblePortalNavItems", () => {
  test.each<[string, string[]]>([
    [
      "SUPER_ADMIN",
      ["home", "notifications", "admin", "principal", "billing", "finance", "approvals", "account"],
    ],
    [
      "ORG_ADMIN",
      ["home", "notifications", "admin", "principal", "billing", "finance", "approvals", "account"],
    ],
    ["FINANCE", ["home", "notifications", "finance", "account"]],
    ["INSTRUCTOR", ["home", "notifications", "account"]],
    ["TEACHING_ASSISTANT", ["home", "notifications", "account"]],
    ["STUDENT", ["home", "notifications", "account"]],
    ["PARENT", ["home", "notifications", "account"]],
    ["GUEST", ["home", "notifications", "account"]],
    ["SUPPORT_AGENT", ["home", "notifications", "account"]],
  ])("renders exactly %s's menu", (role, expected) => {
    expect(idsFor([role])).toEqual(expected);
  });

  test("a session with no roles still sees the unconditional items", () => {
    expect(idsFor([])).toEqual(["home", "notifications", "account"]);
  });

  test("a multi-role session sees the union", () => {
    expect(idsFor(["STUDENT", "ORG_ADMIN"])).toEqual([
      "home",
      "notifications",
      "admin",
      "principal",
      "billing",
      "finance",
      "approvals",
      "account",
    ]);
  });
});
