// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { permissionsForRoles } from "../../lib/auth/permissions";

import { visiblePortalNavItems } from "./nav-items";

/** Item ids, in render order — the "snapshot" this ticket's acceptance criteria calls for. */
const idsFor = (roles: readonly string[]) =>
  visiblePortalNavItems(permissionsForRoles(roles)).map((item) => item.id);

describe("visiblePortalNavItems", () => {
  test.each<[string, string[]]>([
    ["SUPER_ADMIN", ["home", "admin", "approvals", "account"]],
    ["ORG_ADMIN", ["home", "admin", "approvals", "account"]],
    ["FINANCE", ["home", "account"]],
    ["INSTRUCTOR", ["home", "account"]],
    ["TEACHING_ASSISTANT", ["home", "account"]],
    ["STUDENT", ["home", "account"]],
    ["PARENT", ["home", "account"]],
    ["GUEST", ["home", "account"]],
    ["SUPPORT_AGENT", ["home", "account"]],
  ])("renders exactly %s's menu", (role, expected) => {
    expect(idsFor([role])).toEqual(expected);
  });

  test("a session with no roles still sees the unconditional items", () => {
    expect(idsFor([])).toEqual(["home", "account"]);
  });

  test("a multi-role session sees the union", () => {
    expect(idsFor(["STUDENT", "ORG_ADMIN"])).toEqual(["home", "admin", "approvals", "account"]);
  });
});
