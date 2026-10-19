// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { permissionsForRoles } from "../../lib/auth/permissions";

import { PORTAL_NAV_ITEMS, visiblePortalNavItems, withRoleHome } from "./nav-items";

/** Item ids, in render order — the "snapshot" this ticket's acceptance criteria calls for. */
const idsFor = (roles: readonly string[]) =>
  visiblePortalNavItems(permissionsForRoles(roles)).map((item) => item.id);

describe("visiblePortalNavItems", () => {
  test.each<[string, string[]]>([
    ["SUPER_ADMIN", ["home", "notifications", "platform", "account"]],
    [
      "ORG_ADMIN",
      [
        "home",
        "notifications",
        "admin",
        "staff",
        "members",
        "principal",
        "attendance",
        "billing",
        "finance",
        "approvals",
        "account",
      ],
    ],
    ["PRINCIPAL", ["home", "notifications", "principal", "attendance", "approvals", "account"]],
    ["ATTENDANCE_OFFICER", ["home", "notifications", "attendance", "account"]],
    ["FINANCE", ["home", "notifications", "finance", "account"]],
    ["INSTRUCTOR", ["home", "notifications", "attendance", "account"]],
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
      "staff",
      "members",
      "principal",
      "attendance",
      "billing",
      "finance",
      "approvals",
      "account",
    ]);
  });
});

describe("withRoleHome", () => {
  test("points Home at the role's home and drops the item that duplicated it", () => {
    const items = withRoleHome(PORTAL_NAV_ITEMS, "/portal/admin");
    expect(items.find((item) => item.id === "home")?.to).toBe("/portal/admin");
    expect(items.some((item) => item.id === "admin")).toBe(false);
    expect(items).toHaveLength(PORTAL_NAV_ITEMS.length - 1);
  });

  test("leaves the menu unchanged for a session whose home is the portal", () => {
    expect(withRoleHome(PORTAL_NAV_ITEMS, "/portal")).toBe(PORTAL_NAV_ITEMS);
  });
});
