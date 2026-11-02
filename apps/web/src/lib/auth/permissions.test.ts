import { PERMISSIONS } from "@studafy/constants";
// eslint-disable-next-line import-x/no-unresolved -- "bun:test" is a virtual Bun built-in with no resolvable file path
import { describe, expect, test } from "bun:test";

import { permissionsForRoles } from "./permissions";

describe("permissionsForRoles", () => {
  test("returns the empty set for no roles", () => {
    expect(permissionsForRoles([])).toEqual(new Set());
  });

  test("ignores unrecognized role strings instead of throwing", () => {
    expect(permissionsForRoles(["SOME_FUTURE_ROLE"])).toEqual(new Set());
  });

  test("a STUDENT holds notification:read but not approval:review", () => {
    const permissions = permissionsForRoles(["STUDENT"]);
    expect(permissions.has(PERMISSIONS.NOTIFICATION_READ)).toBe(true);
    expect(permissions.has(PERMISSIONS.APPROVAL_REVIEW)).toBe(false);
  });

  test("a PARENT holds neither notification:read nor approval:review", () => {
    const permissions = permissionsForRoles(["PARENT"]);
    expect(permissions.has(PERMISSIONS.NOTIFICATION_READ)).toBe(false);
    expect(permissions.has(PERMISSIONS.APPROVAL_REVIEW)).toBe(false);
  });

  test("an ORG_ADMIN holds approval:review", () => {
    expect(permissionsForRoles(["ORG_ADMIN"]).has(PERMISSIONS.APPROVAL_REVIEW)).toBe(true);
  });

  test("a SUPER_ADMIN holds every defined permission", () => {
    const permissions = permissionsForRoles(["SUPER_ADMIN"]);
    for (const permission of Object.values(PERMISSIONS)) {
      expect(permissions.has(permission)).toBe(true);
    }
  });

  test("unions permissions across multiple roles on one session", () => {
    const permissions = permissionsForRoles(["PARENT", "STUDENT"]);
    expect(permissions.has(PERMISSIONS.NOTIFICATION_READ)).toBe(true);
    expect(permissions.has(PERMISSIONS.DISCIPLINE_INCIDENT_READ)).toBe(true);
  });
});
